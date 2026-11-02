import { CurrencyMismatchError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import {
  InvalidWagerTransactionError,
  TerminalWagerTransactionError,
} from './wager-transaction-error.js';

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
}

export enum WagerFailureCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
}

export interface CreateBetProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  money: Money;
  createdAt: Date;
}

export interface RehydrateBetProps extends CreateBetProps {
  status: WagerTransactionStatus;
  resultBalance: Money | null;
  failureCode: string | null;
  processedAt: Date | null;
}

export class WagerTransaction {
  private readonly occurredAt: Date;
  private currentStatus: WagerTransactionStatus;
  private currentResultBalance: Money | null;
  private currentFailureCode: string | null;
  private currentProcessedAt: Date | null;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly money: Money,
    status: WagerTransactionStatus,
    resultBalance: Money | null,
    failureCode: string | null,
    processedAt: Date | null,
    createdAt: Date,
  ) {
    this.currentStatus = status;
    this.currentResultBalance = resultBalance;
    this.currentFailureCode = failureCode;
    this.currentProcessedAt = processedAt === null ? null : new Date(processedAt);
    this.occurredAt = new Date(createdAt);
  }

  static createBet(props: CreateBetProps): WagerTransaction {
    WagerTransaction.assertRequiredStrings(props);
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('A BET amount cannot be negative.');
    }
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('Payload hash must be a lowercase SHA-256 hex string.');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.money,
      WagerTransactionStatus.PENDING,
      null,
      null,
      null,
      props.createdAt,
    );
  }

  static rehydrate(props: RehydrateBetProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.money,
      props.status,
      props.resultBalance,
      props.failureCode,
      props.processedAt,
      props.createdAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get resultBalance(): Money | null {
    return this.currentResultBalance;
  }

  get failureCode(): string | null {
    return this.currentFailureCode;
  }

  get processedAt(): Date | null {
    return this.currentProcessedAt === null ? null : new Date(this.currentProcessedAt);
  }

  get createdAt(): Date {
    return new Date(this.occurredAt);
  }

  markProcessed(resultBalance: Money, processedAt: Date): void {
    this.assertPending();
    this.assertResultBalance(resultBalance);
    this.currentStatus = WagerTransactionStatus.PROCESSED;
    this.currentResultBalance = resultBalance;
    this.currentFailureCode = null;
    this.currentProcessedAt = new Date(processedAt);
  }

  reject(failureCode: WagerFailureCode, resultBalance: Money, processedAt: Date): void {
    this.assertPending();
    this.assertResultBalance(resultBalance);
    this.currentStatus = WagerTransactionStatus.REJECTED;
    this.currentResultBalance = resultBalance;
    this.currentFailureCode = failureCode;
    this.currentProcessedAt = new Date(processedAt);
  }

  private assertPending(): void {
    if (this.currentStatus !== WagerTransactionStatus.PENDING) {
      throw new TerminalWagerTransactionError(
        `Cannot transition terminal wager transaction ${this.id} from ${this.currentStatus}.`,
      );
    }
  }

  private assertResultBalance(resultBalance: Money): void {
    if (resultBalance.currency !== this.money.currency) {
      throw new CurrencyMismatchError(
        `BET currency ${this.money.currency} does not match result balance currency ${resultBalance.currency}.`,
      );
    }
    if (resultBalance.isNegative()) {
      throw new InvalidWagerTransactionError('A BET result balance cannot be negative.');
    }
  }

  private static assertRequiredStrings(props: CreateBetProps): void {
    const values = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];
    if (values.some(value => value.trim().length === 0)) {
      throw new InvalidWagerTransactionError('BET identifiers cannot be empty.');
    }
  }
}
