import { Migration } from '@mikro-orm/migrations';

/** Durable scheduling state for REFUND/ROLLBACK messages delivered before their reference. */
export class Migration20261102000000_pending_reference_retry extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "wager_transactions"
      add column "reference_attempts" integer not null default 0 check ("reference_attempts" >= 0),
      add column "next_reference_attempt_at" timestamptz;`);
    this.addSql(`create index "wager_transactions_pending_reference_retry_idx"
      on "wager_transactions" ("next_reference_attempt_at", "created_at")
      where "status" = 'PENDING_REFERENCE';`);
  }
  override async down(): Promise<void> {
    this.addSql('drop index "wager_transactions_pending_reference_retry_idx";');
    this.addSql('alter table "wager_transactions" drop column "next_reference_attempt_at", drop column "reference_attempts";');
  }
}
