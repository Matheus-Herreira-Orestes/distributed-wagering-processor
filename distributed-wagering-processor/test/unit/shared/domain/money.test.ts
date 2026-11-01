import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../../src/shared/domain/domain-error.js';
import { Money } from '../../../../src/shared/domain/money.js';

describe('Money', () => {
  test('preserves exact two-decimal arithmetic and is immutable', () => {
    const original = Money.from({ amount: '0.10', currency: 'BRL' });
    const result = original.add(Money.from({ amount: '0.20', currency: 'BRL' }));

    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(original.toString()).toBe('0.10');
  });

  test('supports internally produced negative values', () => {
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).negate().toString()).toBe('-25.00');
    expect(Money.from({ amount: '10.00', currency: 'BRL' })
      .subtract(Money.from({ amount: '25.00', currency: 'BRL' })).isNegative()).toBe(true);
  });

  test('rejects malformed, signed, scientific, or over-scaled input amounts', () => {
    for (const amount of ['', '1', '-1.00', '+1.00', '1.0', '1.000', '1e2', 'NaN', 'Infinity']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  test('rejects an invalid currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
  });

  test('rejects cross-currency comparisons and arithmetic', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });
});
