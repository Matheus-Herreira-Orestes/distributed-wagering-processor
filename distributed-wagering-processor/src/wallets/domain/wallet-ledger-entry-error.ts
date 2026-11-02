import { DomainError } from '../../shared/domain/domain-error.js';

export class InvalidLedgerEntryError extends DomainError {}
export class UnbalancedLedgerEntryError extends DomainError {}
