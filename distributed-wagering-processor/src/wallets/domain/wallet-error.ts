import { DomainError } from '../../shared/domain/domain-error.js';

export class InsufficientFundsError extends DomainError {}
export class InvalidWalletAmountError extends DomainError {}
export class InvalidWalletStateError extends DomainError {}
