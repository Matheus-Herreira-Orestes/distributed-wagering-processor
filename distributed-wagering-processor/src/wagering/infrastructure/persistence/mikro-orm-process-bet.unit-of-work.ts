import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/domain/money.js';
import type { WalletLedgerEntry } from '../../../wallets/domain/wallet-ledger-entry.js';
import { Wallet } from '../../../wallets/domain/wallet.js';
import {
  BetUniqueConstraintError,
  type BetUniqueConstraint,
} from '../../application/process-bet-error.js';
import type {
  BetLedgerRepository,
  BetOutboxRepository,
  BetTransactionRepository,
  BetWalletRepository,
  ProcessBetRepositories,
  ProcessBetUnitOfWork,
} from '../../application/ports/process-bet.persistence-port.js';
import type { IntegrationEvent } from '../../../messaging/domain/integration-event.js';
import {
  WagerTransaction,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  failure_code: string | null;
  result_balance_amount: string | null;
  processed_at: Date | null;
  created_at: Date;
}

export class MikroOrmProcessBetUnitOfWork implements ProcessBetUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  transactional<T>(work: (repositories: ProcessBetRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(
      entityManager => work(createMikroOrmProcessBetRepositories(entityManager)),
    );
  }
}

export function createMikroOrmProcessBetRepositories(
  entityManager: EntityManager,
): ProcessBetRepositories {
  return {
    wallets: new MikroOrmBetWalletRepository(entityManager),
    transactions: new MikroOrmBetTransactionRepository(entityManager),
    ledgerEntries: new MikroOrmBetLedgerRepository(entityManager),
    outbox: new MikroOrmBetOutboxRepository(entityManager),
  };
}

class MikroOrmBetWalletRepository implements BetWalletRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findByIdForUpdate(walletId: string): Promise<Wallet | null> {
    const rows = await this.entityManager.execute<WalletRow[]>(
      `select "id", "player_id", "currency", "balance_amount", "version", "created_at", "updated_at"
         from "wallets"
        where "id" = ?
        for update`,
      [walletId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({ amount: row.balance_amount, currency: row.currency }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  async update(wallet: Wallet): Promise<void> {
    await this.entityManager.execute(
      `update "wallets"
          set "balance_amount" = ?, "version" = ?, "updated_at" = ?
        where "id" = ?`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id],
      'run',
    );
  }
}

class MikroOrmBetTransactionRepository implements BetTransactionRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const rows = await this.entityManager.execute<WagerTransactionRow[]>(
      `select "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
              "wallet_id", "player_id", "round_id", "game_id", "amount", "currency", "status",
              "failure_code", "result_balance_amount", "processed_at", "created_at"
         from "wager_transactions"
        where "idempotency_key" = ? and "kind" = 'BET'`,
      [idempotencyKey],
    );
    return this.rehydrate(rows[0]);
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await this.entityManager.execute<WagerTransactionRow[]>(
      `select "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
              "wallet_id", "player_id", "round_id", "game_id", "amount", "currency", "status",
              "failure_code", "result_balance_amount", "processed_at", "created_at"
         from "wager_transactions"
        where "provider_id" = ? and "external_transaction_id" = ? and "kind" = 'BET'`,
      [providerId, externalTransactionId],
    );
    return this.rehydrate(rows[0]);
  }

  private rehydrate(row: WagerTransactionRow | undefined): WagerTransaction | null {
    if (row === undefined) {
      return null;
    }

    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      status: row.status,
      resultBalance: row.result_balance_amount === null
        ? null
        : Money.from({ amount: row.result_balance_amount, currency: row.currency }),
      failureCode: row.failure_code,
      processedAt: row.processed_at,
      createdAt: row.created_at,
    });
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.entityManager.execute(
        `insert into "wager_transactions"
          ("id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
           "wallet_id", "player_id", "round_id", "game_id", "kind", "amount", "currency",
           "status", "failure_code", "result_balance_amount", "processed_at", "created_at")
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', ?, ?, ?, ?, ?, ?, ?)`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.money.toString(),
          transaction.money.currency,
          transaction.status,
          transaction.failureCode,
          transaction.resultBalance?.toString() ?? null,
          transaction.processedAt,
          transaction.createdAt,
        ],
        'run',
      );
    } catch (error) {
      throw mapUniqueConstraint(error);
    }
  }
}

class MikroOrmBetLedgerRepository implements BetLedgerRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    try {
      await this.entityManager.execute(
        `insert into "wallet_ledger_entries"
          ("id", "wallet_id", "transaction_id", "direction", "amount", "currency",
           "balance_before", "balance_after", "created_at")
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.walletId,
          entry.transactionId,
          entry.direction,
          entry.money.toString(),
          entry.money.currency,
          entry.balanceBefore.toString(),
          entry.balanceAfter.toString(),
          entry.createdAt,
        ],
        'run',
      );
    } catch (error) {
      throw mapUniqueConstraint(error);
    }
  }
}

class MikroOrmBetOutboxRepository implements BetOutboxRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(event: IntegrationEvent<object>): Promise<void> {
    await this.entityManager.execute(
      `insert into "outbox_messages"
        ("id", "aggregate_id", "event_type", "payload", "occurred_at", "attempts")
       values (?, ?, ?, ?::jsonb, ?, 0)`,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
      ],
      'run',
    );
  }
}

function mapUniqueConstraint(error: unknown): unknown {
  const mappings: ReadonlyArray<[string, BetUniqueConstraint]> = [
    ['wager_transactions_idempotency_key_key', 'IDEMPOTENCY_KEY'],
    ['wager_transactions_provider_external_unique', 'PROVIDER_EXTERNAL_TRANSACTION'],
    ['wallet_ledger_entries_wallet_transaction_unique', 'WALLET_LEDGER_TRANSACTION'],
  ];
  for (const [databaseConstraint, applicationConstraint] of mappings) {
    if (hasConstraint(error, databaseConstraint)) {
      return new BetUniqueConstraintError(applicationConstraint);
    }
  }
  return error;
}

function hasConstraint(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('constraint' in current && current.constraint === constraint) {
      return true;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
