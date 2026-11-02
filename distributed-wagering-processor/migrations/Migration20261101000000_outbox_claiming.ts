import { Migration } from '@mikro-orm/migrations';

/** Adds durable outbox leases and a terminal failure state for concurrent publishers. */
export class Migration20261101000000_outbox_claiming extends Migration {
  override async up(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_pending_idx";');
    this.addSql(`alter table "outbox_messages"
      add column "claimed_at" timestamptz,
      add column "claimed_by" varchar(128),
      add column "claim_expires_at" timestamptz,
      add column "last_error" text,
      add column "failed_at" timestamptz,
      add constraint "outbox_messages_claim_consistency" check (
        ("claimed_at" is null and "claimed_by" is null and "claim_expires_at" is null) or
        ("claimed_at" is not null and "claimed_by" is not null and "claim_expires_at" is not null)
      );`);
    this.addSql(`create index "outbox_messages_pending_idx"
      on "outbox_messages" ("next_attempt_at", "occurred_at")
      where "published_at" is null and "failed_at" is null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_pending_idx";');
    this.addSql('alter table "outbox_messages" drop constraint "outbox_messages_claim_consistency";');
    this.addSql(`alter table "outbox_messages"
      drop column "claimed_at",
      drop column "claimed_by",
      drop column "claim_expires_at",
      drop column "last_error",
      drop column "failed_at";`);
    this.addSql(`create index "outbox_messages_pending_idx"
      on "outbox_messages" ("next_attempt_at", "occurred_at")
      where "published_at" is null;`);
  }
}
