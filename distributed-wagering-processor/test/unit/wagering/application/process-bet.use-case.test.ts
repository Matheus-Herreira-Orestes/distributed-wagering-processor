import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money.js';
import { Wallet } from '../../../../src/wallets/domain/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/wallets/domain/wallet-ledger-entry.js';
import {
  BetWalletMismatchError,
  IdempotencyConflictError,
} from '../../../../src/wagering/application/process-bet-error.js';
import type {
  ProcessBetRepositories,
  ProcessBetUnitOfWork,
} from '../../../../src/wagering/application/ports/process-bet.persistence-port.js';
import {
  ProcessBetUseCase,
  canonicalBetPayloadHash,
  type BetIdGenerator,
  type ProcessBetInput,
} from '../../../../src/wagering/application/process-bet.use-case.js';
import type { WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';

const now = new Date('2026-11-01T18:00:00.000Z');

class SequenceIds implements BetIdGenerator {
  constructor(private readonly ids = ['transaction-1', 'ledger-1']) {}
  generate(): string {
    const id = this.ids.shift();
    if (id === undefined) throw new Error('No test ID remains.');
    return id;
  }
}

class InMemoryBetUnitOfWork implements ProcessBetUnitOfWork {
  readonly transactions = new Map<string, WagerTransaction>();
  readonly ledgerEntries: WalletLedgerEntry[] = [];

  constructor(readonly wallet: Wallet) {}

  transactional<T>(work: (repositories: ProcessBetRepositories) => Promise<T>): Promise<T> {
    return work({
      wallets: {
        findByIdForUpdate: async id => id === this.wallet.id ? this.wallet : null,
        update: async () => undefined,
      },
      transactions: {
        findByIdempotencyKey: async key => this.transactions.get(key) ?? null,
        findByProviderExternal: async (providerId, externalTransactionId) =>
          [...this.transactions.values()].find(transaction =>
            transaction.providerId === providerId
            && transaction.externalTransactionId === externalTransactionId) ?? null,
        insert: async transaction => { this.transactions.set(transaction.idempotencyKey, transaction); },
      },
      ledgerEntries: {
        insert: async entry => { this.ledgerEntries.push(entry); },
      },
      outbox: {
        insert: async () => undefined,
      },
    });
  }
}

function input(wallet: Wallet, overrides: Partial<ProcessBetInput> = {}): ProcessBetInput {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'idempotency-1',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    money: Money.from({ amount: '25.00', currency: wallet.currency }),
    ...overrides,
  };
}

function wallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
    openedAt: now,
  });
}

describe('ProcessBetUseCase', () => {
  test('processes a debit and creates exactly one ledger entry', async () => {
    const target = wallet();
    const persistence = new InMemoryBetUnitOfWork(target);
    const useCase = new ProcessBetUseCase(persistence, new SequenceIds(), { now: () => now });

    const result = await useCase.execute(input(target));

    expect(result.status).toBe('PROCESSED');
    expect(result.balance.toString()).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);
    expect(target.version).toBe(2);
    expect(persistence.ledgerEntries).toHaveLength(1);
  });

  test('persists an insufficient-funds rejection without changing the wallet', async () => {
    const target = wallet('10.00');
    const persistence = new InMemoryBetUnitOfWork(target);
    const useCase = new ProcessBetUseCase(persistence, new SequenceIds(['transaction-1']), { now: () => now });

    const result = await useCase.execute(input(target));

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance.toString()).toBe('10.00');
    expect(target.version).toBe(1);
    expect(persistence.ledgerEntries).toHaveLength(0);
  });

  test('replays an identical persisted result and rejects a conflicting payload', async () => {
    const target = wallet();
    const persistence = new InMemoryBetUnitOfWork(target);
    const useCase = new ProcessBetUseCase(persistence, new SequenceIds(), { now: () => now });
    const request = input(target);

    const first = await useCase.execute(request);
    const replay = await useCase.execute(request);

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.toString()).toBe('75.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(persistence.ledgerEntries).toHaveLength(1);
    await expect(useCase.execute(input(target, {
      money: Money.from({ amount: '26.00', currency: 'BRL' }),
    }))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('rejects player and currency mismatches before financial effects', async () => {
    const target = wallet();
    const persistence = new InMemoryBetUnitOfWork(target);
    const useCase = new ProcessBetUseCase(persistence, new SequenceIds(), { now: () => now });

    await expect(useCase.execute(input(target, { playerId: 'other-player' })))
      .rejects.toBeInstanceOf(BetWalletMismatchError);
    await expect(useCase.execute(input(target, {
      money: Money.from({ amount: '25.00', currency: 'USD' }),
    }))).rejects.toBeInstanceOf(BetWalletMismatchError);
    expect(target.balance.toString()).toBe('100.00');
    expect(persistence.transactions.size).toBe(0);
  });

  test('canonical payload hash excludes the idempotency key', async () => {
    const target = wallet();
    const first = input(target, { idempotencyKey: 'transport-key-1' });
    const second = input(target, { idempotencyKey: 'transport-key-2' });

    expect(await canonicalBetPayloadHash(first)).toBe(await canonicalBetPayloadHash(second));
  });
});
