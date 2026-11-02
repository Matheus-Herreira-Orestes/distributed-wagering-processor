import type { Money } from '../../shared/domain/money.js';
import { InsufficientFundsError } from '../../wallets/domain/wallet-error.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallets/domain/wallet-ledger-entry.js';
import {
  WagerFailureCode,
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  BetUniqueConstraintError,
  BetWalletMismatchError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  LedgerPersistenceConflictError,
  WalletNotFoundError,
} from './process-bet-error.js';
import type { ProcessBetUnitOfWork } from './ports/process-bet.persistence-port.js';
import type { ProcessBetRepositories } from './ports/process-bet.persistence-port.js';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/wager-integration-events.js';

export interface BetIdGenerator {
  generate(): string;
}

export interface BetClock {
  now(): Date;
}

export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: Money;
}

export interface ProcessBetResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: Money;
  failureCode?: string;
  idempotentReplay: boolean;
}

const defaultIdGenerator: BetIdGenerator = { generate: () => crypto.randomUUID() };
const defaultClock: BetClock = { now: () => new Date() };

export class ProcessBetUseCase {
  constructor(
    private readonly unitOfWork: ProcessBetUnitOfWork,
    private readonly idGenerator: BetIdGenerator = defaultIdGenerator,
    private readonly clock: BetClock = defaultClock,
  ) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetResult> {
    const payloadHash = await canonicalBetPayloadHash(input);

    try {
      return await this.processLocked(input, payloadHash);
    } catch (error) {
      if (!(error instanceof BetUniqueConstraintError)) {
        throw error;
      }
      if (error.constraint === 'PROVIDER_EXTERNAL_TRANSACTION') {
        throw new ExternalTransactionConflictError(
          `Provider transaction ${input.providerId}/${input.externalTransactionId} already exists.`,
        );
      }
      if (error.constraint === 'WALLET_LEDGER_TRANSACTION') {
        const recovered = await this.recoverPersistedResult(input, payloadHash);
        if (recovered !== null) {
          return recovered;
        }
        throw new LedgerPersistenceConflictError(
          `A ledger entry already exists for BET idempotency key ${input.idempotencyKey}.`,
        );
      }

      const recovered = await this.recoverPersistedResult(input, payloadHash);
      if (recovered === null) {
        throw new IdempotencyConflictError(
          `Idempotency key ${input.idempotencyKey} is occupied by a non-BET operation.`,
        );
      }
      return recovered;
    }
  }

  /** Runs the same BET rules inside a transaction already opened by an inbound adapter. */
  async executeInTransaction(
    input: ProcessBetInput,
    repositories: ProcessBetRepositories,
  ): Promise<ProcessBetResult> {
    return this.processWithRepositories(input, await canonicalBetPayloadHash(input), repositories);
  }

  private processLocked(input: ProcessBetInput, payloadHash: string): Promise<ProcessBetResult> {
    return this.unitOfWork.transactional(
      repositories => this.processWithRepositories(input, payloadHash, repositories),
    );
  }

  private async processWithRepositories(
    input: ProcessBetInput,
    payloadHash: string,
    repositories: ProcessBetRepositories,
  ): Promise<ProcessBetResult> {
      const wallet = await repositories.wallets.findByIdForUpdate(input.walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(`Wallet ${input.walletId} was not found.`);
      }
      this.assertWalletMatches(wallet, input);

      const existing = await repositories.transactions.findByIdempotencyKey(input.idempotencyKey);
      if (existing !== null) {
        return this.replay(existing, payloadHash);
      }
      const providerTransaction = await repositories.transactions.findByProviderExternal(
        input.providerId,
        input.externalTransactionId,
      );
      if (providerTransaction !== null) {
        throw new ExternalTransactionConflictError(
          `Provider transaction ${input.providerId}/${input.externalTransactionId} already exists.`,
        );
      }

      const now = this.clock.now();
      const transaction = WagerTransaction.createBet({
        id: this.idGenerator.generate(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        money: input.money,
        createdAt: now,
      });
      const balanceBefore = wallet.balance;

      try {
        wallet.debit(input.money, now);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) {
          throw error;
        }

        transaction.reject(WagerFailureCode.INSUFFICIENT_FUNDS, wallet.balance, now);
        await repositories.transactions.insert(transaction);
        await repositories.outbox.insert(new WagerTransactionRejected({
          eventId: crypto.randomUUID(),
          aggregateId: wallet.id,
          correlationId: transaction.id,
          causationId: transaction.idempotencyKey,
          data: {
            transactionId: transaction.id,
            walletId: wallet.id,
            playerId: transaction.playerId,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            money: transaction.money.toJSON(),
            resultBalance: wallet.balance.toJSON(),
            failureCode: WagerFailureCode.INSUFFICIENT_FUNDS,
          },
          occurredAt: now,
        }));
        return this.result(transaction, false);
      }

      transaction.markProcessed(wallet.balance, now);
      const ledgerEntry = WalletLedgerEntry.create({
        id: this.idGenerator.generate(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: LedgerDirection.DEBIT,
        money: input.money,
        balanceBefore,
        balanceAfter: wallet.balance,
        createdAt: now,
      });

      await repositories.wallets.update(wallet);
      await repositories.transactions.insert(transaction);
      await repositories.ledgerEntries.insert(ledgerEntry);
      await repositories.outbox.insert(new WagerTransactionProcessed({
        eventId: crypto.randomUUID(),
        aggregateId: wallet.id,
        correlationId: transaction.id,
        causationId: transaction.idempotencyKey,
        data: {
          transactionId: transaction.id,
          walletId: wallet.id,
          playerId: transaction.playerId,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          money: transaction.money.toJSON(),
          resultBalance: wallet.balance.toJSON(),
        },
        occurredAt: now,
      }));
      if (!balanceBefore.equals(wallet.balance)) {
        await repositories.outbox.insert(new WalletBalanceChanged({
          eventId: crypto.randomUUID(),
          aggregateId: wallet.id,
          correlationId: transaction.id,
          causationId: transaction.idempotencyKey,
          data: {
            transactionId: transaction.id,
            walletId: wallet.id,
            direction: 'DEBIT',
            money: input.money.toJSON(),
            balanceBefore: balanceBefore.toJSON(),
            balanceAfter: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
          occurredAt: now,
        }));
      }
      return this.result(transaction, false);
  }

  private recoverPersistedResult(
    input: ProcessBetInput,
    payloadHash: string,
  ): Promise<ProcessBetResult | null> {
    return this.unitOfWork.transactional(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(input.walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(`Wallet ${input.walletId} was not found.`);
      }
      this.assertWalletMatches(wallet, input);

      const existing = await repositories.transactions.findByIdempotencyKey(input.idempotencyKey);
      return existing === null ? null : this.replay(existing, payloadHash);
    });
  }

  private replay(transaction: WagerTransaction, payloadHash: string): ProcessBetResult {
    if (transaction.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(
        `Idempotency key ${transaction.idempotencyKey} was already used with a different payload.`,
      );
    }
    return this.result(transaction, true);
  }

  private result(transaction: WagerTransaction, idempotentReplay: boolean): ProcessBetResult {
    if ((transaction.status !== WagerTransactionStatus.PROCESSED && transaction.status !== WagerTransactionStatus.REJECTED) || transaction.resultBalance === null) {
      throw new Error(`Persisted BET transaction ${transaction.id} has no terminal result.`);
    }

    const base = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.resultBalance,
      idempotentReplay,
    };
    return transaction.failureCode === null
      ? base
      : { ...base, failureCode: transaction.failureCode };
  }

  private assertWalletMatches(
    wallet: { id: string; playerId: string; currency: string },
    input: ProcessBetInput,
  ): void {
    if (wallet.id !== input.walletId) {
      throw new BetWalletMismatchError('Loaded wallet does not match the requested wallet ID.');
    }
    if (wallet.playerId !== input.playerId) {
      throw new BetWalletMismatchError('BET player does not own the requested wallet.');
    }
    if (wallet.currency !== input.money.currency) {
      throw new BetWalletMismatchError(
        `BET currency ${input.money.currency} does not match wallet currency ${wallet.currency}.`,
      );
    }
  }
}

export async function canonicalBetPayloadHash(input: ProcessBetInput): Promise<string> {
  const canonicalPayload = canonicalJson({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    money: input.money.toJSON(),
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
