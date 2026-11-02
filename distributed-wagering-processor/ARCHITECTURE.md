# Architecture

## Current milestone

The service implements the framework-free `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, and integration-event models. `ProcessWagerTransactionUseCase` handles BET, WIN, LOSS, REFUND, and ROLLBACK in PostgreSQL transactions. Wallet creation and financial processing combine a wallet-scoped `SELECT ... FOR UPDATE`, persistent idempotency, and the immutable wallet ledger.

REFUND and ROLLBACK with a missing reference are durably persisted as `PENDING_REFERENCE`. A WIN may optionally reference a BET; when supplied, it is validated against the same provider, player, wallet, currency, and round. A dependent operation also remains pending while its referenced operation is pending. A separate worker claims due rows with `SKIP LOCKED`, retries ten times with exponential backoff capped at five minutes, and turns exhausted rows into an auditable `REFERENCE_NOT_FOUND` rejection.

## Shape

This is a **modular monolith**. It deploys as one NestJS process, while its source is divided by capability (`wallets`, `wagering`, `messaging`) and by layer. The domain layer must not import NestJS, MikroORM, AWS, or HTTP code.

Within a capability, dependencies point inward:

```text
interfaces (HTTP / SQS) -> application (use cases / ports) -> domain
infrastructure (MikroORM / SQS) --------------------------^ implements ports
```

`src/shared/domain/Money` is the first example: it is framework-free and uses `decimal.js` to avoid binary floating-point arithmetic.

## Persistence and concurrency

PostgreSQL is the authority for balance, idempotency, and ledger invariants. The initial migration establishes database constraints for non-negative balances, unique wallet and transaction identities, ledger arithmetic, and ledger immutability. The wager-processing milestone will use a transaction plus a wallet-scoped PostgreSQL row lock (`FOR UPDATE` via MikroORM) so separate wallets remain parallel without a global lock.

The wallet row is the concurrency unit for financial changes. BET processing locks only its target wallet with `SELECT ... FOR UPDATE`, then reloads the balance and persisted transaction state inside the same SQL transaction. Requests for one wallet serialize around that row, while unrelated wallets retain PostgreSQL's normal parallelism; there is no process-wide lock or in-memory mutex.

PostgreSQL provides the final correctness guarantees. Row locks prevent lost balance updates, unique constraints arbitrate idempotency and provider-transaction races across application instances, and the persisted payload hash distinguishes a replay from an idempotency conflict. Wallet updates, wager transactions, and ledger entries commit or roll back together. Application memory can improve throughput, but it is never authoritative for money or idempotency.

The current persistence adapters use parameterized SQL through MikroORM's transactional `EntityManager` and implement application ports. Domain classes remain independent from MikroORM and have no ORM decorators.

The MikroORM configuration intentionally uses `migrationsList` so TypeScript migrations load reliably when the migration runner executes directly through Bun on Windows. Every future migration must be imported and added explicitly to that list.

## Messaging

LocalStack provides the wager FIFO queue, its dead-letter queue, and the integration-event FIFO queue for local development. The SQS consumer uses the provider's body-level `messageId`—not the transport-level SQS `MessageId`—as the `(consumer_name, message_id)` inbox identity. It invokes the shared `ProcessWagerTransactionUseCase`, marks the inbox row processed, and writes transaction, wallet, ledger, and outbox state in one PostgreSQL transaction. A duplicate provider message ID therefore cannot repeat the financial effect.

Malformed contracts and deterministic domain/application failures are terminal. Valid messages that reach such a failure persist their processed inbox outcome before SQS acknowledgment; malformed messages are acknowledged without financial processing. PostgreSQL, SQS, network, timeout, and unexpected failures remain transient: they escape the consumer without acknowledgment so SQS can retry and eventually apply its DLQ policy.

The outbox publisher claims eligible rows with `FOR UPDATE SKIP LOCKED` and persists a worker identity plus an expiring lease. Multiple publishers can work concurrently without claiming the same row. A confirmed SQS send is followed by `published_at`; failed sends increment `attempts`, store the error, and schedule bounded exponential backoff. Rows that reach the configured attempt limit enter a terminal `failed_at` state instead of looping forever.

Every published event uses the versioned `eventId`, `eventType`, `aggregateId`, `correlationId`, optional `causationId`, `occurredAt`, `version`, and `data` envelope. Wager events use the wager transaction ID as their stable correlation ID and the wager idempotency key as causation ID. Monetary event data contains serialized `MoneyProps`, never domain `Money` objects.

Publication is at-least-once, not exactly-once. A publisher can die after SQS accepts an event but before PostgreSQL records `published_at`; after the lease expires another publisher may send that event again. Every downstream consumer must persistently deduplicate by `eventId`, which is also the FIFO `MessageDeduplicationId`.

FIFO ordering helps reduce avoidable contention and out-of-order delivery, but it is not the financial source of truth. Correctness still holds for retries, duplicate delivery, multiple consumers, and direct concurrent calls because PostgreSQL row locks, constraints, the inbox, persisted BET idempotency, and the immutable ledger remain authoritative.

## Reconciliation and observability

Reconciliation acquires a PostgreSQL shared lock on the wallet row before reading its ledger, so a writer cannot commit a balance movement between the two reads. A divergence is returned to the caller, emitted as a structured log, and counted in `wallet_reconciliation_mismatches_total`; it is never corrected automatically.

The HTTP metrics endpoint derives cross-process values from durable PostgreSQL state and SQS: wagers by status, inbox duplicates, outbox and pending-reference retries, outbox lag, processing latency, visible DLQ messages, and PostgreSQL deadlocks. Process-local counters remain useful for short-lived request diagnostics but are not the source of worker metrics.

## Authentication

Authentication is intentionally not implemented. `ProviderIdentityPort` is the explicit code-level extension point for an external OIDC IdP/guard; health endpoints remain unauthenticated. No local password store is introduced.
