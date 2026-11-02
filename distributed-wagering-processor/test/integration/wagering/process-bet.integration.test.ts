import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { Money } from '../../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../../src/wallets/application/create-wallet.use-case.js';
import { MikroOrmCreateWalletUnitOfWork } from '../../../src/wallets/infrastructure/persistence/mikro-orm-create-wallet.unit-of-work.js';
import {
  BetWalletMismatchError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../../src/wagering/application/process-bet-error.js';
import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from '../../../src/wagering/application/process-bet.use-case.js';
import { MikroOrmProcessBetUnitOfWork } from '../../../src/wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';

interface WalletStateRow {
  balance_amount: string;
  version: number;
}

interface TransactionStateRow {
  id: string;
  status: string;
  failure_code: string | null;
  result_balance_amount: string;
}

interface CountRow {
  count: string;
}

describe('ProcessBetUseCase with PostgreSQL', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let processBet: ProcessBetUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.getMigrator().up();
    createWallet = new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(orm));
    processBet = new ProcessBetUseCase(new MikroOrmProcessBetUnitOfWork(orm));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('processes a successful BET with one debit and one ledger entry', async () => {
    const wallet = await openWallet('100.00');
    const request = betInput(wallet.id, wallet.playerId, '25.00');

    const result = await processBet.execute(request);

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.toString()).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    expect(await transactionState(request.idempotencyKey)).toEqual({
      id: result.transactionId,
      status: 'PROCESSED',
      failure_code: null,
      result_balance_amount: '75.00',
    });
    expect(await ledgerCount(result.transactionId)).toBe(1);
  });

  test('persists insufficient funds without changing the wallet or creating a ledger entry', async () => {
    const wallet = await openWallet('10.00');
    const request = betInput(wallet.id, wallet.playerId, '25.00');

    const result = await processBet.execute(request);

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance.toString()).toBe('10.00');
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '10.00', version: 1 });
    expect(await transactionState(request.idempotencyKey)).toEqual({
      id: result.transactionId,
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      result_balance_amount: '10.00',
    });
    expect(await ledgerCount(result.transactionId)).toBe(0);
  });

  test('replays the same request without an additional debit or ledger entry', async () => {
    const wallet = await openWallet('100.00');
    const request = betInput(wallet.id, wallet.playerId, '30.00');

    const first = await processBet.execute(request);
    const replay = await processBet.execute(request);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.toString()).toBe('70.00');
    expect(await transactionCount(request.idempotencyKey)).toBe(1);
    expect(await ledgerCount(first.transactionId)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '70.00', version: 2 });
  });

  test('rejects an idempotency key reused with a different payload without side effects', async () => {
    const wallet = await openWallet('100.00');
    const request = betInput(wallet.id, wallet.playerId, '20.00');
    const first = await processBet.execute(request);

    await expect(processBet.execute({
      ...request,
      money: Money.from({ amount: '21.00', currency: 'BRL' }),
    })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await transactionCount(request.idempotencyKey)).toBe(1);
    expect(await ledgerCount(first.transactionId)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '80.00', version: 2 });
  });

  test('rejects wallet, player, and currency mismatches without financial effects', async () => {
    const wallet = await openWallet('100.00');
    const wrongWalletRequest = betInput(crypto.randomUUID(), wallet.playerId, '10.00');
    const wrongPlayerRequest = betInput(wallet.id, crypto.randomUUID(), '10.00');
    const wrongCurrencyRequest = {
      ...betInput(wallet.id, wallet.playerId, '10.00'),
      money: Money.from({ amount: '10.00', currency: 'USD' }),
    };

    await expect(processBet.execute(wrongWalletRequest)).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(processBet.execute(wrongPlayerRequest)).rejects.toBeInstanceOf(BetWalletMismatchError);
    await expect(processBet.execute(wrongCurrencyRequest)).rejects.toBeInstanceOf(BetWalletMismatchError);

    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
    expect(await transactionCount(wrongWalletRequest.idempotencyKey)).toBe(0);
    expect(await transactionCount(wrongPlayerRequest.idempotencyKey)).toBe(0);
    expect(await transactionCount(wrongCurrencyRequest.idempotencyKey)).toBe(0);
  });

  test('returns the persisted replay balance even after a later BET changes the wallet', async () => {
    const wallet = await openWallet('100.00');
    const originalRequest = betInput(wallet.id, wallet.playerId, '10.00');
    const laterRequest = betInput(wallet.id, wallet.playerId, '20.00');

    const original = await processBet.execute(originalRequest);
    await processBet.execute(laterRequest);
    const replay = await processBet.execute(originalRequest);

    expect(original.balance.toString()).toBe('90.00');
    expect(replay.balance.toString()).toBe('90.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '70.00', version: 3 });
  });

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
      providerId: 'integration-provider',
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

  async function transactionState(idempotencyKey: string): Promise<TransactionStateRow | undefined> {
    const rows = await query<TransactionStateRow>(
      `select id, status, failure_code, result_balance_amount
         from wager_transactions where idempotency_key = ?`,
      [idempotencyKey],
    );
    return rows[0];
  }

  async function transactionCount(idempotencyKey: string): Promise<number> {
    return count('wager_transactions', 'idempotency_key', idempotencyKey);
  }

  async function ledgerCount(transactionId: string): Promise<number> {
    return count('wallet_ledger_entries', 'transaction_id', transactionId);
  }

  async function count(table: string, column: string, value: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count from "${table}" where "${column}" = ?`,
      [value],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, params);
  }
});
