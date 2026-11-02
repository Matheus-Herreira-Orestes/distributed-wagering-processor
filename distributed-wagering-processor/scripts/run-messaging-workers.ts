import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';
import { ProcessBetUseCase } from '../src/wagering/application/process-bet.use-case.js';
import { MikroOrmProcessBetUnitOfWork } from '../src/wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';
import { ProcessWagerMessageUseCase } from '../src/messaging/application/process-wager-message.use-case.js';
import { MikroOrmWagerMessageUnitOfWork } from '../src/messaging/infrastructure/persistence/mikro-orm-wager-message.unit-of-work.js';
import { MikroOrmOutboxStore } from '../src/messaging/infrastructure/persistence/mikro-orm-outbox-store.js';
import { SqsWagerConsumer } from '../src/messaging/infrastructure/sqs/sqs-wager-consumer.js';
import { SqsOutboxPublisher } from '../src/messaging/infrastructure/sqs/sqs-outbox-publisher.js';
import {
  createSqsClient,
  sqsConfigFromEnvironment,
} from '../src/messaging/infrastructure/sqs/sqs-config.js';

const orm = await MikroORM.init(config);
const sqsConfig = sqsConfigFromEnvironment();
const sqs = createSqsClient(sqsConfig);
const processBet = new ProcessBetUseCase(new MikroOrmProcessBetUnitOfWork(orm));
const processMessage = new ProcessWagerMessageUseCase(
  new MikroOrmWagerMessageUnitOfWork(orm),
  processBet,
);
const consumer = new SqsWagerConsumer(
  sqs,
  sqsConfig.wagerQueueUrl,
  processMessage,
  sqsConfig.wagerVisibilityTimeoutSeconds,
);
const publisher = new SqsOutboxPublisher(
  new MikroOrmOutboxStore(orm),
  sqs,
  sqsConfig.eventQueueUrl,
  { workerId: process.env.OUTBOX_WORKER_ID ?? `outbox-${crypto.randomUUID()}` },
);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

const workers = [consumer.run(controller.signal), publisher.run(controller.signal)];
try {
  await Promise.all(workers);
} finally {
  controller.abort();
  await Promise.allSettled(workers);
  sqs.destroy();
  await orm.close(true);
}
