import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConfig {
  endpoint: string;
  region: string;
  wagerQueueUrl: string;
  wagerDlqQueueUrl: string;
  eventQueueUrl: string;
  wagerVisibilityTimeoutSeconds: number;
}

export class SqsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

type SqsEnvironment = Readonly<Record<string, string | undefined>>;

export function sqsConfigFromEnvironment(environment: SqsEnvironment = process.env): SqsConfig {
  const endpoint = environment.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const region = environment.AWS_REGION ?? 'us-east-1';
  return {
    endpoint,
    region,
    wagerQueueUrl: environment.WAGER_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-transactions.fifo`,
    wagerDlqQueueUrl: environment.WAGER_DLQ_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`,
    eventQueueUrl: environment.WAGER_EVENT_QUEUE_URL
      ?? `${endpoint}/000000000000/wager-events.fifo`,
    wagerVisibilityTimeoutSeconds: parseVisibilityTimeout(
      environment.SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS,
    ),
  };
}

function parseVisibilityTimeout(rawValue: string | undefined): number {
  const value = rawValue ?? '30';
  if (!/^\d+$/.test(value)) {
    throw new SqsConfigurationError(
      'SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS must be an integer from 1 to 43200.',
    );
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 43_200) {
    throw new SqsConfigurationError(
      'SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS must be an integer from 1 to 43200.',
    );
  }
  return seconds;
}

export function createSqsClient(config = sqsConfigFromEnvironment()): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}
