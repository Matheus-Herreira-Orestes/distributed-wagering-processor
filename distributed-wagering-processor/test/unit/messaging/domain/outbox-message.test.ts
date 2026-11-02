import { describe, expect, test } from 'bun:test';
import { OutboxMessage, exponentialBackoffMs } from '../../../../src/messaging/domain/outbox-message.js';
import { WagerTransactionProcessed } from '../../../../src/wagering/domain/wager-integration-events.js';

const occurredAt = new Date('2026-11-01T18:00:00.000Z');

function message(): OutboxMessage {
  return OutboxMessage.fromEvent(new WagerTransactionProcessed({
    eventId: 'event-1', aggregateId: 'wallet-1', correlationId: 'transaction-1', occurredAt,
    data: {
      transactionId: 'transaction-1', walletId: 'wallet-1', playerId: 'player-1',
      providerId: 'provider-1', externalTransactionId: 'external-1',
      money: { amount: '10.00', currency: 'BRL' },
      resultBalance: { amount: '90.00', currency: 'BRL' },
    },
  }));
}

describe('OutboxMessage', () => {
  test('claims and publishes only through the owning worker', () => {
    const target = message();
    target.claim('worker-1', occurredAt, 30_000);
    expect(target.claimedBy).toBe('worker-1');

    target.markPublished('worker-1', new Date(occurredAt.getTime() + 1_000));
    expect(target.isPublished).toBe(true);
    expect(target.claimedBy).toBeNull();
  });

  test('records retry backoff and eventually enters a terminal failure state', () => {
    const target = message();
    target.claim('worker-1', occurredAt, 30_000);
    target.recordFailure('worker-1', 'temporary', occurredAt, {
      baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 2,
    });
    expect(target.attempts).toBe(1);
    expect(target.nextAttemptAt).toEqual(new Date(occurredAt.getTime() + 1_000));

    const retryAt = target.nextAttemptAt ?? occurredAt;
    target.claim('worker-2', retryAt, 30_000);
    target.recordFailure('worker-2', 'still failing', retryAt, {
      baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 2,
    });
    expect(target.isPermanentlyFailed).toBe(true);
    expect(target.nextAttemptAt).toBeNull();
  });

  test('returns defensive copies from every date getter', () => {
    const date = new Date('2026-11-01T18:00:00.000Z');
    const target = OutboxMessage.rehydrate({
      id: 'event-1', aggregateId: 'wallet-1', eventType: 'TestEvent',
      payload: {
        eventId: 'event-1', eventType: 'TestEvent', aggregateId: 'wallet-1',
        correlationId: 'transaction-1', occurredAt: date.toISOString(), version: 1, data: {},
      },
      occurredAt: date, attempts: 1, nextAttemptAt: date, publishedAt: date,
      claimedAt: date, claimedBy: 'worker-1', claimExpiresAt: date,
      lastError: 'failure', failedAt: date,
    });

    for (const returned of [
      target.occurredAt, target.nextAttemptAt, target.publishedAt,
      target.claimedAt, target.claimExpiresAt, target.failedAt,
    ]) returned?.setUTCFullYear(2000);

    expect(target.occurredAt).toEqual(date);
    expect(target.nextAttemptAt).toEqual(date);
    expect(target.publishedAt).toEqual(date);
    expect(target.claimedAt).toEqual(date);
    expect(target.claimExpiresAt).toEqual(date);
    expect(target.failedAt).toEqual(date);
  });
});

describe('exponentialBackoffMs', () => {
  test('doubles by attempt and respects the maximum', () => {
    expect(exponentialBackoffMs(1, 1_000, 5_000)).toBe(1_000);
    expect(exponentialBackoffMs(2, 1_000, 5_000)).toBe(2_000);
    expect(exponentialBackoffMs(4, 1_000, 5_000)).toBe(5_000);
  });
});
