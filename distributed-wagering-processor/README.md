# Jungle Gaming Distributed Wagering Processor

Foundation for the Jungle Gaming technical challenge, built as a strict TypeScript modular monolith with Bun, NestJS, PostgreSQL, LocalStack SQS, and MikroORM.

## What is implemented now

- `Money`, an immutable, exact value object with two-decimal external contracts and currency checks
- Bun unit tests for `Money`
- reversible MikroORM initial migration with financial database constraints
- Docker Compose services for PostgreSQL and LocalStack SQS FIFO queues
- a minimal NestJS liveness endpoint: `GET /health/live`

Wager processing, wallet use cases, HTTP contracts, inbox/outbox workers, and authentication are intentionally deferred to later vertical slices.

## Prerequisites

- Bun 1.x
- Docker Desktop with Docker Compose

## Start locally

```sh
cp .env.example .env
docker compose up -d
bun install
bun run migration:up
bun run dev
```

Then open `http://localhost:3000/health/live`.

## Useful commands

```sh
bun test
bun run typecheck
bun run migration:pending
bun run migration:down
```

`migration:down` reverses the latest migration and is intended for a disposable local database.

## Next slice

Implement the `Wallet` aggregate, its opening ledger entry, and a single transactional `CreateWallet` use case before adding wager processing or SQS consumers.
