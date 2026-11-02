import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../application/create-wallet-error.js';
import type {
  CreateWalletRepositories,
  CreateWalletUnitOfWork,
  OpeningTransactionRecord,
  OpeningTransactionWriteRepository,
  WalletLedgerEntryWriteRepository,
  WalletWriteRepository,
} from '../../application/ports/create-wallet.persistence-port.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';

export class MikroOrmCreateWalletUnitOfWork implements CreateWalletUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  transactional<T>(work: (repositories: CreateWalletRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(async (entityManager) => {
      const repositories: CreateWalletRepositories = {
        wallets: new MikroOrmWalletWriteRepository(entityManager),
        openingTransactions: new MikroOrmOpeningTransactionWriteRepository(entityManager),
        ledgerEntries: new MikroOrmWalletLedgerEntryWriteRepository(entityManager),
      };

      return work(repositories);
    });
  }
}

class MikroOrmWalletWriteRepository implements WalletWriteRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.entityManager.execute(
        `insert into "wallets"
          ("id", "player_id", "currency", "balance_amount", "version", "created_at", "updated_at")
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
        'run',
      );
    } catch (error) {
      if (hasConstraint(error, 'wallets_player_currency_unique')) {
        throw new WalletAlreadyExistsError(
          `Wallet already exists for player ${wallet.playerId} and currency ${wallet.currency}.`,
        );
      }
      throw error;
    }
  }
}

class MikroOrmOpeningTransactionWriteRepository implements OpeningTransactionWriteRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(transaction: OpeningTransactionRecord): Promise<void> {
    await this.entityManager.execute(
      `insert into "wager_transactions"
        ("id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
         "wallet_id", "player_id", "round_id", "game_id", "kind", "amount", "currency",
         "status", "result_balance_amount", "processed_at", "created_at")
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        transaction.kind,
        transaction.money.toString(),
        transaction.money.currency,
        transaction.status,
        transaction.resultBalance.toString(),
        transaction.processedAt,
        transaction.createdAt,
      ],
      'run',
    );
  }
}

class MikroOrmWalletLedgerEntryWriteRepository implements WalletLedgerEntryWriteRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
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
  }
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
