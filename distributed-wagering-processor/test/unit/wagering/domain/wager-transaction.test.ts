import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../../src/shared/domain/domain-error.js';
import { Money } from '../../../../src/shared/domain/money.js';
import {
  WagerFailureCode,
  WagerTransaction,
  WagerTransactionStatus,
  type CreateBetProps,
} from '../../../../src/wagering/domain/wager-transaction.js';
import {
  InvalidWagerTransactionError,
  TerminalWagerTransactionError,
} from '../../../../src/wagering/domain/wager-transaction-error.js';

const createdAt = new Date('2026-11-01T17:00:00.000Z');

function props(overrides: Partial<CreateBetProps> = {}): CreateBetProps {
  return {
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'idempotency-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt,
    ...overrides,
  };
}

describe('WagerTransaction BET', () => {
  test('starts pending and transitions to processed with a persisted result balance', () => {
    const transaction = WagerTransaction.createBet(props());
    const processedAt = new Date('2026-11-01T17:01:00.000Z');

    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    transaction.markProcessed(Money.from({ amount: '75.00', currency: 'BRL' }), processedAt);

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.resultBalance?.toString()).toBe('75.00');
    expect(transaction.failureCode).toBeNull();
    expect(transaction.processedAt).toEqual(processedAt);
  });

  test('transitions to rejected with a stable insufficient-funds code', () => {
    const transaction = WagerTransaction.createBet(props());

    transaction.reject(
      WagerFailureCode.INSUFFICIENT_FUNDS,
      Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt,
    );

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(transaction.resultBalance?.toString()).toBe('10.00');
  });

  test('transitions a pending transaction to FAILED with an auditable code', () => {
    const transaction = WagerTransaction.createBet(props());
    transaction.fail(
      WagerFailureCode.REFERENCE_PROCESSING_FAILED,
      Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt,
    );

    expect(transaction.status).toBe(WagerTransactionStatus.FAILED);
    expect(transaction.failureCode).toBe('REFERENCE_PROCESSING_FAILED');
    expect(transaction.isTerminal).toBe(true);
  });

  test('does not allow a terminal transaction to transition again', () => {
    const transaction = WagerTransaction.createBet(props());
    transaction.markProcessed(Money.from({ amount: '75.00', currency: 'BRL' }), createdAt);

    expect(() => transaction.reject(
      WagerFailureCode.INSUFFICIENT_FUNDS,
      Money.from({ amount: '75.00', currency: 'BRL' }),
      createdAt,
    )).toThrow(TerminalWagerTransactionError);
  });

  test('rejects invalid hashes, non-positive amounts, and result currency mismatches', () => {
    expect(() => WagerTransaction.createBet(props({ payloadHash: 'not-a-hash' })))
      .toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.createBet(props({ money: Money.from({ amount: '1.00', currency: 'BRL' }).negate() })))
      .toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.createBet(props({ money: Money.zero('BRL') })))
      .toThrow(InvalidWagerTransactionError);

    const transaction = WagerTransaction.createBet(props());
    expect(() => transaction.markProcessed(Money.zero('USD'), createdAt))
      .toThrow(CurrencyMismatchError);
  });

  test('rehydrates terminal persisted state without replaying transitions', () => {
    const transaction = WagerTransaction.rehydrate({
      ...props(),
      status: WagerTransactionStatus.REJECTED,
      resultBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      failureCode: WagerFailureCode.INSUFFICIENT_FUNDS,
      processedAt: createdAt,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.REJECTED);
    expect(transaction.resultBalance?.toString()).toBe('10.00');
  });
});
