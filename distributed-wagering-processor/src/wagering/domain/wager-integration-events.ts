import type { MoneyProps } from '../../shared/domain/money.js';
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../messaging/domain/integration-event.js';

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly money: MoneyProps;
  readonly resultBalance: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionProcessedData {
  readonly failureCode: string;
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) { super(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); }
}
