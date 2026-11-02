import { DomainError } from '../../shared/domain/domain-error.js';
import type { IntegrationEvent, IntegrationEventJson } from './integration-event.js';

export class InvalidOutboxTransitionError extends DomainError {}

export interface RehydrateOutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventJson<object>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  claimedAt: Date | null;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  lastError: string | null;
  failedAt: Date | null;
}

export class OutboxMessage {
  private currentAttempts: number;
  private currentNextAttemptAt: Date | null;
  private currentPublishedAt: Date | null;
  private currentClaimedAt: Date | null;
  private currentClaimedBy: string | null;
  private currentClaimExpiresAt: Date | null;
  private currentLastError: string | null;
  private currentFailedAt: Date | null;
  private readonly eventOccurredAt: Date;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: IntegrationEventJson<object>,
    occurredAt: Date,
    props: Omit<RehydrateOutboxMessageProps, 'id' | 'aggregateId' | 'eventType' | 'payload' | 'occurredAt'>,
  ) {
    this.eventOccurredAt = new Date(occurredAt);
    this.currentAttempts = props.attempts;
    this.currentNextAttemptAt = props.nextAttemptAt;
    this.currentPublishedAt = props.publishedAt;
    this.currentClaimedAt = props.claimedAt;
    this.currentClaimedBy = props.claimedBy;
    this.currentClaimExpiresAt = props.claimExpiresAt;
    this.currentLastError = props.lastError;
    this.currentFailedAt = props.failedAt;
  }

  static fromEvent(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, event.toJSON(), event.occurredAt, {
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
      claimedAt: null,
      claimedBy: null,
      claimExpiresAt: null,
      lastError: null,
      failedAt: null,
    });
  }

  static rehydrate(props: RehydrateOutboxMessageProps): OutboxMessage {
    return new OutboxMessage(
      props.id,
      props.aggregateId,
      props.eventType,
      props.payload,
      new Date(props.occurredAt),
      {
        attempts: props.attempts,
        nextAttemptAt: cloneDate(props.nextAttemptAt),
        publishedAt: cloneDate(props.publishedAt),
        claimedAt: cloneDate(props.claimedAt),
        claimedBy: props.claimedBy,
        claimExpiresAt: cloneDate(props.claimExpiresAt),
        lastError: props.lastError,
        failedAt: cloneDate(props.failedAt),
      },
    );
  }

  get attempts(): number { return this.currentAttempts; }
  get occurredAt(): Date { return new Date(this.eventOccurredAt); }
  get nextAttemptAt(): Date | null { return cloneDate(this.currentNextAttemptAt); }
  get publishedAt(): Date | null { return cloneDate(this.currentPublishedAt); }
  get claimedAt(): Date | null { return cloneDate(this.currentClaimedAt); }
  get claimedBy(): string | null { return this.currentClaimedBy; }
  get claimExpiresAt(): Date | null { return cloneDate(this.currentClaimExpiresAt); }
  get lastError(): string | null { return this.currentLastError; }
  get failedAt(): Date | null { return cloneDate(this.currentFailedAt); }
  get isPublished(): boolean { return this.currentPublishedAt !== null; }
  get isPermanentlyFailed(): boolean { return this.currentFailedAt !== null; }

  claim(workerId: string, at: Date, leaseDurationMs: number): void {
    if (this.isPublished || this.isPermanentlyFailed) {
      throw new InvalidOutboxTransitionError('A terminal outbox message cannot be claimed.');
    }
    if (this.currentClaimExpiresAt !== null && this.currentClaimExpiresAt > at) {
      throw new InvalidOutboxTransitionError('The outbox message already has an active claim.');
    }
    this.currentClaimedBy = workerId;
    this.currentClaimedAt = new Date(at);
    this.currentClaimExpiresAt = new Date(at.getTime() + leaseDurationMs);
  }

  markPublished(workerId: string, at: Date): void {
    this.assertClaimedBy(workerId);
    this.currentPublishedAt = new Date(at);
    this.currentLastError = null;
    this.clearClaim();
  }

  recordFailure(
    workerId: string,
    error: string,
    at: Date,
    options: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number },
  ): void {
    this.assertClaimedBy(workerId);
    this.currentAttempts += 1;
    this.currentLastError = error;
    if (this.currentAttempts >= options.maxAttempts) {
      this.currentFailedAt = new Date(at);
      this.currentNextAttemptAt = null;
    } else {
      this.currentNextAttemptAt = new Date(at.getTime() + exponentialBackoffMs(
        this.currentAttempts,
        options.baseDelayMs,
        options.maxDelayMs,
      ));
    }
    this.clearClaim();
  }

  private assertClaimedBy(workerId: string): void {
    if (this.currentClaimedBy !== workerId) {
      throw new InvalidOutboxTransitionError(`Outbox message is not claimed by ${workerId}.`);
    }
  }

  private clearClaim(): void {
    this.currentClaimedBy = null;
    this.currentClaimedAt = null;
    this.currentClaimExpiresAt = null;
  }
}

export function exponentialBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || baseDelayMs < 0 || maxDelayMs < baseDelayMs) {
    throw new InvalidOutboxTransitionError('Invalid exponential-backoff parameters.');
  }
  return Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
}

function cloneDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value);
}
