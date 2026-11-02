import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';
import { ProcessWagerTransactionUseCase } from '../src/wagering/application/process-wager-transaction.use-case.js';
import { MikroOrmProcessBetUnitOfWork } from '../src/wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';
import { ProcessWagerMessageUseCase } from '../src/messaging/application/process-wager-message.use-case.js';
import { MikroOrmWagerMessageUnitOfWork } from '../src/messaging/infrastructure/persistence/mikro-orm-wager-message.unit-of-work.js';
import { MikroOrmOutboxStore } from '../src/messaging/infrastructure/persistence/mikro-orm-outbox-store.js';
import { SqsWagerConsumer } from '../src/messaging/infrastructure/sqs/sqs-wager-consumer.js';
import { SqsOutboxPublisher } from '../src/messaging/infrastructure/sqs/sqs-outbox-publisher.js';
import { PendingReferenceWorker } from '../src/wagering/infrastructure/persistence/pending-reference-worker.js';
import {
  createSqsClient,
  sqsConfigFromEnvironment,
} from '../src/messaging/infrastructure/sqs/sqs-config.js';
import { log, metrics } from '../src/observability.js';

const orm = await MikroORM.init(config);
const sqsConfig = sqsConfigFromEnvironment();
const sqs = createSqsClient(sqsConfig);
const processBet = new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(orm));
const processMessage = new ProcessWagerMessageUseCase(
  new MikroOrmWagerMessageUnitOfWork(orm),
  processBet,
);
const consumer = new SqsWagerConsumer(
  sqs,
  sqsConfig.wagerQueueUrl,
  processMessage,
  sqsConfig.wagerVisibilityTimeoutSeconds,
  sqsConfig.wagerDlqQueueUrl,
);
const publisher = new SqsOutboxPublisher(
  new MikroOrmOutboxStore(orm),
  sqs,
  sqsConfig.eventQueueUrl,
  { workerId: process.env.OUTBOX_WORKER_ID ?? `outbox-${crypto.randomUUID()}` },
);
const pendingReferences = new PendingReferenceWorker(orm, processBet);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const workers = [
  supervise('wager-consumer', () => consumer.run(controller.signal), controller.signal),
  supervise('outbox-publisher', () => publisher.run(controller.signal), controller.signal),
  supervise('pending-reference-worker', () => pendingReferences.run(controller.signal), controller.signal),
];
try {
  await Promise.all(workers);
} finally {
  controller.abort();
  await Promise.allSettled(workers);
  sqs.destroy();
  await orm.close(true);
}

async function supervise(
  worker: string,
  run: () => Promise<void>,
  signal: AbortSignal,
  restartDelayMs = 1_000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await run();
    } catch (error) {
      if (signal.aborted) return;
      metrics.increment('messaging_worker_restarts_total', { worker });
      log('messaging_worker_failed', {
        worker,
        error: error instanceof Error ? error.name : String(error),
      });
      await delay(restartDelayMs, signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
