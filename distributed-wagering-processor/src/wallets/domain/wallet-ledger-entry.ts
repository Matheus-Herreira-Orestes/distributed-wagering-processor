import { CurrencyMismatchError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import {
  InvalidLedgerEntryError,
  UnbalancedLedgerEntryError,
} from './wallet-ledger-entry-error.js';

export enum LedgerDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly occurredAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.occurredAt = new Date(createdAt);
    Object.freeze(this);
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertSameCurrency(props);

    if (props.money.isNegative()) {
      throw new InvalidLedgerEntryError('A ledger entry amount cannot be negative.');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances cannot be negative.');
    }

    const entry = WalletLedgerEntry.from(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${props.direction} ledger entry does not preserve exact balance arithmetic.`,
      );
    }

    return entry;
  }

  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return WalletLedgerEntry.from(props);
  }

  get createdAt(): Date {
    return new Date(this.occurredAt);
  }

  isBalanced(): boolean {
    if (!this.hasOneCurrency()) {
      return false;
    }
    if (this.money.isNegative() || this.balanceBefore.isNegative() || this.balanceAfter.isNegative()) {
      return false;
    }

    const expectedBalance = this.direction === LedgerDirection.CREDIT
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  private static from(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  private static assertSameCurrency(props: WalletLedgerEntryProps): void {
    const currency = props.money.currency;
    if (props.balanceBefore.currency !== currency || props.balanceAfter.currency !== currency) {
      throw new CurrencyMismatchError('Ledger amount and balances must use the same currency.');
    }
  }

  private hasOneCurrency(): boolean {
    return this.money.currency === this.balanceBefore.currency
      && this.money.currency === this.balanceAfter.currency;
  }
}
