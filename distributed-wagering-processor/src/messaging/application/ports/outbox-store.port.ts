import type { OutboxMessage } from '../../domain/outbox-message.js';

export interface ClaimOutboxOptions {
  workerId: string;
  limit: number;
  now: Date;
  leaseDurationMs: number;
}

export interface OutboxFailureOptions {
  workerId: string;
  messageId: string;
  error: string;
  now: Date;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface OutboxStore {
  claimPending(options: ClaimOutboxOptions): Promise<OutboxMessage[]>;
  markPublished(messageId: string, workerId: string, at: Date): Promise<void>;
  recordFailure(options: OutboxFailureOptions): Promise<void>;
}
