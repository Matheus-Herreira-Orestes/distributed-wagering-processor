import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money.js';
import { Wallet } from '../../../../src/wallets/domain/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/wallets/domain/wallet-ledger-entry.js';
import type { ProcessBetRepositories, ProcessBetUnitOfWork } from '../../../../src/wagering/application/ports/process-bet.persistence-port.js';
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionInput } from '../../../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../../../src/wagering/domain/wager-transaction.js';
import { LedgerDirection } from '../../../../src/wallets/domain/wallet-ledger-entry.js';

class Store implements ProcessBetUnitOfWork {
  readonly transactions: WagerTransaction[] = [];
  readonly ledger: WalletLedgerEntry[] = [];
  constructor(readonly wallet: Wallet) {}
  transactional<T>(work: (repositories: ProcessBetRepositories) => Promise<T>): Promise<T> {
    return work({
      wallets: { findByIdForUpdate: async id => id === this.wallet.id ? this.wallet : null, update: async () => undefined },
      transactions: {
        findByIdempotencyKey: async key => this.transactions.find(item => item.idempotencyKey === key) ?? null,
        findByProviderExternal: async (provider, external) => this.transactions.find(item => item.providerId === provider && item.externalTransactionId === external) ?? null,
        findByReferenceAndKind: async (reference, kind) => this.transactions.find(item => item.referenceTransactionId === reference && item.kind === kind) ?? null,
        findByIdForUpdate: async id => this.transactions.find(item => item.id === id) ?? null,
        insert: async item => { this.transactions.push(item); }, update: async () => undefined,
      },
      ledgerEntries: { insert: async entry => { this.ledger.push(entry); } }, outbox: { insert: async () => undefined },
    });
  }
}

describe('ProcessWagerTransactionUseCase', () => {
  test('applies BET, WIN, LOSS, REFUND and ROLLBACK with their correct balance effects', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    let id = 0;
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => `id-${++id}` }, { now: () => new Date('2026-11-02T00:00:00.000Z') });
    const execute = (kind: WagerTransactionKind, amount: string, external: string, referenceExternalTransactionId?: string) => useCase.execute({
      providerId: 'provider', externalTransactionId: external, idempotencyKey: `key-${external}`, playerId: 'player', walletId: 'wallet',
      roundId: 'round', gameId: 'game', kind, money: Money.from({ amount, currency: 'BRL' }),
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    } satisfies ProcessWagerTransactionInput);

    expect((await execute(WagerTransactionKind.BET, '20.00', 'bet')).balance.toString()).toBe('80.00');
    expect((await execute(WagerTransactionKind.WIN, '30.00', 'win')).balance.toString()).toBe('110.00');
    expect((await execute(WagerTransactionKind.LOSS, '10.00', 'loss')).balance.toString()).toBe('110.00');
    expect(store.ledger).toHaveLength(2);
    expect((await execute(WagerTransactionKind.REFUND, '20.00', 'refund', 'bet')).balance.toString()).toBe('130.00');
    expect((await execute(WagerTransactionKind.ROLLBACK, '30.00', 'rollback', 'win')).balance.toString()).toBe('100.00');
    expect(store.ledger.map(entry => entry.direction)).toEqual([LedgerDirection.DEBIT, LedgerDirection.CREDIT, LedgerDirection.CREDIT, LedgerDirection.DEBIT]);
  });

  test('persists a missing reference as pending rather than dropping it', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.zero('BRL') });
    const store = new Store(wallet);
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => 'pending-id' });
    const result = await useCase.execute({ providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund-key',
      playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'missing-bet', money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    expect(result.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(store.transactions[0]?.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
  });

  test('marks an unrecoverable pending reference as FAILED without a financial effect', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => 'pending-id' });
    const pending = await useCase.execute({ providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund-key',
      playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'missing-bet', money: Money.from({ amount: '10.00', currency: 'BRL' }) });

    const failed = await useCase.failPendingReference(pending.transactionId);

    expect(failed?.status).toBe(WagerTransactionStatus.FAILED);
    expect(failed?.failureCode).toBe('REFERENCE_PROCESSING_FAILED');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(store.ledger).toHaveLength(0);
  });

  test('turns a pending REFUND into a processed transaction when its BET arrives later', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    let id = 0;
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => `id-${++id}` });
    const refund = await useCase.execute({ providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund-key',
      playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'bet', money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    await useCase.execute({ providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'bet-key',
      playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.BET,
      money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    const retried = await useCase.retryPending(refund.transactionId);
    expect(retried?.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('validates an optional WIN reference without requiring its amount to equal the BET', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    let id = 0;
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => `id-${++id}` });
    const bet = await useCase.execute({ providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'bet-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.BET, money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    const win = await useCase.execute({ providerId: 'provider', externalTransactionId: 'win', idempotencyKey: 'win-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.WIN, referenceExternalTransactionId: 'bet',
      money: Money.from({ amount: '25.00', currency: 'BRL' }) });
    expect(win.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(store.transactions.find(item => item.id === win.transactionId)?.referenceTransactionId).toBe(bet.transactionId);
    expect(wallet.balance.toString()).toBe('115.00');
  });

  test('keeps a ROLLBACK pending while its referenced REFUND is itself pending', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    let id = 0;
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => `id-${++id}` });
    const refund = await useCase.execute({ providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.REFUND, referenceExternalTransactionId: 'bet',
      money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    const rollback = await useCase.execute({ providerId: 'provider', externalTransactionId: 'rollback', idempotencyKey: 'rollback-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.ROLLBACK, referenceExternalTransactionId: 'refund',
      money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    expect(rollback.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    await useCase.execute({ providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'bet-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.BET, money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    expect((await useCase.retryPending(refund.transactionId))?.status).toBe(WagerTransactionStatus.PROCESSED);
    expect((await useCase.retryPending(rollback.transactionId))?.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(wallet.balance.toString()).toBe('90.00');
  });

  test('persists an invalid cross-currency reference as a rejection', async () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    const store = new Store(wallet);
    const useCase = new ProcessWagerTransactionUseCase(store, { generate: () => crypto.randomUUID() });
    // This fixture represents corrupt/provider-incompatible persisted input; the use case must audit it rather than throw.
    await useCase.execute({ providerId: 'provider', externalTransactionId: 'bet', idempotencyKey: 'bet-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.BET, money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    const transaction = store.transactions[0]!;
    Object.defineProperty(transaction, 'money', { value: Money.from({ amount: '10.00', currency: 'USD' }) });
    const result = await useCase.execute({ providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund-key', playerId: 'player',
      walletId: 'wallet', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: 'bet', money: Money.from({ amount: '10.00', currency: 'BRL' }) });
    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe('INVALID_REFERENCE');
  });
});
