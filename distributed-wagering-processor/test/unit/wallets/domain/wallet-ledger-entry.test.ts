import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../../src/shared/domain/domain-error.js';
import { Money } from '../../../../src/shared/domain/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
  type WalletLedgerEntryProps,
} from '../../../../src/wallets/domain/wallet-ledger-entry.js';
import {
  InvalidLedgerEntryError,
  UnbalancedLedgerEntryError,
} from '../../../../src/wallets/domain/wallet-ledger-entry-error.js';

const createdAt = new Date('2026-11-01T16:00:00.000Z');

function props(overrides: Partial<WalletLedgerEntryProps> = {}): WalletLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.CREDIT,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
    balanceAfter: Money.from({ amount: '35.00', currency: 'BRL' }),
    createdAt,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  test('creates an exactly balanced credit entry', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.direction).toBe(LedgerDirection.CREDIT);
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('10.00');
    expect(entry.balanceAfter.toString()).toBe('35.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('creates an exactly balanced debit entry', () => {
    const entry = WalletLedgerEntry.create(props({
      direction: LedgerDirection.DEBIT,
      balanceBefore: Money.from({ amount: '35.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
    }));

    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects credit and debit arithmetic violations', () => {
    expect(() => WalletLedgerEntry.create(props({
      balanceAfter: Money.from({ amount: '34.99', currency: 'BRL' }),
    }))).toThrow(UnbalancedLedgerEntryError);

    expect(() => WalletLedgerEntry.create(props({
      direction: LedgerDirection.DEBIT,
      balanceBefore: Money.from({ amount: '35.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '9.99', currency: 'BRL' }),
    }))).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a negative resulting balance', () => {
    expect(() => WalletLedgerEntry.create(props({
      direction: LedgerDirection.DEBIT,
      balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '15.00', currency: 'BRL' }).negate(),
    }))).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create(props({
      balanceAfter: Money.from({ amount: '35.00', currency: 'USD' }),
    }))).toThrow(CurrencyMismatchError);
  });

  test('is structurally immutable and protects its date value', () => {
    const entry = WalletLedgerEntry.create(props());
    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2030);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.createdAt).toEqual(createdAt);
    expect(() => Object.assign(entry, { id: 'changed' })).toThrow();
    expect(entry.id).toBe('entry-1');
  });

  test('rehydrates persisted state without replaying validation', () => {
    const entry = WalletLedgerEntry.rehydrate(props({
      balanceAfter: Money.from({ amount: '99.00', currency: 'USD' }).negate(),
    }));

    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '-99.00', currency: 'USD' });
    expect(entry.isBalanced()).toBe(false);
  });
});
