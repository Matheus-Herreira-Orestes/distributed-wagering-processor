import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case.js';
import { log, metrics } from '../../../observability.js';

interface PendingRow { id: string; reference_attempts: number; }

/** Claims pending references durably; a restart simply lets the next scan continue from PostgreSQL. */
export class PendingReferenceWorker {
  constructor(
    private readonly orm: MikroORM,
    private readonly processor: ProcessWagerTransactionUseCase,
    private readonly maxAttempts = 10,
  ) {}

  async runOnce(now = new Date(), limit = 20): Promise<number> {
    const rows = await this.orm.em.transactional(entityManager => entityManager.execute<PendingRow[]>(
      `with candidates as (
         select id from wager_transactions
          where status = 'PENDING_REFERENCE'
            and (next_reference_attempt_at is null or next_reference_attempt_at <= ?)
          order by coalesce(next_reference_attempt_at, created_at), id
          for update skip locked limit ?
       ) update wager_transactions transaction
          set reference_attempts = transaction.reference_attempts + 1,
              next_reference_attempt_at = ?::timestamptz + (least(300000, 1000 * power(2, transaction.reference_attempts))) * interval '1 millisecond'
         from candidates where transaction.id = candidates.id
       returning transaction.id, transaction.reference_attempts`, [now, limit, now],
    ));
    for (const row of rows) {
      if (row.reference_attempts >= this.maxAttempts) {
        await this.processor.expirePendingReference(row.id);
        continue;
      }
      try {
        await this.processor.retryPending(row.id);
      } catch (error) {
        if (row.reference_attempts >= this.maxAttempts - 1) {
          await this.processor.failPendingReference(row.id);
          metrics.increment('pending_reference_processing_failures_total');
          log('pending_reference_processing_failed', { transactionId: row.id, attempts: row.reference_attempts });
          continue;
        }
        log('pending_reference_retry_failed', {
          transactionId: row.id,
          attempts: row.reference_attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows.length;
  }

  async run(signal: AbortSignal, idleDelayMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      if (await this.runOnce() === 0) await delay(idleDelayMs, signal);
    }
  }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const timeout = setTimeout(resolve, milliseconds); signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true }); });
}
