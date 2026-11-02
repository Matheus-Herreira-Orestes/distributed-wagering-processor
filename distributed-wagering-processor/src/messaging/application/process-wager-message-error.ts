import { DomainError } from '../../shared/domain/domain-error.js';

export class InvalidWagerMessageError extends DomainError {}
export class InboxPayloadConflictError extends DomainError {}
