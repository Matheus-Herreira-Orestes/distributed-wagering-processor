import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../domain/inbox-message.js';
import { InboxPayloadConflictError } from '../../application/process-wager-message-error.js';
import type {
  InboxRepository,
  WagerMessageTransactionContext,
  WagerMessageUnitOfWork,
} from '../../application/ports/process-wager-message.persistence-port.js';
import { createMikroOrmProcessBetRepositories } from '../../../wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';

interface ExistingInboxRow { payload_hash: string; }

export class MikroOrmWagerMessageUnitOfWork implements WagerMessageUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  transactional<T>(work: (context: WagerMessageTransactionContext) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(entityManager => work({
      inbox: new MikroOrmInboxRepository(entityManager),
      bet: createMikroOrmProcessBetRepositories(entityManager),
    }));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async insert(message: InboxMessage): Promise<boolean> {
    const inserted = await this.entityManager.execute<Array<{ message_id: string }>>(
      `insert into "inbox_messages"
        ("consumer_name", "message_id", "payload_hash", "received_at")
       values (?, ?, ?, ?)
       on conflict ("consumer_name", "message_id") do nothing
       returning "message_id"`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length > 0) return true;

    const rows = await this.entityManager.execute<ExistingInboxRow[]>(
      `select "payload_hash" from "inbox_messages"
        where "consumer_name" = ? and "message_id" = ?`,
      [message.consumerName, message.messageId],
    );
    if (rows[0]?.payload_hash !== message.payloadHash) {
      throw new InboxPayloadConflictError(
        `Inbox identity ${message.consumerName}/${message.messageId} has a different payload.`,
      );
    }
    return false;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.entityManager.execute(
      `update "inbox_messages" set "processed_at" = ?
        where "consumer_name" = ? and "message_id" = ? and "processed_at" is null`,
      [message.processedAt, message.consumerName, message.messageId],
      'run',
    );
  }
}
