import { Migration } from '@mikro-orm/migrations';

/** Stores duplicate-delivery counts so observability survives process restarts. */
export class Migration20261103000000_observability extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table "inbox_messages" add column "duplicate_count" integer not null default 0 check ("duplicate_count" >= 0);');
  }

  override async down(): Promise<void> {
    this.addSql('alter table "inbox_messages" drop column "duplicate_count";');
  }
}
