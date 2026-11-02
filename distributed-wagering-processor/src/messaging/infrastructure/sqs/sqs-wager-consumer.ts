import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { ProcessWagerMessageUseCase } from '../../application/process-wager-message.use-case.js';
import { isTerminalWagerConsumerError } from '../../application/terminal-wager-consumer-error.js';
import { log, metrics } from '../../../observability.js';

export class SqsWagerConsumer {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly processor: ProcessWagerMessageUseCase,
    private readonly visibilityTimeoutSeconds: number,
    private readonly dlqQueueUrl?: string,
  ) {}

  async pollOnce(maxMessages = 10, waitTimeSeconds = 0): Promise<number> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: this.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    let acknowledged = 0;
    for (const message of response.Messages ?? []) {
      if (await this.handle(message)) acknowledged += 1;
    }
    await this.recordDlqDepth();
    return acknowledged;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollOnce(10, 10);
    }
  }

  async handle(message: Message): Promise<boolean> {
    if (message.MessageId === undefined || message.Body === undefined
      || message.ReceiptHandle === undefined) {
      return false;
    }
    try {
      if (Number(message.Attributes?.ApproximateReceiveCount ?? '0') >= 5) {
        metrics.increment('wager_messages_dlq_imminent_total');
      }
      const result = await this.processor.execute(message.Body);
      metrics.increment('wager_messages_processed_total', { duplicate: String(result.duplicateMessage), status: result.bet?.status ?? 'DUPLICATE' });
      log('wager_message_processed', { messageId: message.MessageId, duplicate: result.duplicateMessage, transactionId: result.bet?.transactionId });
    } catch (error) {
      if (!isTerminalWagerConsumerError(error)) throw error;
      metrics.increment('wager_messages_terminal_failure_total');
      log('wager_message_terminal_failure', { messageId: message.MessageId, error: error.name });
      // Parsing/contract failures are terminal and occur before financial processing.
    }
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }));
    return true;
  }

  private async recordDlqDepth(): Promise<void> {
    if (this.dlqQueueUrl === undefined) return;
    try {
      const response = await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.dlqQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      metrics.set('wager_dlq_visible_messages', Number(response.Attributes?.ApproximateNumberOfMessages ?? '0'));
    } catch {
      metrics.increment('wager_dlq_metric_failures_total');
    }
  }
}
