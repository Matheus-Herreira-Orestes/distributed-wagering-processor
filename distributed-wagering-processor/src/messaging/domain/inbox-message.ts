import { DomainError } from '../../shared/domain/domain-error.js';

export class InvalidInboxTransitionError extends DomainError {}

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface RehydrateInboxMessageProps extends InboxMessageProps {
  processedAt: Date | null;
}

export class InboxMessage {
  private currentProcessedAt: Date | null;
  private readonly messageReceivedAt: Date;

  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt: Date | null,
  ) {
    this.messageReceivedAt = new Date(receivedAt);
    this.currentProcessedAt = processedAt;
  }

  static receive(props: InboxMessageProps): InboxMessage {
    if (!props.consumerName || !props.messageId || !/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new InvalidInboxTransitionError('Inbox identity and SHA-256 payload hash are required.');
    }
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      new Date(props.receivedAt),
      null,
    );
  }

  static rehydrate(props: RehydrateInboxMessageProps): InboxMessage {
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      new Date(props.receivedAt),
      props.processedAt === null ? null : new Date(props.processedAt),
    );
  }

  get receivedAt(): Date { return new Date(this.messageReceivedAt); }
  get processedAt(): Date | null {
    return this.currentProcessedAt === null ? null : new Date(this.currentProcessedAt);
  }
  get isProcessed(): boolean { return this.currentProcessedAt !== null; }

  markProcessed(at: Date): void {
    if (this.isProcessed) {
      throw new InvalidInboxTransitionError('An inbox message cannot be processed twice.');
    }
    this.currentProcessedAt = new Date(at);
  }
}
