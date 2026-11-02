import { CurrencyMismatchError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import {
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidWalletStateError,
} from './wallet-error.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt?: Date;
}

export interface RehydrateWalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private currentBalance: Money,
    private currentVersion: number,
    public readonly createdAt: Date,
    private currentUpdatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletStateError(
        'A wallet cannot be opened with a negative balance.',
      );
    }

    const openedAt = props.openedAt ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(openedAt),
      new Date(openedAt),
    );
  }

  /**
   * Reconstructs persisted state only.
   * It does not replay or validate domain transitions.
   */
  static rehydrate(props: RehydrateWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      props.balance,
      props.version,
      new Date(props.createdAt),
      new Date(props.updatedAt),
    );
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get updatedAt(): Date {
    return new Date(this.currentUpdatedAt);
  }

  credit(amount: Money, changedAt: Date = new Date()): void {
    this.assertValidOperationAmount(amount);
    this.assertSameCurrency(amount);

    if (amount.isZero()) {
      return;
    }

    this.applyBalance(this.currentBalance.add(amount), changedAt);
  }

  debit(amount: Money, changedAt: Date = new Date()): void {
    this.assertValidOperationAmount(amount);
    this.assertSameCurrency(amount);

    const nextBalance = this.currentBalance.subtract(amount);

    if (nextBalance.isNegative()) {
      throw new InsufficientFundsError(
        `Cannot debit ${amount.toString()} ${amount.currency} from wallet balance ${this.currentBalance.toString()} ${this.currency}.`,
      );
    }

    if (amount.isZero()) {
      return;
    }

    this.applyBalance(nextBalance, changedAt);
  }

  private applyBalance(balance: Money, changedAt: Date): void {
    this.currentBalance = balance;
    this.currentVersion += 1;
    this.currentUpdatedAt = new Date(changedAt);
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency is ${this.currency}, received ${amount.currency}.`,
      );
    }
  }

  private assertValidOperationAmount(amount: Money): void {
    if (amount.isNegative()) {
      throw new InvalidWalletAmountError(
        'Wallet credit and debit amounts cannot be negative.',
      );
    }
  }
}