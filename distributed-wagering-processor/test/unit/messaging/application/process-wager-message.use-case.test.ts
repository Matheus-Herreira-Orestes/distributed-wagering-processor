import { describe, expect, test } from 'bun:test';
import {
  parseWagerTransactionRequested,
  type WagerTransactionRequested,
} from '../../../../src/messaging/application/process-wager-message.use-case.js';
import { InvalidWagerMessageError } from '../../../../src/messaging/application/process-wager-message-error.js';

const requiredBody = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a', externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: 'player-uuid', walletId: 'wallet-uuid', roundId: 'round-987',
    gameId: 'fortune-chimp', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
} satisfies WagerTransactionRequested;

describe('WagerTransactionRequested contract', () => {
  test('parses the required messageId/data body shape', () => {
    expect(parseWagerTransactionRequested(JSON.stringify(requiredBody))).toEqual(requiredBody);
  });

  test('rejects the old id/payload shape and unsupported kinds', () => {
    expect(() => parseWagerTransactionRequested(JSON.stringify({
      id: 'msg-123', type: 'WagerTransactionRequested', occurredAt: requiredBody.occurredAt,
      payload: requiredBody.data,
    }))).toThrow(InvalidWagerMessageError);
    expect(() => parseWagerTransactionRequested(JSON.stringify({
      ...requiredBody, data: { ...requiredBody.data, kind: 'UNKNOWN' },
    }))).toThrow(InvalidWagerMessageError);
  });
});
