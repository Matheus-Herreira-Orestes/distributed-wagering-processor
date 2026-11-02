import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config.js';
import { Money } from '../shared/domain/money.js';
import { CreateWalletUseCase, type CreateWalletInput, type CreateWalletResult } from '../wallets/application/create-wallet.use-case.js';
import { MikroOrmCreateWalletUnitOfWork } from '../wallets/infrastructure/persistence/mikro-orm-create-wallet.unit-of-work.js';
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionInput, type ProcessWagerTransactionResult } from '../wagering/application/process-wager-transaction.use-case.js';
import { MikroOrmProcessBetUnitOfWork } from '../wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';
import { createSqsClient, sqsConfigFromEnvironment } from '../messaging/infrastructure/sqs/sqs-config.js';
import { log, metrics } from '../observability.js';

@Injectable()
export class RuntimeService implements OnModuleDestroy {
  private ormPromise: Promise<MikroORM> | null = null;
  private readonly sqs = createSqsClient(sqsConfigFromEnvironment());
  private readonly sqsConfig = sqsConfigFromEnvironment();

  private orm(): Promise<MikroORM> {
    if (this.ormPromise === null) {
      this.ormPromise = MikroORM.init(config).catch(error => {
        // Do not permanently cache a failed database connection attempt. A
        // later readiness probe or request must be able to establish it again.
        this.ormPromise = null;
        throw error;
      });
    }
    return this.ormPromise;
  }
  async onModuleDestroy(): Promise<void> {
    this.sqs.destroy();
    const initializedOrm = this.ormPromise;
    this.ormPromise = null;
    if (initializedOrm !== null) {
      try {
        await (await initializedOrm).close(true);
      } catch {
        // There is nothing to close when initialization itself failed.
      }
    }
  }
  async createWallet(input: CreateWalletInput): Promise<CreateWalletResult> {
    return new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(await this.orm())).execute(input);
  }
  async processWager(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
    return new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(await this.orm())).execute(input);
  }

  async wallet(walletId: string): Promise<Record<string, unknown> | null> {
    const rows = await (await this.orm()).em.getConnection().execute<Array<{ id: string; player_id: string; currency: string; balance_amount: string; version: number }>>(
      'select id, player_id, currency, balance_amount, version from wallets where id = ?', [walletId],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, playerId: row.player_id, balance: { amount: row.balance_amount, currency: row.currency }, version: row.version };
  }
  async ledger(walletId: string, cursor?: string, limit = 50): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const bounded = Math.max(1, Math.min(limit, 100));
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await (await this.orm()).em.getConnection().execute<Array<Record<string, unknown>>>(
      `select id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         from wallet_ledger_entries where wallet_id = ? ${after === null ? '' : 'and (created_at, id) > (?, ?)'}
         order by created_at, id limit ?`, after === null ? [walletId, bounded + 1] : [walletId, after.createdAt, after.id, bounded + 1],
    );
    const page = rows.slice(0, bounded).map(row => ({ id: row.id, transactionId: row.transaction_id, direction: row.direction,
      money: { amount: row.amount, currency: row.currency }, balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, createdAt: row.created_at }));
    const next = rows[bounded];
    return { items: page, nextCursor: next === undefined ? null : encodeCursor({ createdAt: new Date(next.created_at as Date).toISOString(), id: String(next.id) }) };
  }
  async transaction(where: string, params: unknown[]): Promise<Record<string, unknown> | null> {
    const rows = await (await this.orm()).em.getConnection().execute<Array<Record<string, unknown>>>(
      `select id, provider_id, external_transaction_id, idempotency_key, wallet_id, player_id, round_id, game_id, kind,
              amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
              result_balance_amount, processed_at, created_at from wager_transactions where ${where}`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key, walletId: row.wallet_id, playerId: row.player_id, roundId: row.round_id,
      gameId: row.game_id, kind: row.kind, money: { amount: row.amount, currency: row.currency },
      referenceExternalTransactionId: row.reference_external_transaction_id, referenceTransactionId: row.reference_transaction_id,
      status: row.status, failureCode: row.failure_code, resultBalance: row.result_balance_amount === null ? null : { amount: row.result_balance_amount, currency: row.currency }, processedAt: row.processed_at, createdAt: row.created_at };
  }
  async reconcile(walletId: string): Promise<Record<string, unknown> | null> {
    const orm = await this.orm();
    return orm.em.transactional(async entityManager => {
      // Writers acquire FOR UPDATE on the same row, so this lock gives the
      // wallet and ledger aggregate one stable reconciliation point.
      const walletRows = await entityManager.execute<Array<{ id: string; currency: string; balance_amount: string }>>(
        'select id, currency, balance_amount from wallets where id = ? for share', [walletId],
      );
      const wallet = walletRows[0];
      if (wallet === undefined) return null;
      const rows = await entityManager.execute<Array<{ calculated: string; count: string }>>(
        `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as calculated,
                count(*)::text as count from wallet_ledger_entries where wallet_id = ?`, [walletId],
      );
      const calculated = Money.from({ amount: rows[0]?.calculated ?? '0.00', currency: wallet.currency });
      const stored = Money.from({ amount: wallet.balance_amount, currency: wallet.currency });
      const result = { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(), consistent: stored.equals(calculated), checkedEntries: Number(rows[0]?.count ?? '0') };
      if (!result.consistent) {
        metrics.increment('wallet_reconciliation_mismatches_total');
        log('wallet_reconciliation_mismatch', { walletId, checkedEntries: result.checkedEntries });
      }
      return result;
    });
  }

  async metricsSnapshot(): Promise<Record<string, number>> {
    const orm = await this.orm();
    const connection = orm.em.getConnection();
    const statusRows = await connection.execute<Array<{ status: string; count: string }>>(
      'select status, count(*)::text as count from wager_transactions group by status',
    );
    const summaryRows = await connection.execute<Array<{
      duplicates: string; outboxRetries: string; referenceRetries: string; outboxLagMs: string; processingLatencyMs: string; deadlocks: string;
    }>>(
      `select
         (select coalesce(sum(duplicate_count), 0)::text from inbox_messages) as duplicates,
         (select coalesce(sum(attempts), 0)::text from outbox_messages) as "outboxRetries",
         (select coalesce(sum(reference_attempts), 0)::text from wager_transactions) as "referenceRetries",
         (select coalesce(extract(epoch from now() - min(occurred_at)) * 1000, 0)::text from outbox_messages where published_at is null and failed_at is null) as "outboxLagMs",
         (select coalesce(avg(extract(epoch from processed_at - created_at) * 1000), 0)::text from wager_transactions where processed_at is not null) as "processingLatencyMs",
         (select deadlocks::text from pg_stat_database where datname = current_database()) as deadlocks`,
    );
    const snapshot: Record<string, number> = { ...metrics.snapshot() };
    for (const row of statusRows) snapshot[`wager_transactions_total{status=${row.status}}`] = Number(row.count);
    const summary = summaryRows[0];
    if (summary !== undefined) {
      snapshot.wager_duplicates_detected_total = Number(summary.duplicates);
      snapshot.outbox_publish_retries_total = Number(summary.outboxRetries);
      snapshot.pending_reference_retries_total = Number(summary.referenceRetries);
      snapshot.outbox_event_lag_ms = Number(summary.outboxLagMs);
      snapshot.wager_processing_latency_avg_ms = Number(summary.processingLatencyMs);
      snapshot.postgresql_deadlocks_total = Number(summary.deadlocks);
    }
    try {
      const response = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.sqsConfig.wagerDlqQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      snapshot.wager_dlq_visible_messages = Number(response.Attributes?.ApproximateNumberOfMessages ?? '0');
    } catch {
      snapshot.wager_dlq_metric_available = 0;
    }
    return snapshot;
  }
  async ready(): Promise<boolean> {
    try {
      await (await this.orm()).em.getConnection().execute('select 1');
      await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.sqsConfig.wagerQueueUrl, AttributeNames: ['QueueArn'] }));
      return true;
    } catch { return false; }
  }
}

interface LedgerCursor { createdAt: string; id: string; }
function encodeCursor(value: LedgerCursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LedgerCursor>;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string') throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new Error('Invalid ledger cursor.'); }
}
