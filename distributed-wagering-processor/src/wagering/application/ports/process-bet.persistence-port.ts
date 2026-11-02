import type { WalletLedgerEntry } from '../../../wallets/domain/wallet-ledger-entry.js';
import type { Wallet } from '../../../wallets/domain/wallet.js';
import type { WagerTransaction } from '../../domain/wager-transaction.js';
import type { IntegrationEvent } from '../../../messaging/domain/integration-event.js';

export interface BetWalletRepository {
  findByIdForUpdate(walletId: string): Promise<Wallet | null>;
  update(wallet: Wallet): Promise<void>;
}

export interface BetTransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
}

export interface BetLedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface BetOutboxRepository {
  insert(event: IntegrationEvent<object>): Promise<void>;
}

export interface ProcessBetRepositories {
  readonly wallets: BetWalletRepository;
  readonly transactions: BetTransactionRepository;
  readonly ledgerEntries: BetLedgerRepository;
  readonly outbox: BetOutboxRepository;
}

export interface ProcessBetUnitOfWork {
  transactional<T>(work: (repositories: ProcessBetRepositories) => Promise<T>): Promise<T>;
}
