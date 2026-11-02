import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { ProcessWagerMessageUseCase } from '../../application/process-wager-message.use-case.js';
import { isTerminalWagerConsumerError } from '../../application/terminal-wager-consumer-error.js';

export class SqsWagerConsumer {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly processor: ProcessWagerMessageUseCase,
    private readonly visibilityTimeoutSeconds: number,
  ) {}

  async pollOnce(maxMessages = 10, waitTimeSeconds = 0): Promise<number> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: this.visibilityTimeoutSeconds,
    }));
    let acknowledged = 0;
    for (const message of response.Messages ?? []) {
      if (await this.handle(message)) acknowledged += 1;
    }
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
      await this.processor.execute(message.Body);
    } catch (error) {
      if (!isTerminalWagerConsumerError(error)) throw error;
      // Parsing/contract failures are terminal and occur before financial processing.
    }
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }));
    return true;
  }
}
