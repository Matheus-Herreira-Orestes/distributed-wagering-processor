import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  ClaimOutboxOptions,
  OutboxFailureOptions,
  OutboxStore,
} from '../../application/ports/outbox-store.port.js';
import { InvalidOutboxTransitionError, OutboxMessage } from '../../domain/outbox-message.js';
import type { IntegrationEventJson } from '../../domain/integration-event.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventJson<object> | string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  claimed_at: Date | null;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  last_error: string | null;
  failed_at: Date | null;
}

const columns = `"id", "aggregate_id", "event_type", "payload", "occurred_at", "attempts",
  "next_attempt_at", "published_at", "claimed_at", "claimed_by", "claim_expires_at",
  "last_error", "failed_at"`;

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  claimPending(options: ClaimOutboxOptions): Promise<OutboxMessage[]> {
    const expiresAt = new Date(options.now.getTime() + options.leaseDurationMs);
    return this.orm.em.transactional(async entityManager => {
      const rows = await entityManager.execute<OutboxRow[]>(
        `with candidates as (
           select "id" from "outbox_messages"
            where "published_at" is null
              and "failed_at" is null
              and ("next_attempt_at" is null or "next_attempt_at" <= ?)
              and ("claim_expires_at" is null or "claim_expires_at" <= ?)
            order by coalesce("next_attempt_at", "occurred_at"), "occurred_at", "id"
            for update skip locked
            limit ?
         )
         update "outbox_messages" message
            set "claimed_at" = ?, "claimed_by" = ?, "claim_expires_at" = ?
           from candidates
          where message."id" = candidates."id"
        returning message.*`,
        [options.now, options.now, options.limit, options.now, options.workerId, expiresAt],
      );
      return rows.map(rehydrate);
    });
  }

  markPublished(messageId: string, workerId: string, at: Date): Promise<void> {
    return this.orm.em.transactional(async entityManager => {
      const result = await entityManager.execute(
        `update "outbox_messages"
            set "published_at" = ?, "claimed_at" = null, "claimed_by" = null,
                "claim_expires_at" = null, "last_error" = null
          where "id" = ? and "claimed_by" = ? and "published_at" is null`,
        [at, messageId, workerId],
        'run',
      );
      if (affectedRows(result) !== 1) {
        throw new InvalidOutboxTransitionError(`Outbox claim ${messageId}/${workerId} was lost.`);
      }
    });
  }

  recordFailure(options: OutboxFailureOptions): Promise<void> {
    return this.orm.em.transactional(async entityManager => {
      const rows = await entityManager.execute<OutboxRow[]>(
        `select ${columns} from "outbox_messages" where "id" = ? for update`,
        [options.messageId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new InvalidOutboxTransitionError(`Outbox message ${options.messageId} was not found.`);
      }
      const message = rehydrate(row);
      message.recordFailure(options.workerId, options.error, options.now, {
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        maxAttempts: options.maxAttempts,
      });
      await persistFailure(entityManager, message);
    });
  }
}

async function persistFailure(entityManager: EntityManager, message: OutboxMessage): Promise<void> {
  await entityManager.execute(
    `update "outbox_messages"
        set "attempts" = ?, "next_attempt_at" = ?, "last_error" = ?, "failed_at" = ?,
            "claimed_at" = null, "claimed_by" = null, "claim_expires_at" = null
      where "id" = ?`,
    [message.attempts, message.nextAttemptAt, message.lastError, message.failedAt, message.id],
    'run',
  );
}

function rehydrate(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) as IntegrationEventJson<object> : row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    claimExpiresAt: row.claim_expires_at,
    lastError: row.last_error,
    failedAt: row.failed_at,
  });
}

function affectedRows(result: unknown): number {
  if (typeof result === 'object' && result !== null && 'affectedRows' in result
    && typeof result.affectedRows === 'number') return result.affectedRows;
  if (typeof result === 'object' && result !== null && 'rowCount' in result
    && typeof result.rowCount === 'number') return result.rowCount;
  return 0;
}
