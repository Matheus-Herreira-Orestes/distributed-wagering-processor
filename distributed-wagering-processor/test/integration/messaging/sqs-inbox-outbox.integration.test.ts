import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../../mikro-orm.config.js';
import { Money } from '../../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../../src/wallets/application/create-wallet.use-case.js';
import { MikroOrmCreateWalletUnitOfWork } from '../../../src/wallets/infrastructure/persistence/mikro-orm-create-wallet.unit-of-work.js';
import { ProcessWagerTransactionUseCase } from '../../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/wagering/domain/wager-transaction.js';
import { PendingReferenceWorker } from '../../../src/wagering/infrastructure/persistence/pending-reference-worker.js';
import { MikroOrmProcessBetUnitOfWork } from '../../../src/wagering/infrastructure/persistence/mikro-orm-process-bet.unit-of-work.js';
import {
  ProcessWagerMessageUseCase,
  type WagerTransactionRequested,
} from '../../../src/messaging/application/process-wager-message.use-case.js';
import { MikroOrmWagerMessageUnitOfWork } from '../../../src/messaging/infrastructure/persistence/mikro-orm-wager-message.unit-of-work.js';
import { MikroOrmOutboxStore } from '../../../src/messaging/infrastructure/persistence/mikro-orm-outbox-store.js';
import { SqsWagerConsumer } from '../../../src/messaging/infrastructure/sqs/sqs-wager-consumer.js';
import { SqsOutboxPublisher } from '../../../src/messaging/infrastructure/sqs/sqs-outbox-publisher.js';
import { RuntimeService } from '../../../src/interfaces/runtime.service.js';

interface CountRow { count: string; }
interface WalletRow { balance_amount: string; version: number; }
interface InboxRow { processed_at: Date | null; }
interface OutboxTypeRow { event_type: string; }
interface OutboxStateRow {
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  claimed_by: string | null;
  last_error: string | null;
}
interface PublishedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

describe('SQS inbox and transactional outbox with PostgreSQL and LocalStack', () => {
  let orm: MikroORM;
  let secondaryOrm: MikroORM;
  let tertiaryOrm: MikroORM;
  let sqs: SQSClient;
  let wagerQueueUrl: string;
  let eventQueueUrl: string;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let messageProcessor: ProcessWagerMessageUseCase;
  let consumer: SqsWagerConsumer;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    secondaryOrm = await MikroORM.init(config);
    tertiaryOrm = await MikroORM.init(config);
    await orm.getMigrator().up();
    createWallet = new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(orm));
    processWager = new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(orm));
    messageProcessor = new ProcessWagerMessageUseCase(
      new MikroOrmWagerMessageUnitOfWork(orm),
      processWager,
    );

    sqs = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    wagerQueueUrl = await ensureQueue('wager-transactions.fifo');
    eventQueueUrl = await ensureQueue('wager-events.fifo');
    consumer = new SqsWagerConsumer(sqs, wagerQueueUrl, messageProcessor, 30);
  });

  afterAll(async () => {
    sqs?.destroy();
    await Promise.all([orm?.close(true), secondaryOrm?.close(true), tertiaryOrm?.close(true)]);
  });

  test('an SQS BET creates one inbox record and one financial effect atomically', async () => {
    const wallet = await openWallet('100.00');
    const body = requestBody(wallet, '25.00');
    const providerMessageId = providerIdFrom(body);
    const transportMessageId = await sendBet(body);

    await consumeUntilProcessed(providerMessageId);

    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    expect(await count('inbox_messages', 'message_id', providerMessageId)).toBe(1);
    expect(await count('inbox_messages', 'message_id', transportMessageId)).toBe(0);
    expect((await query<InboxRow>('select processed_at from inbox_messages where message_id = ?', [providerMessageId]))[0]?.processed_at)
      .not.toBeNull();
    expect(await betCount(wallet.id)).toBe(1);
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxCount(wallet.id)).toBe(2);
  });

  test('redelivery of the same SQS identity is deduplicated by the persistent inbox', async () => {
    const wallet = await openWallet('100.00');
    const body = requestBody(wallet, '30.00');
    const providerMessageId = providerIdFrom(body);

    const first = await messageProcessor.execute(body);
    const duplicates = await Promise.all(Array.from(
      { length: 5 }, () => messageProcessor.execute(body),
    ));

    expect(first.duplicateMessage).toBe(false);
    expect(duplicates.every(result => result.duplicateMessage)).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '70.00', version: 2 });
    expect(await betCount(wallet.id)).toBe(1);
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await count('inbox_messages', 'message_id', providerMessageId)).toBe(1);
  });

  test('reprocesses a REFUND after its BET arrives out of order', async () => {
    const wallet = await openWallet('100.00');
    const suffix = crypto.randomUUID();
    const pending = await processWager.execute({
      providerId: 'pending-provider', externalTransactionId: `refund-${suffix}`, idempotencyKey: `refund-key-${suffix}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${suffix}`, gameId: 'game-1',
      kind: WagerTransactionKind.REFUND, referenceExternalTransactionId: `bet-${suffix}`,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    await processWager.execute({
      providerId: 'pending-provider', externalTransactionId: `bet-${suffix}`, idempotencyKey: `bet-key-${suffix}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${suffix}`, gameId: 'game-1',
      kind: WagerTransactionKind.BET, money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    await new PendingReferenceWorker(orm, processWager).runOnce();
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 3 });
  });

  test('a database failure rolls back inbox, wallet, transaction, ledger, and outbox together', async () => {
    const wallet = await openWallet('100.00');
    const body = requestBody(wallet, '20.00');
    const providerMessageId = providerIdFrom(body);
    const functionName = `fail_outbox_${wallet.id.replaceAll('-', '_')}`;
    await query(`create function ${functionName}() returns trigger language plpgsql as $$
      begin raise exception 'forced outbox failure'; end; $$`);
    await query(`create trigger ${functionName} before insert on outbox_messages
      for each row when (new.aggregate_id = '${wallet.id}') execute function ${functionName}()`);
    try {
      await expect(messageProcessor.execute(body)).rejects.toThrow('forced outbox failure');
    } finally {
      await query(`drop trigger ${functionName} on outbox_messages`);
      await query(`drop function ${functionName}()`);
    }

    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
    expect(await count('inbox_messages', 'message_id', providerMessageId)).toBe(0);
    expect(await betCount(wallet.id)).toBe(0);
    expect(await ledgerCount(wallet.id)).toBe(0);
    expect(await outboxCount(wallet.id)).toBe(0);
  });

  test('a rejected BET persists one rejection event and no balance-change event', async () => {
    const wallet = await openWallet('10.00');
    const result = await messageProcessor.execute(requestBody(wallet, '25.00'));

    expect(result.bet?.status).toBe('REJECTED');
    expect(result.bet?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '10.00', version: 1 });
    expect(await ledgerCount(wallet.id)).toBe(0);
    expect((await outboxTypes(wallet.id)).map(row => row.event_type)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  test('acknowledges a terminal invalid message without creating an inbox record', async () => {
    const invalid = JSON.stringify({
      messageId: `invalid-${crypto.randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { kind: 'WIN' },
    });
    const transportMessageId = await sendBet(invalid);
    const message = await receiveMessageById(transportMessageId);

    expect(await consumer.handle(message)).toBe(true);
    expect(await count('inbox_messages', 'message_id', providerIdFrom(invalid))).toBe(0);
  });

  test('commits and acknowledges terminal business errors without financial effects', async () => {
    const wallet = await openWallet('100.00');
    const parsed = JSON.parse(requestBody(wallet, '10.00')) as WagerTransactionRequested;
    const body = JSON.stringify({
      ...parsed,
      data: { ...parsed.data, playerId: crypto.randomUUID() },
    } satisfies WagerTransactionRequested);
    const firstTransportId = await sendBet(body);
    expect(await consumer.handle(await receiveMessageById(firstTransportId))).toBe(true);

    // Enqueue the redelivery only after the first receipt is acknowledged. Receiving a batch while
    // searching by transport ID can otherwise hide both messages and make this assertion race SQS.
    const secondTransportId = await sendBet(body);
    expect(await consumer.handle(await receiveMessageById(secondTransportId))).toBe(true);

    const inbox = (await query<InboxRow>(
      'select processed_at from inbox_messages where message_id = ?', [parsed.messageId],
    ))[0];
    expect(inbox?.processed_at).not.toBeNull();
    expect(await count('inbox_messages', 'message_id', parsed.messageId)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
    expect(await betCount(wallet.id)).toBe(0);
    expect(await ledgerCount(wallet.id)).toBe(0);
  });

  test('a processed BET persists and publishes transaction and balance-change events', async () => {
    const wallet = await openWallet('100.00');
    await messageProcessor.execute(requestBody(wallet, '10.00'));
    expect((await outboxTypes(wallet.id)).map(row => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);

    // Isolate this aggregate from pending rows created by other integration scenarios.
    await query('update outbox_messages set published_at = now() where published_at is null and aggregate_id <> ?', [wallet.id]);
    const publisher = new SqsOutboxPublisher(
      new MikroOrmOutboxStore(orm), sqs, eventQueueUrl,
      { workerId: `publisher-${crypto.randomUUID()}`, batchSize: 10 },
    );
    expect(await publisher.publishBatch()).toEqual({ claimed: 2, published: 2, failed: 0 });

    const events = await receiveEvents(wallet.id, 2);
    expect(events.map(event => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(events.every(event => event.version === 1 && event.correlationId.length > 0)).toBe(true);
    const balanceChanged = events.find(event => event.eventType === 'WalletBalanceChanged');
    expect(balanceChanged?.data).toMatchObject({
      walletId: wallet.id, direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2,
    });
  });

  test('two concurrent publishers cannot claim the same outbox row', async () => {
    await query('update outbox_messages set published_at = now() where published_at is null');
    const id = crypto.randomUUID();
    await insertOutbox(id);
    const firstStore = new MikroOrmOutboxStore(orm);
    const secondStore = new MikroOrmOutboxStore(secondaryOrm);
    const now = new Date();

    const [first, second] = await Promise.all([
      firstStore.claimPending({ workerId: 'claim-worker-1', limit: 1, now, leaseDurationMs: 30_000 }),
      secondStore.claimPending({ workerId: 'claim-worker-2', limit: 1, now, leaseDurationMs: 30_000 }),
    ]);

    expect([...first, ...second].filter(message => message.id === id)).toHaveLength(1);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });

  test('publisher failure retains the outbox row with attempts and backoff for retry', async () => {
    await query('update outbox_messages set published_at = now() where published_at is null');
    const id = crypto.randomUUID();
    await insertOutbox(id);
    const publisher = new SqsOutboxPublisher(
      new MikroOrmOutboxStore(orm), sqs,
      `${process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566'}/000000000000/does-not-exist.fifo`,
      { workerId: 'failure-worker', baseDelayMs: 10_000, maxAttempts: 3 },
    );

    expect(await publisher.publishBatch()).toEqual({ claimed: 1, published: 0, failed: 1 });
    const state = (await query<OutboxStateRow>(
      'select attempts, next_attempt_at, published_at, claimed_by, last_error from outbox_messages where id = ?',
      [id],
    ))[0];
    expect(state?.attempts).toBe(1);
    expect(state?.next_attempt_at).not.toBeNull();
    expect(state?.published_at).toBeNull();
    expect(state?.claimed_by).toBeNull();
    expect(state?.last_error).toBeTruthy();
  });

  test('the SQS message remains unacknowledged when the database transaction fails', async () => {
    const wallet = await openWallet('100.00');
    const body = requestBody(wallet, '15.00');
    const providerMessageId = providerIdFrom(body);
    const transportMessageId = await sendBet(body);
    const functionName = `fail_ack_${wallet.id.replaceAll('-', '_')}`;
    await query(`create function ${functionName}() returns trigger language plpgsql as $$
      begin raise exception 'forced failure before ack'; end; $$`);
    await query(`create trigger ${functionName} before insert on outbox_messages
      for each row when (new.aggregate_id = '${wallet.id}') execute function ${functionName}()`);
    try {
      const message = await receiveMessageById(transportMessageId);
      await expect(consumer.handle(message)).rejects.toThrow('forced failure before ack');
      await Bun.sleep(1_100);
      const redelivery = await receiveMessageById(transportMessageId);
      expect(Number(redelivery.Attributes?.ApproximateReceiveCount ?? '0')).toBeGreaterThanOrEqual(2);
    } finally {
      await query(`drop trigger ${functionName} on outbox_messages`);
      await query(`drop function ${functionName}()`);
    }
    expect(await count('inbox_messages', 'message_id', providerMessageId)).toBe(0);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
  });

  test('the generic use case keeps one debit when the same BET races across ORM instances', async () => {
    const wallet = await openWallet('100.00');
    const suffix = crypto.randomUUID();
    const input = {
      providerId: 'generic-race-provider', externalTransactionId: `bet-${suffix}`, idempotencyKey: `key-${suffix}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${suffix}`, gameId: 'game-1',
      kind: WagerTransactionKind.BET, money: Money.from({ amount: '80.00', currency: 'BRL' }),
    };
    const secondaryProcessor = new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(secondaryOrm));
    const tertiaryProcessor = new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(tertiaryOrm));
    const processors = [processWager, secondaryProcessor, tertiaryProcessor];
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      processors[index % processors.length]!.execute(input),
    ));
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '20.00', version: 2 });
    expect(await betCount(wallet.id)).toBe(1);
    expect(await ledgerCount(wallet.id)).toBe(1);
  });

  test('keeps ledger reconciliation consistent while three generic instances write concurrently', async () => {
    const wallet = await openWallet('100.00');
    const processors = [
      processWager,
      new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(secondaryOrm)),
      new ProcessWagerTransactionUseCase(new MikroOrmProcessBetUnitOfWork(tertiaryOrm)),
    ];
    const inputs = ['10.00', '20.00', '30.00'].map((amount, index) => ({
      providerId: 'generic-reconciliation-provider', externalTransactionId: `bet-${crypto.randomUUID()}`,
      idempotencyKey: `key-${crypto.randomUUID()}`, playerId: wallet.playerId, walletId: wallet.id,
      roundId: `round-${index}`, gameId: 'game-1', kind: WagerTransactionKind.BET,
      money: Money.from({ amount, currency: 'BRL' }),
    }));
    const runtime = new RuntimeService();
    try {
      const concurrent = await Promise.all([
        ...inputs.map((input, index) => processors[index]!.execute(input)),
        ...Array.from({ length: 3 }, () => runtime.reconcile(wallet.id)),
      ]);
      const reconciliations = concurrent.slice(inputs.length) as Array<Record<string, unknown> | null>;

      expect(concurrent.slice(0, inputs.length).every(result => (result as { status: string }).status === 'PROCESSED')).toBe(true);
      expect(reconciliations.every(result => result?.consistent === true)).toBe(true);
      expect(await walletState(wallet.id)).toEqual({ balance_amount: '40.00', version: 4 });
      expect(await betCount(wallet.id)).toBe(3);
      expect(await ledgerCount(wallet.id)).toBe(3);
      expect((await runtime.reconcile(wallet.id))?.consistent).toBe(true);
    } finally {
      await runtime.onModuleDestroy();
    }
  });

  test('expires an unresolved reference with an auditable rejection event', async () => {
    const wallet = await openWallet('100.00');
    const suffix = crypto.randomUUID();
    const pending = await processWager.execute({
      providerId: 'expiry-provider', externalTransactionId: `refund-${suffix}`, idempotencyKey: `refund-key-${suffix}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: `round-${suffix}`, gameId: 'game-1',
      kind: WagerTransactionKind.REFUND, referenceExternalTransactionId: `missing-${suffix}`,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    await new PendingReferenceWorker(orm, processWager, 1).runOnce();
    const state = (await query<{ status: string; failure_code: string | null }>(
      'select status, failure_code from wager_transactions where id = ?', [pending.transactionId],
    ))[0];
    expect(state).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect((await outboxTypes(wallet.id)).map(row => row.event_type)).toContain('WagerTransactionRejected');
  });

  test('redelivery after a commit before ACK does not duplicate the financial effect', async () => {
    const wallet = await openWallet('100.00');
    const body = requestBody(wallet, '25.00');
    const providerMessageId = providerIdFrom(body);
    const transportMessageId = await sendBet(body);
    const received = await receiveMessageById(transportMessageId);

    // Simulates a worker dying immediately after its database commit and before DeleteMessage.
    await messageProcessor.execute(received.Body!);
    await Bun.sleep(1_100);
    const redelivery = await receiveMessageById(transportMessageId);
    expect(await consumer.handle(redelivery)).toBe(true);

    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    expect(await betCount(wallet.id)).toBe(1);
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await count('inbox_messages', 'message_id', providerMessageId)).toBe(1);
  });

  test('moves an unacknowledged transient failure to the configured DLQ', async () => {
    const suffix = crypto.randomUUID();
    const dlqUrl = await ensureQueue(`wager-test-dlq-${suffix}.fifo`);
    const dlqAttributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
    const sourceUrl = await ensureQueue(`wager-test-source-${suffix}.fifo`, {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn, maxReceiveCount: '1' }),
    });
    const dlqConsumer = new SqsWagerConsumer(sqs, sourceUrl, messageProcessor, 1, dlqUrl);
    const wallet = await openWallet('100.00');
    const functionName = `dlq_failure_${wallet.id.replaceAll('-', '_')}`;
    await query(`create function ${functionName}() returns trigger language plpgsql as $$
      begin raise exception 'forced transient failure'; end; $$`);
    await query(`create trigger ${functionName} before insert on outbox_messages
      for each row when (new.aggregate_id = '${wallet.id}') execute function ${functionName}()`);
    try {
      const response = await sqs.send(new SendMessageCommand({
        QueueUrl: sourceUrl, MessageBody: requestBody(wallet, '10.00'),
        MessageGroupId: 'group', MessageDeduplicationId: crypto.randomUUID(),
      }));
      if (response.MessageId === undefined) throw new Error('SQS did not return a message ID.');
      const message = await receiveMessageByIdFrom(sourceUrl, response.MessageId);
      await expect(dlqConsumer.handle(message)).rejects.toThrow('forced transient failure');
      let movedToDlq = false;
      for (let attempt = 0; attempt < 6 && !movedToDlq; attempt += 1) {
        await Bun.sleep(1_100);
        try {
          await dlqConsumer.pollOnce(1);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        const dlqResponse = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }));
        movedToDlq = (dlqResponse.Messages?.length ?? 0) === 1;
      }
      expect(movedToDlq).toBe(true);
    } finally {
      await query(`drop trigger ${functionName} on outbox_messages`);
      await query(`drop function ${functionName}()`);
    }
  });

  async function ensureQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
    const response = await sqs.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
    }));
    if (response.QueueUrl === undefined) throw new Error(`Queue ${name} has no URL.`);
    if (attributes.RedrivePolicy !== undefined) {
      await sqs.send(new SetQueueAttributesCommand({
        QueueUrl: response.QueueUrl,
        Attributes: { RedrivePolicy: attributes.RedrivePolicy },
      }));
    }
    return response.QueueUrl;
  }

  async function openWallet(amount: string): Promise<{ id: string; playerId: string }> {
    const playerId = crypto.randomUUID();
    const result = await createWallet.execute({
      playerId,
      initialBalance: Money.from({ amount, currency: 'BRL' }),
    });
    return { id: result.wallet.id, playerId };
  }

  function requestBody(wallet: { id: string; playerId: string }, amount: string): string {
    const unique = crypto.randomUUID();
    const request: WagerTransactionRequested = {
      messageId: `provider-message-${crypto.randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'sqs-provider', externalTransactionId: `external-${unique}`,
        idempotencyKey: `idempotency-${unique}`, playerId: wallet.playerId,
        walletId: wallet.id, roundId: `round-${unique}`, gameId: 'game-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
    };
    return JSON.stringify(request);
  }

  function providerIdFrom(body: string): string {
    return (JSON.parse(body) as WagerTransactionRequested).messageId;
  }

  async function sendBet(body: string): Promise<string> {
    const response = await sqs.send(new SendMessageCommand({
      QueueUrl: wagerQueueUrl,
      MessageBody: body,
      MessageGroupId: crypto.randomUUID(),
      MessageDeduplicationId: crypto.randomUUID(),
    }));
    if (response.MessageId === undefined) throw new Error('LocalStack did not return an SQS message ID.');
    return response.MessageId;
  }

  async function consumeUntilProcessed(messageId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await consumer.pollOnce();
      if (await count('inbox_messages', 'message_id', messageId) === 1) return;
      await Bun.sleep(50);
    }
    throw new Error(`SQS message ${messageId} was not processed.`);
  }

  async function receiveMessageById(messageId: string) {
    return receiveMessageByIdFrom(wagerQueueUrl, messageId);
  }

  async function receiveMessageByIdFrom(queueUrl: string, messageId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0,
        VisibilityTimeout: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
      const found = response.Messages?.find(message => message.MessageId === messageId);
      if (found !== undefined) return found;
      await Bun.sleep(50);
    }
    throw new Error(`SQS message ${messageId} was not received.`);
  }

  async function receiveEvents(aggregateId: string, expected: number): Promise<PublishedEvent[]> {
    const events: PublishedEvent[] = [];
    for (let attempt = 0; attempt < 20 && events.length < expected; attempt += 1) {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: eventQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0,
      }));
      for (const message of response.Messages ?? []) {
        const body = JSON.parse(message.Body ?? '{}') as PublishedEvent;
        if (body.eventType !== undefined && body.aggregateId === aggregateId) events.push(body);
        if (message.ReceiptHandle !== undefined) {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: eventQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
        }
      }
      if (events.length < expected) await Bun.sleep(50);
    }
    return events;
  }

  async function insertOutbox(id: string): Promise<void> {
    await query(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
       values (?, ?, 'TestEvent', ?::jsonb, now(), 0)`,
      [id, crypto.randomUUID(), JSON.stringify({
        eventId: id, eventType: 'TestEvent', aggregateId: 'test', correlationId: id,
        occurredAt: new Date().toISOString(), version: 1, data: {},
      })],
    );
  }

  async function walletState(walletId: string): Promise<WalletRow | undefined> {
    return (await query<WalletRow>('select balance_amount, version from wallets where id = ?', [walletId]))[0];
  }
  async function betCount(walletId: string): Promise<number> {
    return count('wager_transactions', 'wallet_id', walletId, `and kind = 'BET'`);
  }
  async function ledgerCount(walletId: string): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count
         from wallet_ledger_entries ledger
         join wager_transactions transaction on transaction.id = ledger.transaction_id
        where ledger.wallet_id = ? and transaction.kind = 'BET'`,
      [walletId],
    );
    return Number(rows[0]?.count ?? 0);
  }
  async function outboxCount(walletId: string): Promise<number> {
    return count('outbox_messages', 'aggregate_id', walletId);
  }
  async function outboxTypes(walletId: string): Promise<OutboxTypeRow[]> {
    return query<OutboxTypeRow>(
      'select event_type from outbox_messages where aggregate_id = ? order by event_type', [walletId],
    );
  }
  async function count(table: string, column: string, value: string, suffix = ''): Promise<number> {
    const rows = await query<CountRow>(
      `select count(*)::text as count from "${table}" where "${column}" = ? ${suffix}`, [value],
    );
    return Number(rows[0]?.count ?? 0);
  }
  async function query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, params);
  }
});
