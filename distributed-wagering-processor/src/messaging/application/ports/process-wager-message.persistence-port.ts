import type { InboxMessage } from '../../domain/inbox-message.js';
import type { ProcessBetRepositories } from '../../../wagering/application/ports/process-bet.persistence-port.js';

export interface InboxRepository {
  /** Returns false when the same consumer/message identity is already persisted. */
  insert(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface WagerMessageTransactionContext {
  readonly inbox: InboxRepository;
  readonly bet: ProcessBetRepositories;
}

export interface WagerMessageUnitOfWork {
  transactional<T>(work: (context: WagerMessageTransactionContext) => Promise<T>): Promise<T>;
}
