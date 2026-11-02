import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../../src/shared/domain/domain-error.js';
import { Money } from '../../../../src/shared/domain/money.js';
import { Wallet } from '../../../../src/wallets/domain/wallet.js';
import {
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidWalletStateError,
} from '../../../../src/wallets/domain/wallet-error.js';

const openedAt = new Date('2026-11-01T12:00:00.000Z');

function openWallet(): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.zero('BRL'),
    openedAt,
  });
}

describe('Wallet', () => {
  test('opens with a zero balance and version 1', () => {
    const wallet = openWallet();

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('opens with the supplied initial balance and its currency', () => {
    const wallet = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: Money.from({ amount: '50.00', currency: 'USD' }),
      openedAt,
    });

    expect(wallet.currency).toBe('USD');
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  test('rejects a negative initial balance', () => {
    expect(() => Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }).negate(),
      openedAt,
    })).toThrow(InvalidWalletStateError);
  });

  test('credits and debits the balance and increments the version for each change', () => {
    const wallet = openWallet();
    const creditedAt = new Date('2026-11-01T12:01:00.000Z');
    const debitedAt = new Date('2026-11-01T12:02:00.000Z');

    wallet.credit(Money.from({ amount: '25.00', currency: 'BRL' }), creditedAt);

    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(creditedAt);

    wallet.debit(Money.from({ amount: '7.50', currency: 'BRL' }), debitedAt);

    expect(wallet.balance.toString()).toBe('17.50');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(debitedAt);
  });

  test('rejects insufficient funds without mutating state', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;

    expect(() => wallet.debit(
      Money.from({ amount: '10.01', currency: 'BRL' }),
      new Date('2026-11-01T13:00:00.000Z'),
    )).toThrow(InsufficientFundsError);

    expect(wallet.balance).toBe(balanceBefore);
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toEqual(updatedAtBefore);
  });

  test('rejects cross-currency credits and debits without mutating state', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.balance).toBe(balanceBefore);
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toEqual(updatedAtBefore);
  });

  test('treats zero-value operations as no-ops, including cross-currency validation', () => {
    const wallet = openWallet();

    wallet.credit(Money.zero('BRL'), new Date('2026-11-01T13:00:00.000Z'));
    wallet.debit(Money.zero('BRL'), new Date('2026-11-01T14:00:00.000Z'));

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(() => wallet.credit(Money.zero('USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(Money.zero('USD'))).toThrow(CurrencyMismatchError);
  });

  test('rejects negative operation amounts without mutating state', () => {
    const wallet = openWallet();
    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;
    const negativeAmount = Money.from({ amount: '1.00', currency: 'BRL' }).negate();

    expect(() => wallet.credit(negativeAmount)).toThrow(InvalidWalletAmountError);
    expect(() => wallet.debit(negativeAmount)).toThrow(InvalidWalletAmountError);
    expect(wallet.balance).toBe(balanceBefore);
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toEqual(updatedAtBefore);
  });

  test('rehydrates persisted state exactly without replaying transitions', () => {
    const createdAt = new Date('2026-10-01T10:00:00.000Z');
    const updatedAt = new Date('2026-10-02T11:00:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-2',
      playerId: 'player-2',
      currency: 'USD',
      balance: Money.from({ amount: '91.25', currency: 'USD' }),
      version: 42,
      createdAt,
      updatedAt,
    });

    expect(wallet.balance.toString()).toBe('91.25');
    expect(wallet.version).toBe(42);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  test('rehydrates persisted state without applying business validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-2',
      playerId: 'player-2',
      currency: 'BRL',
      balance: Money.from({ amount: '1.00', currency: 'USD' }).negate(),
      version: 0,
      createdAt: openedAt,
      updatedAt: openedAt,
    });

    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({ amount: '-1.00', currency: 'USD' });
    expect(wallet.version).toBe(0);
  });
});
