import { describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { WageringController } from '../../../../src/interfaces/http/wagering.controller.js';
import type { RuntimeService } from '../../../../src/interfaces/runtime.service.js';

describe('WageringController', () => {
  test('rejects absent, blank, or non-string optional WIN references before processing', async () => {
    let calls = 0;
    const controller = new WageringController({
      processWager: async () => {
        calls += 1;
        throw new Error('must not process an invalid request');
      },
    } as unknown as RuntimeService);
    const response = { status: (_code: number) => undefined };

    for (const referenceExternalTransactionId of ['', '   ', 123, { id: 'bet-1' }]) {
      try {
        await controller.submit('key-1', {
          providerId: 'provider', externalTransactionId: 'win-1', playerId: 'player', walletId: 'wallet',
          roundId: 'round', gameId: 'game', kind: 'WIN', money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId,
        }, response);
        throw new Error('Expected invalid reference to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(400);
      }
    }

    expect(calls).toBe(0);
  });
});
