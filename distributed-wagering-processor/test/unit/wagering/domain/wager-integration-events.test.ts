import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/shared/domain/money.js';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../../src/wagering/domain/wager-integration-events.js';

const occurredAt = new Date('2026-11-01T18:00:00.000Z');

describe('wager integration events', () => {
  test('serializes the exact versioned envelope and plain MoneyProps', () => {
    const event = new WagerTransactionProcessed({
      eventId: 'event-1', aggregateId: 'wallet-1', correlationId: 'transaction-1',
      causationId: 'idempotency-1', occurredAt,
      data: {
        transactionId: 'transaction-1', walletId: 'wallet-1', playerId: 'player-1',
        providerId: 'provider-1', externalTransactionId: 'external-1',
        money: Money.from({ amount: '10.00', currency: 'BRL' }).toJSON(),
        resultBalance: Money.from({ amount: '90.00', currency: 'BRL' }).toJSON(),
      },
    });

    expect(event.toJSON()).toEqual({
      eventId: 'event-1', eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1', correlationId: 'transaction-1',
      causationId: 'idempotency-1', occurredAt: occurredAt.toISOString(), version: 1,
      data: {
        transactionId: 'transaction-1', walletId: 'wallet-1', playerId: 'player-1',
        providerId: 'provider-1', externalTransactionId: 'external-1',
        money: { amount: '10.00', currency: 'BRL' },
        resultBalance: { amount: '90.00', currency: 'BRL' },
      },
    });
    expect(event.data.money).not.toBeInstanceOf(Money);
  });

  test('includes the required WalletBalanceChanged data', () => {
    const changed = new WalletBalanceChanged({
      eventId: 'event-3', aggregateId: 'wallet-1', correlationId: 'transaction-1',
      occurredAt,
      data: {
        transactionId: 'transaction-1', walletId: 'wallet-1', direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2,
      },
    });
    const rejected = new WagerTransactionRejected({
      eventId: 'event-2', aggregateId: 'wallet-1', correlationId: 'transaction-1', occurredAt,
      data: {
        transactionId: 'transaction-1', walletId: 'wallet-1', playerId: 'player-1',
        providerId: 'provider-1', externalTransactionId: 'external-1',
        money: { amount: '100.00', currency: 'BRL' },
        resultBalance: { amount: '20.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    });

    expect(changed.eventType).toBe('WalletBalanceChanged');
    expect(changed.version).toBe(1);
    expect(changed.data).toEqual({
      transactionId: 'transaction-1', walletId: 'wallet-1', direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2,
    });
    expect(rejected.eventType).toBe('WagerTransactionRejected');
  });

  test('returns a defensive copy of occurredAt', () => {
    const event = new WalletBalanceChanged({
      eventId: 'event-3', aggregateId: 'wallet-1', correlationId: 'transaction-1', occurredAt,
      data: {
        transactionId: 'transaction-1', walletId: 'wallet-1', direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2,
      },
    });
    event.occurredAt.setUTCFullYear(2000);
    expect(event.occurredAt).toEqual(occurredAt);
  });
});
