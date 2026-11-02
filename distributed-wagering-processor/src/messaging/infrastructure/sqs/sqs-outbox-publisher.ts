import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxStore } from '../../application/ports/outbox-store.port.js';

export interface OutboxPublisherOptions {
  workerId: string;
  batchSize?: number;
  leaseDurationMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface PublishBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

export class SqsOutboxPublisher {
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly options: OutboxPublisherOptions,
  ) {
    this.batchSize = options.batchSize ?? 10;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 300_000;
    this.maxAttempts = options.maxAttempts ?? 10;
  }

  async publishBatch(now = new Date()): Promise<PublishBatchResult> {
    const messages = await this.store.claimPending({
      workerId: this.options.workerId,
      limit: this.batchSize,
      now,
      leaseDurationMs: this.leaseDurationMs,
    });
    let published = 0;
    let failed = 0;
    for (const message of messages) {
      try {
        await this.client.send(new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.payload.eventId,
        }));
        await this.store.markPublished(message.id, this.options.workerId, new Date());
        published += 1;
      } catch (error) {
        await this.store.recordFailure({
          workerId: this.options.workerId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
          now: new Date(),
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          maxAttempts: this.maxAttempts,
        });
        failed += 1;
      }
    }
    return { claimed: messages.length, published, failed };
  }

  async run(signal: AbortSignal, idleDelayMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      const result = await this.publishBatch();
      if (result.claimed === 0) await delay(idleDelayMs, signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
