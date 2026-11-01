import { Migration } from '@mikro-orm/migrations';

/** Initial schema only: domain behaviour and adapters are added in later milestones. */
export class Migration20261031000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "wallets" (
      "id" uuid primary key,
      "player_id" uuid not null,
      "currency" char(3) not null check ("currency" ~ '^[A-Z]{3}$'),
      "balance_amount" numeric(20,2) not null check ("balance_amount" >= 0),
      "version" integer not null check ("version" >= 1),
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null,
      constraint "wallets_player_currency_unique" unique ("player_id", "currency")
    );`);

    this.addSql(`create table "wager_transactions" (
      "id" uuid primary key,
      "provider_id" varchar(128) not null,
      "external_transaction_id" varchar(256) not null,
      "idempotency_key" varchar(384) not null unique,
      "payload_hash" char(64) not null,
      "wallet_id" uuid not null references "wallets" ("id"),
      "player_id" uuid not null,
      "round_id" varchar(256) not null,
      "game_id" varchar(256) not null,
      "kind" varchar(32) not null check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
      "amount" numeric(20,2) not null check ("amount" >= 0),
      "currency" char(3) not null check ("currency" ~ '^[A-Z]{3}$'),
      "reference_external_transaction_id" varchar(256),
      "reference_transaction_id" uuid references "wager_transactions" ("id"),
      "status" varchar(32) not null check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
      "failure_code" varchar(128),
      "result_balance_amount" numeric(20,2) check ("result_balance_amount" >= 0),
      "processed_at" timestamptz,
      "created_at" timestamptz not null,
      constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id")
    );`);
    this.addSql('create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("status", "created_at") where "status" = \'PENDING_REFERENCE\';');

    this.addSql(`create table "wallet_ledger_entries" (
      "id" uuid primary key,
      "wallet_id" uuid not null references "wallets" ("id"),
      "transaction_id" uuid not null references "wager_transactions" ("id"),
      "direction" varchar(6) not null check ("direction" in ('DEBIT', 'CREDIT')),
      "amount" numeric(20,2) not null check ("amount" >= 0),
      "currency" char(3) not null check ("currency" ~ '^[A-Z]{3}$'),
      "balance_before" numeric(20,2) not null check ("balance_before" >= 0),
      "balance_after" numeric(20,2) not null check ("balance_after" >= 0),
      "created_at" timestamptz not null,
      constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
      constraint "wallet_ledger_entries_arithmetic_check" check (
        ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
        ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
      )
    );`);
    this.addSql('create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");');
    this.addSql(`create function reject_wallet_ledger_mutation() returns trigger language plpgsql as $$
      begin raise exception 'wallet ledger entries are immutable'; end;
    $$;`);
    this.addSql('create trigger "wallet_ledger_entries_immutable" before update or delete on "wallet_ledger_entries" for each row execute function reject_wallet_ledger_mutation();');

    this.addSql(`create table "inbox_messages" (
      "consumer_name" varchar(128) not null,
      "message_id" varchar(256) not null,
      "payload_hash" char(64) not null,
      "received_at" timestamptz not null,
      "processed_at" timestamptz,
      primary key ("consumer_name", "message_id")
    );`);

    this.addSql(`create table "outbox_messages" (
      "id" uuid primary key,
      "aggregate_id" uuid not null,
      "event_type" varchar(128) not null,
      "payload" jsonb not null,
      "occurred_at" timestamptz not null,
      "attempts" integer not null default 0 check ("attempts" >= 0),
      "next_attempt_at" timestamptz,
      "published_at" timestamptz
    );`);
    this.addSql('create index "outbox_messages_pending_idx" on "outbox_messages" ("next_attempt_at", "occurred_at") where "published_at" is null;');
  }

  override async down(): Promise<void> {
    this.addSql('drop table "outbox_messages";');
    this.addSql('drop table "inbox_messages";');
    this.addSql('drop trigger "wallet_ledger_entries_immutable" on "wallet_ledger_entries";');
    this.addSql('drop function reject_wallet_ledger_mutation();');
    this.addSql('drop table "wallet_ledger_entries";');
    this.addSql('drop table "wager_transactions";');
    this.addSql('drop table "wallets";');
  }
}
