import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { Money } from '../../../src/shared/domain/money.js';
import { WalletAlreadyExistsError } from '../../../src/wallets/application/create-wallet-error.js';
import {
  CreateWalletUseCase,
  type IdGenerator,
} from '../../../src/wallets/application/create-wallet.use-case.js';
import { MikroOrmCreateWalletUnitOfWork } from '../../../src/wallets/infrastructure/persistence/mikro-orm-create-wallet.unit-of-work.js';

interface CountRow {
  count: string;
}

interface WalletRow {
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

interface OpeningRow {
  kind: string;
  status: string;
  amount: string;
  currency: string;
  result_balance_amount: string;
  direction: string;
  balance_before: string;
  balance_after: string;
}

class SequenceIdGenerator implements IdGenerator {
  constructor(private readonly ids: string[]) {}

  generate(): string {
    const id = this.ids.shift();
    if (id === undefined) {
      throw new Error('No test ID remains in the sequence.');
    }
    return id;
  }
}

describe('CreateWalletUseCase with PostgreSQL', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmCreateWalletUnitOfWork;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.getMigrator().up();
    unitOfWork = new MikroOrmCreateWalletUnitOfWork(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('creates a zero-balance wallet without opening records', async () => {
    const playerId = crypto.randomUUID();
    const useCase = new CreateWalletUseCase(unitOfWork);

    const result = await useCase.execute({
      playerId,
      initialBalance: Money.zero('BRL'),
    });

    const wallets = await query<WalletRow>(
      'select player_id, currency, balance_amount, version from wallets where id = ?',
      [result.wallet.id],
    );
    expect(wallets).toEqual([{
      player_id: playerId,
      currency: 'BRL',
      balance_amount: '0.00',
      version: 1,
    }]);
    expect(result.openingTransactionId).toBeNull();
    expect(result.ledgerEntryId).toBeNull();
    expect(await count('wager_transactions', 'wallet_id', result.wallet.id)).toBe(0);
    expect(await count('wallet_ledger_entries', 'wallet_id', result.wallet.id)).toBe(0);
  });

  test('creates one processed OPENING transaction and one CREDIT ledger entry', async () => {
    const playerId = crypto.randomUUID();
    const useCase = new CreateWalletUseCase(unitOfWork);

    const result = await useCase.execute({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const rows = await query<OpeningRow>(
      `select transaction.kind, transaction.status, transaction.amount, transaction.currency,
              transaction.result_balance_amount, ledger.direction, ledger.balance_before,
              ledger.balance_after
         from wager_transactions transaction
         join wallet_ledger_entries ledger on ledger.transaction_id = transaction.id
        where transaction.wallet_id = ?`,
      [result.wallet.id],
    );
    const wallets = await query<WalletRow>(
      'select player_id, currency, balance_amount, version from wallets where id = ?',
      [result.wallet.id],
    );

    expect(await count('wallets', 'id', result.wallet.id)).toBe(1);
    expect(await count('wager_transactions', 'wallet_id', result.wallet.id)).toBe(1);
    expect(await count('wallet_ledger_entries', 'wallet_id', result.wallet.id)).toBe(1);
    expect(wallets).toEqual([{
      player_id: playerId,
      currency: 'BRL',
      balance_amount: '100.00',
      version: 1,
    }]);
    expect(rows).toEqual([{
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '100.00',
      currency: 'BRL',
      result_balance_amount: '100.00',
      direction: 'CREDIT',
      balance_before: '0.00',
      balance_after: '100.00',
    }]);
  });

  test('rejects a duplicate player and currency with a clear conflict', async () => {
    const playerId = crypto.randomUUID();
    const useCase = new CreateWalletUseCase(unitOfWork);
    const input = { playerId, initialBalance: Money.zero('USD') };

    await useCase.execute(input);

    let received: unknown;
    try {
      await useCase.execute(input);
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(WalletAlreadyExistsError);
    expect(await countByPlayerAndCurrency(playerId, 'USD')).toBe(1);
  });

  test('rolls back the wallet when a later persistence operation fails', async () => {
    const transactionIdCollision = crypto.randomUUID();
    const firstUseCase = new CreateWalletUseCase(
      unitOfWork,
      new SequenceIdGenerator([
        crypto.randomUUID(),
        transactionIdCollision,
        crypto.randomUUID(),
      ]),
    );
    await firstUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });

    const rolledBackWalletId = crypto.randomUUID();
    const rolledBackPlayerId = crypto.randomUUID();
    const secondUseCase = new CreateWalletUseCase(
      unitOfWork,
      new SequenceIdGenerator([
        rolledBackWalletId,
        transactionIdCollision,
        crypto.randomUUID(),
      ]),
    );

    let received: unknown;
    try {
      await secondUseCase.execute({
        playerId: rolledBackPlayerId,
        initialBalance: Money.from({ amount: '2.00', currency: 'BRL' }),
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(Error);
    expect(await count('wallets', 'id', rolledBackWalletId)).toBe(0);
    expect(await count('wager_transactions', 'wallet_id', rolledBackWalletId)).toBe(0);
    expect(await count('wallet_ledger_entries', 'wallet_id', rolledBackWalletId)).toBe(0);
  });

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, params);
  }

  async function count(table: string, column: string, value: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count from "${table}" where "${column}" = ?`,
      [value],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function countByPlayerAndCurrency(playerId: string, currency: string): Promise<number> {
    const rows = await query<CountRow>(
      'select count(*)::text as count from wallets where player_id = ? and currency = ?',
      [playerId, currency],
    );
    return Number(rows[0]?.count ?? 0);
  }
});
