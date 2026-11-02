import { DomainError } from '../../shared/domain/domain-error.js';

export class InvalidWagerTransactionError extends DomainError {}
export class TerminalWagerTransactionError extends DomainError {}
