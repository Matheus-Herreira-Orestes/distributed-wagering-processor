# Jungle Gaming Distributed Wagering Processor

A strict TypeScript modular monolith for reliable wallet and wagering processing, built with Bun, NestJS, PostgreSQL, MikroORM, and LocalStack SQS.

## Current capabilities

- Framework-free `Money`, `Wallet`, `WalletLedgerEntry`, and `WagerTransaction` domain models
- Atomic wallet creation, including an opening transaction and credit ledger entry when the initial balance is positive
- Transaction-safe BET, WIN, LOSS, REFUND, and ROLLBACK processing with exact decimal money, persisted idempotency, and an immutable ledger
- Wallet-scoped PostgreSQL `SELECT ... FOR UPDATE` locking, allowing different wallets to process independently
- Persistent Inbox deduplication for every SQS wager request
- Transactional Outbox events for processed/rejected wagers and wallet balance changes
- Concurrent outbox publication using `FOR UPDATE SKIP LOCKED`, expiring claims, retries, and bounded exponential backoff
- PostgreSQL and LocalStack integration/concurrency tests
- HTTP wallet, transaction, ledger, reconciliation, liveness, readiness, and metrics endpoints

PostgreSQL is the financial source of truth. SQS FIFO ordering helps transport efficiency but is not relied upon for balance correctness or idempotency.

Authentication is intentionally left behind an explicit `ProviderIdentityPort` extension point. A production deployment should implement it with an external OIDC provider.

## Prerequisites

- Bun 1.x
- Docker Desktop with Docker Compose

The local defaults use:

- PostgreSQL: `127.0.0.1:5433`
- LocalStack: `127.0.0.1:4566`
- NestJS: `127.0.0.1:3000`

`SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS` configures how long received wager messages stay hidden while being processed. It defaults to 30 seconds and should be greater than the expected time to process and acknowledge a polled batch.

## Start locally

From `distributed-wagering-processor/`:

```powershell
Copy-Item .env.example .env
bun install
docker compose up -d
bun run migration:up
bun run dev
```

Open `http://localhost:3000/health/live` to check liveness.

Run the SQS consumer, outbox publisher, and pending-reference worker in a second terminal:

```powershell
bun run workers:messaging
```

Both commands run continuously. Press `Ctrl+C` before reusing their terminals.

## Local SQS queues

Docker initializes:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

The consumer expects this versioned provider message contract. `kind` accepts `BET`, `WIN`, `LOSS`, `REFUND`, or `ROLLBACK`; `REFUND` and `ROLLBACK` require `referenceExternalTransactionId`, while `WIN` can optionally reference the BET of the same round. `OPENING` is internal-only.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "00000000-0000-0000-0000-000000000001",
    "walletId": "00000000-0000-0000-0000-000000000002",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
        "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }
}
```

The provider `messageId` is the persistent Inbox identity. The transport-level SQS message ID is not used for financial deduplication.

Published events use this envelope:

```json
{
  "eventId": "event UUID",
  "eventType": "WagerTransactionProcessed",
  "aggregateId": "wallet UUID",
  "correlationId": "wager transaction UUID",
  "causationId": "provider idempotency key",
  "occurredAt": "2026-07-29T15:00:01.000Z",
  "version": 1,
  "data": {}
}
```

Outbox delivery is at-least-once. Downstream consumers must persistently deduplicate by `eventId`.

## HTTP API

- `POST /wallets`
- `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger?cursor=&limit=50`
- `POST /wagering/transactions` with mandatory `Idempotency-Key`
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `POST /wallets/:walletId/reconciliation`
- `GET /health/live`, `GET /health/ready`, and `GET /metrics`

## Reliability model

- Inbox registration, wallet mutation, wager transaction, ledger entry, and outbox events commit in one PostgreSQL transaction.
- SQS messages are acknowledged only after that transaction commits.
- Deterministic contract/domain failures are terminal and acknowledged; infrastructure or unexpected failures remain available for retry and eventual DLQ delivery.
- Outbox events are published only after the financial transaction commits.
- REFUND and ROLLBACK received before their reference are persisted as `PENDING_REFERENCE`; a durable worker retries with backoff and finally rejects them as `REFERENCE_NOT_FOUND`.
- A referenced WIN also waits for a missing or pending BET. The pending-reference worker uses ten attempts with exponential backoff capped at five minutes.
- A publisher crash after sending but before recording `published_at` can cause redelivery, so exactly-once SQS delivery is not claimed.
- `GET /metrics` derives durable transaction, duplicate, retry, latency, outbox-lag, DLQ-depth, and PostgreSQL-deadlock metrics from PostgreSQL and SQS; it does not depend on a worker process's memory.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full concurrency and delivery design.

## Commands

```powershell
# Unit tests only
bun test test/unit

# PostgreSQL and LocalStack integration tests
bun run test:integration

# Complete test suite
bun test

# Strict TypeScript validation
bun run typecheck

# Migration status and execution
bun run migration:pending
bun run migration:up
bun run migration:down
```

Integration tests require the Docker services to be running. `migration:down` reverses only the latest migration and should be used against a disposable local database.

Migrations execute directly through Bun rather than the MikroORM CLI. Because the configuration uses `migrationsList`, every new migration must be imported and registered explicitly in `mikro-orm.config.ts`.

## Project structure

```text
src/
  interfaces/       HTTP adapters
  messaging/        Inbox, Outbox, SQS consumer, and publisher
  shared/domain/    Shared framework-free domain types
  wagering/         BET domain, application, and persistence code
  wallets/          Wallet domain, application, and persistence code
migrations/         Reversible PostgreSQL schema migrations
scripts/            Bun migration and messaging-worker entry points
test/
  unit/
  integration/
```

Dependencies point inward: interfaces and infrastructure depend on application ports and domain behavior. Domain classes do not import NestJS, MikroORM, PostgreSQL, HTTP, or AWS SDK code.
