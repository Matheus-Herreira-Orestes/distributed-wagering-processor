import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { Money } from '../../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../../src/wallets/application/create-wallet.use-case.js';
import { MikroOrmCreateWalletUnitOfWork } from '../../../src/wallets/infrastructure/persistence/mikro-orm-create-wallet.unit-of-work.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from '../../../src/wagering/application/process-bet-error.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
  type ProcessBetResult,
} from '../../../src/wagering/application/process-bet.use-case.js';
import { MikroOrmProcessBetUnitOfWork } from '../../../src/wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';

interface WalletStateRow {
  balance_amount: string;
  version: number;
}

interface LedgerBalanceRow {
  balance_amount: string;
  reconstructed_balance: string;
}

interface CountRow {
  count: string;
}

describe('ProcessBetUseCase PostgreSQL concurrency', () => {
  let primaryOrm: MikroORM;
  let orms: MikroORM[];
  let createWallet: CreateWalletUseCase;
  let processors: ProcessBetUseCase[];

  beforeAll(async () => {
    orms = await Promise.all([
      MikroORM.init(config),
      MikroORM.init(config),
      MikroORM.init(config),
    ]);
    const first = orms[0];
    if (first === undefined) throw new Error('Primary MikroORM instance was not created.');
    primaryOrm = first;
    await primaryOrm.getMigrator().up();
    createWallet = new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(primaryOrm));
    processors = orms.map(orm => new ProcessBetUseCase(new MikroOrmProcessBetUnitOfWork(orm)));
  });

  afterAll(async () => {
    await Promise.all(orms.map(orm => orm.close(true)));
  });

  test('serializes simultaneous BETs on the same wallet row', async () => {
    const wallet = await openWallet('100.00');
    const first = betInput(wallet.id, wallet.playerId, '80.00');
    const second = betInput(wallet.id, wallet.playerId, '80.00');

    const results = await Promise.all([
      processor(0).execute(first),
      processor(1).execute(second),
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.filter(result => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '20.00', version: 2 });
    expect(await betTransactionCount(wallet.id)).toBe(2);
    expect(await debitLedgerCount(wallet.id)).toBe(1);
    await expectLedgerBalance(wallet.id);
  });

  test('applies one financial effect when the same BET arrives 50 times in parallel', async () => {
    const wallet = await openWallet('100.00');
    const request = betInput(wallet.id, wallet.playerId, '30.00');

    const results = await Promise.all(Array.from(
      { length: 50 },
      (_, index) => processor(index % 3).execute(request),
    ));

    expect(results).toHaveLength(50);
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
    expect(results.every(result => result.status === 'PROCESSED')).toBe(true);
    expect(results.every(result =>
      result.balance.toString() === '70.00' && result.balance.currency === 'BRL')).toBe(true);
    expect(await transactionCountByIdempotency(request.idempotencyKey)).toBe(1);
    expect(await debitLedgerCount(wallet.id)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '70.00', version: 2 });
    await expectLedgerBalance(wallet.id);
  });

  test('stores one operation for concurrent conflicting payloads using the same key', async () => {
    const firstWallet = await openWallet('100.00');
    const secondWallet = await openWallet('100.00');
    const first = betInput(firstWallet.id, firstWallet.playerId, '10.00');
    const second: ProcessBetInput = {
      ...betInput(secondWallet.id, secondWallet.playerId, '20.00'),
      idempotencyKey: first.idempotencyKey,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
    };

    const settled = await Promise.allSettled([
      processor(0).execute(first),
      processor(1).execute(second),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<ProcessBetResult> => result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await transactionCountByIdempotency(first.idempotencyKey)).toBe(1);
    const firstState = await walletState(firstWallet.id);
    const secondState = await walletState(secondWallet.id);
    expect([firstState?.balance_amount, secondState?.balance_amount].sort())
      .toEqual(['100.00', fulfilled[0]?.value.balance.toString()].sort());
    expect(
      await debitLedgerCount(firstWallet.id) + await debitLedgerCount(secondWallet.id),
    ).toBe(1);
    await expectLedgerBalance(firstWallet.id);
    await expectLedgerBalance(secondWallet.id);
  });

  test('processes different wallets independently in parallel', async () => {
    const firstWallet = await openWallet('100.00');
    const secondWallet = await openWallet('100.00');

    const [first, second] = await Promise.all([
      processor(0).execute(betInput(firstWallet.id, firstWallet.playerId, '25.00')),
      processor(1).execute(betInput(secondWallet.id, secondWallet.playerId, '40.00')),
    ]);

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('PROCESSED');
    expect(await walletState(firstWallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    expect(await walletState(secondWallet.id)).toEqual({ balance_amount: '60.00', version: 2 });
    expect(await debitLedgerCount(firstWallet.id)).toBe(1);
    expect(await debitLedgerCount(secondWallet.id)).toBe(1);
    await expectLedgerBalance(firstWallet.id);
    await expectLedgerBalance(secondWallet.id);
  });

  test('rolls back the loser of a provider/external transaction race', async () => {
    const firstWallet = await openWallet('100.00');
    const secondWallet = await openWallet('100.00');
    const sharedExternalId = `external-${crypto.randomUUID()}`;
    const first = {
      ...betInput(firstWallet.id, firstWallet.playerId, '15.00'),
      externalTransactionId: sharedExternalId,
    };
    const second = {
      ...betInput(secondWallet.id, secondWallet.playerId, '25.00'),
      externalTransactionId: sharedExternalId,
    };

    const settled = await Promise.allSettled([
      processor(0).execute(first),
      processor(1).execute(second),
    ]);
    const fulfilled = settled.filter(result => result.status === 'fulfilled');
    const rejected = settled.filter(result => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ExternalTransactionConflictError);
    expect(await providerTransactionCount(first.providerId, sharedExternalId)).toBe(1);
    expect(
      await debitLedgerCount(firstWallet.id) + await debitLedgerCount(secondWallet.id),
    ).toBe(1);
    await expectLedgerBalance(firstWallet.id);
    await expectLedgerBalance(secondWallet.id);
  });

  test('coordinates concurrent work across three independent application instances', async () => {
    const wallet = await openWallet('100.00');
    const requests = [
      betInput(wallet.id, wallet.playerId, '10.00'),
      betInput(wallet.id, wallet.playerId, '10.00'),
      betInput(wallet.id, wallet.playerId, '10.00'),
    ];

    const results = await Promise.all(requests.map(
      (request, index) => processor(index).execute(request),
    ));

    expect(results.every(result => result.status === 'PROCESSED')).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '70.00', version: 4 });
    expect(await betTransactionCount(wallet.id)).toBe(3);
    expect(await debitLedgerCount(wallet.id)).toBe(3);
    await expectLedgerBalance(wallet.id);
  });

  function processor(index: number): ProcessBetUseCase {
    const instance = processors[index];
    if (instance === undefined) throw new Error(`ProcessBetUseCase instance ${index} is missing.`);
    return instance;
  }

  async function openWallet(amount: string): Promise<{ id: string; playerId: string }> {
    const playerId = crypto.randomUUID();
    const result = await createWallet.execute({
      playerId,
      initialBalance: Money.from({ amount, currency: 'BRL' }),
    });
    return { id: result.wallet.id, playerId };
  }

  function betInput(walletId: string, playerId: string, amount: string): ProcessBetInput {
    const unique = crypto.randomUUID();
    return {
      providerId: 'concurrency-provider',
      externalTransactionId: `external-${unique}`,
      idempotencyKey: `idempotency-${unique}`,
      playerId,
      walletId,
      roundId: `round-${unique}`,
      gameId: 'game-1',
      money: Money.from({ amount, currency: 'BRL' }),
    };
  }

  async function walletState(walletId: string): Promise<WalletStateRow | undefined> {
    const rows = await query<WalletStateRow>(
      'select balance_amount, version from wallets where id = ?',
      [walletId],
    );
    return rows[0];
  }

  async function transactionCountByIdempotency(idempotencyKey: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count
         from wager_transactions
        where idempotency_key = ? and kind = 'BET'`,
      [idempotencyKey],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function betTransactionCount(walletId: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count
         from wager_transactions
        where wallet_id = ? and kind = 'BET'`,
      [walletId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function providerTransactionCount(
    providerId: string,
    externalTransactionId: string,
  ): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count
         from wager_transactions
        where provider_id = ? and external_transaction_id = ? and kind = 'BET'`,
      [providerId, externalTransactionId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function debitLedgerCount(walletId: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count
         from wallet_ledger_entries ledger
         join wager_transactions transaction on transaction.id = ledger.transaction_id
        where ledger.wallet_id = ? and transaction.kind = 'BET' and ledger.direction = 'DEBIT'`,
      [walletId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function expectLedgerBalance(walletId: string): Promise<void> {
    const rows = await query<LedgerBalanceRow>(
      `select wallet.balance_amount,
              coalesce(sum(case ledger.direction
                when 'CREDIT' then ledger.amount
                when 'DEBIT' then -ledger.amount
              end), 0)::numeric(20,2) as reconstructed_balance
         from wallets wallet
         left join wallet_ledger_entries ledger on ledger.wallet_id = wallet.id
        where wallet.id = ?
        group by wallet.id, wallet.balance_amount`,
      [walletId],
    );
    expect(rows[0]?.balance_amount).toBe(rows[0]?.reconstructed_balance);
  }

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return primaryOrm.em.getConnection().execute<T[]>(sql, params);
  }
});
