import type { Money } from '../../shared/domain/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/wallet-ledger-entry.js';
import { Wallet } from '../domain/wallet.js';
import type {
  CreateWalletUnitOfWork,
  OpeningTransactionRecord,
} from './ports/create-wallet.persistence-port.js';

export interface IdGenerator {
  generate(): string;
}

export interface Clock {
  now(): Date;
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
}

export interface CreateWalletResult {
  wallet: Wallet;
  openingTransactionId: string | null;
  ledgerEntryId: string | null;
}

const cryptoIdGenerator: IdGenerator = {
  generate: () => crypto.randomUUID(),
};

const systemClock: Clock = {
  now: () => new Date(),
};

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: CreateWalletUnitOfWork,
    private readonly idGenerator: IdGenerator = cryptoIdGenerator,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    const createdAt = this.clock.now();
    const wallet = Wallet.open({
      id: this.idGenerator.generate(),
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      openedAt: createdAt,
    });

    const opening = !input.initialBalance.isZero()
      ? await this.createOpeningRecords(wallet, createdAt)
      : null;

    await this.unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insert(wallet);

      if (opening !== null) {
        await repositories.openingTransactions.insert(opening.transaction);
        await repositories.ledgerEntries.insert(opening.ledgerEntry);
      }
    });

    return {
      wallet,
      openingTransactionId: opening?.transaction.id ?? null,
      ledgerEntryId: opening?.ledgerEntry.id ?? null,
    };
  }

  private async createOpeningRecords(
    wallet: Wallet,
    createdAt: Date,
  ): Promise<{ transaction: OpeningTransactionRecord; ledgerEntry: WalletLedgerEntry }> {
    const transactionId = this.idGenerator.generate();
    const externalTransactionId = `wallet-opening:${wallet.id}`;
    const transaction: OpeningTransactionRecord = {
      id: transactionId,
      providerId: 'internal',
      externalTransactionId,
      idempotencyKey: `internal:${externalTransactionId}`,
      payloadHash: await sha256(JSON.stringify({
        kind: 'OPENING',
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: wallet.balance.toString(),
        currency: wallet.currency,
      })),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'internal:wallet-opening',
      gameId: 'internal:wallet-opening',
      kind: 'OPENING',
      money: wallet.balance,
      status: 'PROCESSED',
      resultBalance: wallet.balance,
      processedAt: new Date(createdAt),
      createdAt: new Date(createdAt),
    };

    const ledgerEntry = WalletLedgerEntry.create({
      id: this.idGenerator.generate(),
      walletId: wallet.id,
      transactionId,
      direction: LedgerDirection.CREDIT,
      money: wallet.balance,
      balanceBefore: wallet.balance.subtract(wallet.balance),
      balanceAfter: wallet.balance,
      createdAt,
    });

    return { transaction, ledgerEntry };
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
