import { describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ProcessWagerMessageUseCase } from '../../../../../src/messaging/application/process-wager-message.use-case.js';
import { SqsWagerConsumer } from '../../../../../src/messaging/infrastructure/sqs/sqs-wager-consumer.js';

describe('SqsWagerConsumer', () => {
  test('passes the configured visibility timeout to ReceiveMessage', async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as unknown as SQSClient;
    const processor = {} as ProcessWagerMessageUseCase;
    const consumer = new SqsWagerConsumer(client, 'queue-url', processor, 120);

    expect(await consumer.pollOnce()).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect((commands[0] as ReceiveMessageCommand).input.VisibilityTimeout).toBe(120);
  });
});
