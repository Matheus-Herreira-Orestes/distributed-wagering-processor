# Architecture

## Current milestone

This repository deliberately implements only the foundation: a Bun/NestJS entry point, a pure `Money` value object, local PostgreSQL/SQS infrastructure, and the schema needed for the next vertical slices. It does **not** yet accept or process wagers.

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

MikroORM is selected for its explicit Unit of Work and transactional `EntityManager`. Future repositories will be adapters for application ports; domain objects will not be MikroORM entities.

## Messaging

LocalStack provides the two FIFO queues for local development. FIFO is helpful for transport, but never the source of financial correctness. The next messaging milestone will make inbox, financial writes, ledger, and outbox one SQL transaction; an outbox worker will publish only after commit.

## Authentication

Authentication is intentionally not implemented in this milestone. A future HTTP adapter will receive provider identity from an external OIDC IdP/guard, while health endpoints remain unauthenticated. No local password store will be introduced.
