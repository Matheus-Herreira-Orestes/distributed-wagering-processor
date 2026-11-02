import { CurrencyMismatchError, InvalidMoneyError } from '../../shared/domain/domain-error.js';
import {
  BetWalletMismatchError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  LedgerPersistenceConflictError,
  WalletNotFoundError,
} from '../../wagering/application/process-bet-error.js';
import {
  InvalidWagerTransactionError,
  TerminalWagerTransactionError,
} from '../../wagering/domain/wager-transaction-error.js';
import {
  InsufficientFundsError,
  InvalidWalletAmountError,
  InvalidWalletStateError,
} from '../../wallets/domain/wallet-error.js';
import {
  InvalidLedgerEntryError,
  UnbalancedLedgerEntryError,
} from '../../wallets/domain/wallet-ledger-entry-error.js';
import {
  InboxPayloadConflictError,
  InvalidWagerMessageError,
} from './process-wager-message-error.js';

/** Explicit allow-list: infrastructure and unexpected errors must not be acknowledged. */
export function isTerminalWagerConsumerError(error: unknown): error is Error {
  return error instanceof InvalidWagerMessageError
    || error instanceof InboxPayloadConflictError
    || error instanceof InvalidMoneyError
    || error instanceof CurrencyMismatchError
    || error instanceof WalletNotFoundError
    || error instanceof BetWalletMismatchError
    || error instanceof IdempotencyConflictError
    || error instanceof ExternalTransactionConflictError
    || error instanceof LedgerPersistenceConflictError
    || error instanceof InvalidWagerTransactionError
    || error instanceof TerminalWagerTransactionError
    || error instanceof InsufficientFundsError
    || error instanceof InvalidWalletAmountError
    || error instanceof InvalidWalletStateError
    || error instanceof InvalidLedgerEntryError
    || error instanceof UnbalancedLedgerEntryError;
}
