import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Immutable, exact monetary amount. External inputs are always positive decimal strings. */
export class Money {
  private static readonly INPUT_AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/;
  private static readonly CURRENCY = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!Money.INPUT_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with exactly two places.');
    }
    return Money.create(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.create(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive(); }
  isNegative(): boolean { return this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(2);
  }

  private static create(value: Decimal, currency: string): Money {
    if (!Money.CURRENCY.test(currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter uppercase ISO-4217 code.');
    }
    if (!value.isFinite() || value.decimalPlaces() > 2) {
      throw new InvalidMoneyError('Amount must be finite and have at most two decimal places.');
    }
    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Cannot operate on ${this.currency} and ${other.currency}.`);
    }
  }
}
