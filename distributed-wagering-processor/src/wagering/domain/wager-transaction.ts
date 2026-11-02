import { CurrencyMismatchError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry.js';
import { InvalidWagerTransactionError, TerminalWagerTransactionError } from './wager-transaction-error.js';

export enum WagerTransactionKind {
  OPENING = 'OPENING', BET = 'BET', WIN = 'WIN', LOSS = 'LOSS', REFUND = 'REFUND', ROLLBACK = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  PENDING = 'PENDING', PENDING_REFERENCE = 'PENDING_REFERENCE', PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED', FAILED = 'FAILED',
}
export enum WagerFailureCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS', REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  INVALID_REFERENCE = 'INVALID_REFERENCE', REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',
  REVERSAL_WOULD_OVERDRAW = 'REVERSAL_WOULD_OVERDRAW',
  REFERENCE_PROCESSING_FAILED = 'REFERENCE_PROCESSING_FAILED',
}

export interface CreateWagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string; payloadHash: string;
  walletId: string; playerId: string; roundId: string; gameId: string; kind: WagerTransactionKind;
  money: Money; referenceExternalTransactionId?: string | undefined; createdAt: Date;
}
/** Kept so existing BET callers remain source-compatible. */
export type CreateBetProps = Omit<CreateWagerTransactionProps, 'kind'>;
export interface RehydrateBetProps extends Omit<CreateWagerTransactionProps, 'kind'> {
  /** Older persisted BET rows predate the explicit kind in the domain shape. */
  kind?: WagerTransactionKind;
  status: WagerTransactionStatus; resultBalance: Money | null; referenceTransactionId?: string | null;
  failureCode: string | null; processedAt: Date | null;
}

export class WagerTransaction {
  private readonly occurredAt: Date;
  private currentStatus: WagerTransactionStatus;
  private currentResultBalance: Money | null;
  private currentReferenceTransactionId: string | null;
  private currentFailureCode: string | null;
  private currentProcessedAt: Date | null;

  private constructor(
    public readonly id: string, public readonly providerId: string, public readonly externalTransactionId: string,
    public readonly idempotencyKey: string, public readonly payloadHash: string, public readonly walletId: string,
    public readonly playerId: string, public readonly roundId: string, public readonly gameId: string,
    public readonly kind: WagerTransactionKind, public readonly money: Money,
    public readonly referenceExternalTransactionId: string | null, status: WagerTransactionStatus,
    resultBalance: Money | null, referenceTransactionId: string | null, failureCode: string | null,
    processedAt: Date | null, createdAt: Date,
  ) {
    this.currentStatus = status;
    this.currentResultBalance = resultBalance;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.currentFailureCode = failureCode;
    this.currentProcessedAt = processedAt === null ? null : new Date(processedAt);
    this.occurredAt = new Date(createdAt);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertRequiredStrings(props);
    if (props.money.isNegative() || props.money.isZero()) {
      throw new InvalidWagerTransactionError('A wager amount must be greater than zero.');
    }
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) throw new InvalidWagerTransactionError('Payload hash must be a lowercase SHA-256 hex string.');
    if (requiresReference(props.kind) && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId.`);
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind ?? WagerTransactionKind.BET, props.money,
      props.referenceExternalTransactionId ?? null, WagerTransactionStatus.PENDING, null, null, null, null, props.createdAt,
    );
  }

  static createBet(props: CreateBetProps): WagerTransaction {
    return WagerTransaction.create({ ...props, kind: WagerTransactionKind.BET });
  }

  static rehydrate(props: RehydrateBetProps): WagerTransaction {
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind ?? WagerTransactionKind.BET, props.money,
      props.referenceExternalTransactionId ?? null, props.status, props.resultBalance, props.referenceTransactionId ?? null,
      props.failureCode, props.processedAt, props.createdAt,
    );
  }

  get status(): WagerTransactionStatus { return this.currentStatus; }
  get resultBalance(): Money | null { return this.currentResultBalance; }
  get referenceTransactionId(): string | null { return this.currentReferenceTransactionId; }
  get failureCode(): string | null { return this.currentFailureCode; }
  get processedAt(): Date | null { return this.currentProcessedAt === null ? null : new Date(this.currentProcessedAt); }
  get createdAt(): Date { return new Date(this.occurredAt); }
  get isTerminal(): boolean { return this.currentStatus === WagerTransactionStatus.PROCESSED || this.currentStatus === WagerTransactionStatus.REJECTED || this.currentStatus === WagerTransactionStatus.FAILED; }
  get affectsBalance(): boolean { return this.kind !== WagerTransactionKind.LOSS; }
  get requiresReference(): boolean { return requiresReference(this.kind); }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }

  markPendingReference(): void { this.assertPending(); this.currentStatus = WagerTransactionStatus.PENDING_REFERENCE; }
  resumePendingReference(): void {
    if (this.currentStatus !== WagerTransactionStatus.PENDING_REFERENCE) throw new TerminalWagerTransactionError(`Transaction ${this.id} is not pending a reference.`);
    this.currentStatus = WagerTransactionStatus.PENDING;
  }
  markProcessed(resultBalance: Money, at: Date, referenceTransactionId: string | null = null): void {
    this.assertPending(); this.assertResultBalance(resultBalance);
    this.currentStatus = WagerTransactionStatus.PROCESSED; this.currentResultBalance = resultBalance;
    this.currentReferenceTransactionId = referenceTransactionId; this.currentFailureCode = null; this.currentProcessedAt = new Date(at);
  }
  reject(code: WagerFailureCode, resultBalance: Money, at: Date): void {
    this.assertPending(); this.assertResultBalance(resultBalance);
    this.currentStatus = WagerTransactionStatus.REJECTED; this.currentResultBalance = resultBalance;
    this.currentFailureCode = code; this.currentProcessedAt = new Date(at);
  }
  fail(code: WagerFailureCode, resultBalance: Money, at: Date): void {
    this.assertPending(); this.assertResultBalance(resultBalance);
    this.currentStatus = WagerTransactionStatus.FAILED; this.currentResultBalance = resultBalance;
    this.currentFailureCode = code; this.currentProcessedAt = new Date(at);
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    if (this.kind === WagerTransactionKind.BET) return LedgerDirection.DEBIT;
    if (this.kind === WagerTransactionKind.WIN || this.kind === WagerTransactionKind.REFUND || this.kind === WagerTransactionKind.OPENING) return LedgerDirection.CREDIT;
    if (this.kind === WagerTransactionKind.LOSS) return null;
    if (reference === undefined) throw new InvalidWagerTransactionError('ROLLBACK needs its reference.');
    const direction = reference.ledgerDirectionFor();
    if (direction === null) throw new InvalidWagerTransactionError('Cannot roll back a transaction without a balance effect.');
    return direction === LedgerDirection.DEBIT ? LedgerDirection.CREDIT : LedgerDirection.DEBIT;
  }

  private assertPending(): void {
    if (this.currentStatus !== WagerTransactionStatus.PENDING) throw new TerminalWagerTransactionError(`Cannot transition wager transaction ${this.id} from ${this.currentStatus}.`);
  }
  private assertResultBalance(value: Money): void {
    if (value.currency !== this.money.currency) throw new CurrencyMismatchError(`Wager currency ${this.money.currency} does not match result balance currency ${value.currency}.`);
    if (value.isNegative()) throw new InvalidWagerTransactionError('A result balance cannot be negative.');
  }
  private static assertRequiredStrings(props: CreateWagerTransactionProps): void {
    if ([props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.walletId, props.playerId, props.roundId, props.gameId].some(value => value.trim().length === 0)) {
      throw new InvalidWagerTransactionError('Wager identifiers cannot be empty.');
    }
  }
}

function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.REFUND || kind === WagerTransactionKind.ROLLBACK;
}
