import { describe, expect, test } from 'bun:test';
import {
  InboxMessage,
  InvalidInboxTransitionError,
} from '../../../../src/messaging/domain/inbox-message.js';

const receivedAt = new Date('2026-11-01T18:00:00.000Z');
const hash = 'a'.repeat(64);

describe('InboxMessage', () => {
  test('moves a received message to processed exactly once', () => {
    const message = InboxMessage.receive({
      consumerName: 'consumer', messageId: 'message-1', payloadHash: hash, receivedAt,
    });
    expect(message.isProcessed).toBe(false);

    const processedAt = new Date('2026-11-01T18:00:01.000Z');
    message.markProcessed(processedAt);

    expect(message.isProcessed).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
    expect(() => message.markProcessed(new Date())).toThrow(InvalidInboxTransitionError);
  });

  test('rehydrates persisted state without replaying transitions', () => {
    const processedAt = new Date('2026-11-01T18:00:01.000Z');
    const message = InboxMessage.rehydrate({
      consumerName: 'consumer', messageId: 'message-1', payloadHash: hash, receivedAt, processedAt,
    });
    expect(message.isProcessed).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  test('returns defensive copies of received and processed dates', () => {
    const processedAt = new Date('2026-11-01T18:00:01.000Z');
    const message = InboxMessage.rehydrate({
      consumerName: 'consumer', messageId: 'message-1', payloadHash: hash, receivedAt, processedAt,
    });

    message.receivedAt.setUTCFullYear(2000);
    message.processedAt?.setUTCFullYear(2000);

    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.processedAt).toEqual(processedAt);
  });
});
