export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Readonly<T>;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Versioned, framework-free event envelope persisted in the transactional outbox. */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly eventOccurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.eventOccurredAt = new Date(props.occurredAt);
    this.data = props.data;
  }

  get occurredAt(): Date { return new Date(this.eventOccurredAt); }

  toJSON(): IntegrationEventJson<T> {
    const envelope = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.eventOccurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
    return this.causationId === undefined
      ? envelope
      : { ...envelope, causationId: this.causationId };
  }
}
