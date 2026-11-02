import type { Money } from '../../shared/domain/money.js';
import { InsufficientFundsError } from '../../wallets/domain/wallet-error.js';
import { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry.js';
import {
  WagerFailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '../domain/wager-integration-events.js';
import {
  BetUniqueConstraintError, BetWalletMismatchError, ExternalTransactionConflictError, IdempotencyConflictError,
  LedgerPersistenceConflictError, WalletNotFoundError,
} from './process-bet-error.js';
import type { ProcessBetRepositories, ProcessBetUnitOfWork } from './ports/process-bet.persistence-port.js';
import { metrics } from '../../observability.js';

export interface WagerIdGenerator { generate(): string; }
export interface WagerClock { now(): Date; }
export interface ProcessWagerTransactionInput {
  providerId: string; externalTransactionId: string; idempotencyKey: string; playerId: string;
  walletId: string; roundId: string; gameId: string; kind: WagerTransactionKind; money: Money;
  referenceExternalTransactionId?: string;
}
export interface ProcessWagerTransactionResult {
  transactionId: string; status: WagerTransactionStatus; balance: Money; failureCode?: string;
  idempotentReplay: boolean;
}
const ids: WagerIdGenerator = { generate: () => crypto.randomUUID() };
const clock: WagerClock = { now: () => new Date() };

/** Shared command handler used by both HTTP and SQS. PostgreSQL remains the concurrency authority. */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: ProcessBetUnitOfWork,
    private readonly idGenerator: WagerIdGenerator = ids,
    private readonly currentClock: WagerClock = clock,
  ) {}

  async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
    const hash = await canonicalWagerPayloadHash(input);
    try {
      return await this.unitOfWork.transactional(repositories => this.process(input, hash, repositories));
    } catch (error) {
      if (!(error instanceof BetUniqueConstraintError)) throw error;
      metrics.increment('wager_persistence_conflicts_total', { constraint: error.constraint });
      if (error.constraint === 'PROVIDER_EXTERNAL_TRANSACTION') {
        throw new ExternalTransactionConflictError(`Provider transaction ${input.providerId}/${input.externalTransactionId} already exists.`);
      }
      const recovered = await this.unitOfWork.transactional(async repositories => {
        const wallet = await repositories.wallets.findByIdForUpdate(input.walletId);
        if (wallet === null) throw new WalletNotFoundError(`Wallet ${input.walletId} was not found.`);
        this.assertWalletMatches(wallet, input);
        const existing = await repositories.transactions.findByIdempotencyKey(input.idempotencyKey);
        return existing === null ? null : this.replay(existing, hash, wallet.balance);
      });
      if (recovered !== null) return recovered;
      throw error.constraint === 'WALLET_LEDGER_TRANSACTION'
        ? new LedgerPersistenceConflictError(`A ledger entry already exists for wager idempotency key ${input.idempotencyKey}.`)
        : new IdempotencyConflictError(`Idempotency key ${input.idempotencyKey} is occupied by a different transaction.`);
    }
  }

  async executeInTransaction(input: ProcessWagerTransactionInput, repositories: ProcessBetRepositories): Promise<ProcessWagerTransactionResult> {
    return this.process(input, await canonicalWagerPayloadHash(input), repositories);
  }

  /** Used by the scheduled worker after a previously missing reference may have arrived. */
  async retryPending(transactionId: string): Promise<ProcessWagerTransactionResult | null> {
    return this.unitOfWork.transactional(async repositories => {
      const transaction = await repositories.transactions.findByIdForUpdate?.(transactionId);
      if (transaction === undefined || transaction === null || transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) return null;
      transaction.resumePendingReference();
      return this.process({ providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey, playerId: transaction.playerId, walletId: transaction.walletId,
        roundId: transaction.roundId, gameId: transaction.gameId, kind: transaction.kind, money: transaction.money,
        ...(transaction.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }) },
      transaction.payloadHash, repositories, transaction);
    });
  }

  async expirePendingReference(transactionId: string): Promise<ProcessWagerTransactionResult | null> {
    return this.unitOfWork.transactional(async repositories => {
      const transaction = await repositories.transactions.findByIdForUpdate?.(transactionId);
      if (transaction === undefined || transaction === null || transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) return null;
      const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
      if (wallet === null) throw new WalletNotFoundError(`Wallet ${transaction.walletId} was not found.`);
      transaction.resumePendingReference();
      return this.reject(transaction, wallet.balance, WagerFailureCode.REFERENCE_NOT_FOUND, this.currentClock.now(), repositories, true);
    });
  }

  /** Persists an unrecoverable pending-reference processing failure for audit and reconciliation. */
  async failPendingReference(transactionId: string): Promise<ProcessWagerTransactionResult | null> {
    return this.unitOfWork.transactional(async repositories => {
      const transaction = await repositories.transactions.findByIdForUpdate?.(transactionId);
      if (transaction === undefined || transaction === null || transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) return null;
      const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
      if (wallet === null) throw new WalletNotFoundError(`Wallet ${transaction.walletId} was not found.`);
      transaction.resumePendingReference();
      transaction.fail(WagerFailureCode.REFERENCE_PROCESSING_FAILED, wallet.balance, this.currentClock.now());
      await this.save(transaction, repositories, true);
      return this.result(transaction, wallet.balance, false);
    });
  }

  private async process(input: ProcessWagerTransactionInput, payloadHash: string, repositories: ProcessBetRepositories, existingPending?: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    const wallet = await repositories.wallets.findByIdForUpdate(input.walletId);
    if (wallet === null) throw new WalletNotFoundError(`Wallet ${input.walletId} was not found.`);
    this.assertWalletMatches(wallet, input);
    const existing = existingPending === undefined ? await repositories.transactions.findByIdempotencyKey(input.idempotencyKey) : null;
    if (existing !== null) return this.replay(existing, payloadHash, wallet.balance);
    if (existingPending === undefined && await repositories.transactions.findByProviderExternal(input.providerId, input.externalTransactionId) !== null) {
      throw new ExternalTransactionConflictError(`Provider transaction ${input.providerId}/${input.externalTransactionId} already exists.`);
    }

    const now = this.currentClock.now();
    const transaction = existingPending ?? WagerTransaction.create({ ...input, id: this.idGenerator.generate(), payloadHash, createdAt: now });
    let reference: WagerTransaction | null = null;
    if (this.shouldResolveReference(transaction)) {
      reference = await repositories.transactions.findByProviderExternal(input.providerId, input.referenceExternalTransactionId!);
      if (reference === null || this.isAwaitingReference(reference)) {
        return this.pendingReference(transaction, wallet, input.referenceExternalTransactionId!, now, repositories, existingPending !== undefined);
      }
      if (!this.validReference(transaction, reference)) {
        return this.reject(transaction, wallet.balance, WagerFailureCode.INVALID_REFERENCE,
          now, repositories, existingPending !== undefined);
      }
      const previousReversal = transaction.requiresReference
        ? await repositories.transactions.findByReferenceAndKind?.(reference.id, transaction.kind)
        : null;
      if (previousReversal !== undefined && previousReversal !== null) {
        return this.reject(transaction, wallet.balance, WagerFailureCode.REFERENCE_ALREADY_REVERSED,
          now, repositories, existingPending !== undefined);
      }
    }

    const direction = transaction.ledgerDirectionFor(reference ?? undefined);
    const balanceBefore = wallet.balance;
    try {
      if (direction?.toString() === 'DEBIT') wallet.debit(transaction.money, now);
      if (direction?.toString() === 'CREDIT') wallet.credit(transaction.money, now);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      const code = transaction.kind === WagerTransactionKind.ROLLBACK
        ? WagerFailureCode.REVERSAL_WOULD_OVERDRAW : WagerFailureCode.INSUFFICIENT_FUNDS;
      return this.reject(transaction, wallet.balance, code, now, repositories, existingPending !== undefined);
    }

    transaction.markProcessed(wallet.balance, now, reference?.id ?? null);
    // The ledger has a foreign key to wager_transactions. Persist the
    // transaction first; the surrounding SQL transaction still makes both
    // writes atomic with the wallet update and outbox events.
    await this.save(transaction, repositories, existingPending !== undefined);
    if (direction !== null) {
      await repositories.wallets.update(wallet);
      await repositories.ledgerEntries.insert(WalletLedgerEntry.create({
        id: this.idGenerator.generate(), walletId: wallet.id, transactionId: transaction.id, direction,
        money: transaction.money, balanceBefore, balanceAfter: wallet.balance, createdAt: now,
      }));
    }
    await repositories.outbox.insert(this.processedEvent(transaction, wallet.id, now));
    if (direction !== null) await repositories.outbox.insert(new WalletBalanceChanged({
      eventId: crypto.randomUUID(), aggregateId: wallet.id, correlationId: transaction.id, causationId: transaction.idempotencyKey, occurredAt: now,
      data: { transactionId: transaction.id, walletId: wallet.id, direction, money: transaction.money.toJSON(),
        balanceBefore: balanceBefore.toJSON(), balanceAfter: wallet.balance.toJSON(), walletVersion: wallet.version },
    }));
    return this.result(transaction, wallet.balance, false);
  }

  private validReference(transaction: WagerTransaction, reference: WagerTransaction): boolean {
    const allowed = transaction.kind === WagerTransactionKind.REFUND || transaction.kind === WagerTransactionKind.WIN
      ? reference.kind === WagerTransactionKind.BET
      : transaction.kind === WagerTransactionKind.ROLLBACK
        && (reference.kind === WagerTransactionKind.BET || reference.kind === WagerTransactionKind.WIN || reference.kind === WagerTransactionKind.REFUND);
    return allowed && reference.status === WagerTransactionStatus.PROCESSED && reference.walletId === transaction.walletId
      && reference.playerId === transaction.playerId && reference.roundId === transaction.roundId
      && reference.money.currency === transaction.money.currency
      && (transaction.kind === WagerTransactionKind.WIN || reference.money.equals(transaction.money));
  }
  private shouldResolveReference(transaction: WagerTransaction): boolean {
    return transaction.requiresReference
      || (transaction.kind === WagerTransactionKind.WIN && transaction.referenceExternalTransactionId !== null);
  }
  private isAwaitingReference(transaction: WagerTransaction): boolean {
    return transaction.status === WagerTransactionStatus.PENDING
      || transaction.status === WagerTransactionStatus.PENDING_REFERENCE;
  }
  private async pendingReference(
    transaction: WagerTransaction,
    wallet: { id: string; balance: Money },
    referenceExternalTransactionId: string,
    at: Date,
    repositories: ProcessBetRepositories,
    update: boolean,
  ): Promise<ProcessWagerTransactionResult> {
    transaction.markPendingReference();
    await this.save(transaction, repositories, update);
    if (!update) {
      await repositories.outbox.insert(new WagerTransactionPendingReference({
        eventId: crypto.randomUUID(), aggregateId: wallet.id, correlationId: transaction.id,
        causationId: transaction.idempotencyKey, occurredAt: at,
        data: { transactionId: transaction.id, walletId: wallet.id, providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId, referenceExternalTransactionId,
          kind: transaction.kind as 'WIN' | 'REFUND' | 'ROLLBACK' },
      }));
    }
    return this.result(transaction, wallet.balance, false);
  }
  private async reject(transaction: WagerTransaction, balance: Money, code: WagerFailureCode, at: Date, repositories: ProcessBetRepositories, update = false): Promise<ProcessWagerTransactionResult> {
    transaction.reject(code, balance, at);
    await this.save(transaction, repositories, update);
    await repositories.outbox.insert(new WagerTransactionRejected({
      eventId: crypto.randomUUID(), aggregateId: transaction.walletId, correlationId: transaction.id, causationId: transaction.idempotencyKey, occurredAt: at,
      data: { transactionId: transaction.id, walletId: transaction.walletId, playerId: transaction.playerId,
        providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
        money: transaction.money.toJSON(), resultBalance: balance.toJSON(), failureCode: code, kind: transaction.kind },
    }));
    return this.result(transaction, balance, false);
  }
  private async save(transaction: WagerTransaction, repositories: ProcessBetRepositories, update: boolean): Promise<void> {
    if (update) {
      if (repositories.transactions.update === undefined) throw new Error('Pending-reference retries require transaction updates.');
      await repositories.transactions.update(transaction);
      return;
    }
    await repositories.transactions.insert(transaction);
  }
  private processedEvent(transaction: WagerTransaction, walletId: string, at: Date): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ eventId: crypto.randomUUID(), aggregateId: walletId, correlationId: transaction.id,
      causationId: transaction.idempotencyKey, occurredAt: at, data: { transactionId: transaction.id, walletId,
        playerId: transaction.playerId, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
        money: transaction.money.toJSON(), resultBalance: transaction.resultBalance!.toJSON(), kind: transaction.kind } });
  }
  private replay(transaction: WagerTransaction, hash: string, balance: Money): ProcessWagerTransactionResult {
    if (!transaction.matchesPayload(hash)) throw new IdempotencyConflictError(`Idempotency key ${transaction.idempotencyKey} was already used with a different payload.`);
    return this.result(transaction, balance, true);
  }
  private result(transaction: WagerTransaction, fallbackBalance: Money, idempotentReplay: boolean): ProcessWagerTransactionResult {
    const base = { transactionId: transaction.id, status: transaction.status, balance: transaction.resultBalance ?? fallbackBalance, idempotentReplay };
    return transaction.failureCode === null ? base : { ...base, failureCode: transaction.failureCode };
  }
  private assertWalletMatches(wallet: { id: string; playerId: string; currency: string }, input: ProcessWagerTransactionInput): void {
    if (wallet.id !== input.walletId || wallet.playerId !== input.playerId || wallet.currency !== input.money.currency) {
      throw new BetWalletMismatchError('Wager player, wallet, or currency does not match the wallet.');
    }
  }
}

export async function canonicalWagerPayloadHash(input: ProcessWagerTransactionInput): Promise<string> {
  return sha256(canonicalJson({ externalTransactionId: input.externalTransactionId, gameId: input.gameId,
    kind: input.kind, money: input.money.toJSON(), playerId: input.playerId, providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null, roundId: input.roundId, walletId: input.walletId }));
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
