import type { Money } from '../../../shared/domain/money.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type { Wallet } from '../../domain/wallet.js';

export interface OpeningTransactionRecord {
  readonly id: string;
  readonly providerId: 'internal';
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: 'internal:wallet-opening';
  readonly gameId: 'internal:wallet-opening';
  readonly kind: 'OPENING';
  readonly money: Money;
  readonly status: 'PROCESSED';
  readonly resultBalance: Money;
  readonly processedAt: Date;
  readonly createdAt: Date;
}

export interface WalletWriteRepository {
  insert(wallet: Wallet): Promise<void>;
}

export interface OpeningTransactionWriteRepository {
  insert(transaction: OpeningTransactionRecord): Promise<void>;
}

export interface WalletLedgerEntryWriteRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface CreateWalletRepositories {
  readonly wallets: WalletWriteRepository;
  readonly openingTransactions: OpeningTransactionWriteRepository;
  readonly ledgerEntries: WalletLedgerEntryWriteRepository;
}

export interface CreateWalletUnitOfWork {
  transactional<T>(work: (repositories: CreateWalletRepositories) => Promise<T>): Promise<T>;
}
