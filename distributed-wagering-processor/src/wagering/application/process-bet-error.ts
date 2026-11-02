import { DomainError } from '../../shared/domain/domain-error.js';

export class IdempotencyConflictError extends DomainError {}
export class ExternalTransactionConflictError extends DomainError {}
export class WalletNotFoundError extends DomainError {}
export class BetWalletMismatchError extends DomainError {}
export class LedgerPersistenceConflictError extends DomainError {}

export type BetUniqueConstraint =
  | 'IDEMPOTENCY_KEY'
  | 'PROVIDER_EXTERNAL_TRANSACTION'
  | 'WALLET_LEDGER_TRANSACTION';

export class BetUniqueConstraintError extends Error {
  constructor(public readonly constraint: BetUniqueConstraint) {
    super(`BET persistence unique constraint violated: ${constraint}.`);
    this.name = new.target.name;
  }
}
