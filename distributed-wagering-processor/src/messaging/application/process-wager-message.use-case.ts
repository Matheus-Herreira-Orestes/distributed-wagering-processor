import { Money, type MoneyProps } from '../../shared/domain/money.js';
import type { ProcessBetResult } from '../../wagering/application/process-bet.use-case.js';
import type { ProcessBetRepositories } from '../../wagering/application/ports/process-bet.persistence-port.js';
import type { ProcessWagerTransactionInput, ProcessWagerTransactionResult } from '../../wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.js';
import { InboxMessage } from '../domain/inbox-message.js';
import type { WagerMessageUnitOfWork } from './ports/process-wager-message.persistence-port.js';
import { InvalidWagerMessageError } from './process-wager-message-error.js';
import { isTerminalWagerConsumerError } from './terminal-wager-consumer-error.js';

export const WAGER_BET_CONSUMER = 'wager-bet-consumer';

export interface WagerTransactionRequestedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionRequested {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: WagerTransactionRequestedData;
}

export interface ProcessWagerMessageResult {
  duplicateMessage: boolean;
  bet?: ProcessWagerTransactionResult | ProcessBetResult;
  terminalFailure?: { name: string; message: string };
}

interface WagerProcessor {
  executeInTransaction(
    input: ProcessWagerTransactionInput,
    repositories: ProcessBetRepositories,
  ): Promise<ProcessWagerTransactionResult | ProcessBetResult>;
}

export class ProcessWagerMessageUseCase {
  constructor(
    private readonly unitOfWork: WagerMessageUnitOfWork,
    private readonly processBet: WagerProcessor,
    private readonly consumerName = WAGER_BET_CONSUMER,
  ) {}

  async execute(body: string): Promise<ProcessWagerMessageResult> {
    const request = parseWagerTransactionRequested(body);
    const payloadHash = await sha256(body);
    const now = new Date();

    return this.unitOfWork.transactional(async context => {
      const inbox = InboxMessage.receive({
        consumerName: this.consumerName,
        messageId: request.messageId,
        payloadHash,
        receivedAt: now,
      });
      if (!await context.inbox.insert(inbox)) {
        return { duplicateMessage: true };
      }

      let result: ProcessWagerTransactionResult | ProcessBetResult;
      try {
        result = await this.processBet.executeInTransaction({
          providerId: request.data.providerId,
          externalTransactionId: request.data.externalTransactionId,
          idempotencyKey: request.data.idempotencyKey,
          playerId: request.data.playerId,
          walletId: request.data.walletId,
          roundId: request.data.roundId,
          gameId: request.data.gameId,
          kind: request.data.kind as WagerTransactionKind,
          money: Money.from(request.data.money),
          ...(request.data.referenceExternalTransactionId === undefined
            ? {} : { referenceExternalTransactionId: request.data.referenceExternalTransactionId }),
        }, context.bet);
      } catch (error) {
        if (!isTerminalWagerConsumerError(error)) throw error;
        inbox.markProcessed(new Date());
        await context.inbox.markProcessed(inbox);
        return {
          duplicateMessage: false,
          terminalFailure: { name: error.name, message: error.message },
        };
      }

      inbox.markProcessed(new Date());
      await context.inbox.markProcessed(inbox);
      return { duplicateMessage: false, bet: result };
    });
  }
}

export function parseWagerTransactionRequested(body: string): WagerTransactionRequested {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError('WagerTransactionRequested body must be valid JSON.');
  }
  if (!isRecord(value) || value.type !== 'WagerTransactionRequested' || !isRecord(value.data)) {
    throw new InvalidWagerMessageError('Message type must be WagerTransactionRequested.');
  }
  const data = value.data;
  const required = [
    'providerId', 'externalTransactionId', 'idempotencyKey', 'playerId',
    'walletId', 'roundId', 'gameId',
  ] as const;
  if (!isNonEmptyString(value.messageId)
    || !isValidDateString(value.occurredAt)
    || required.some(key => !isNonEmptyString(data[key]))
    || !Object.values(WagerTransactionKind).includes(data.kind as WagerTransactionKind)
    || data.kind === WagerTransactionKind.OPENING
    || !isRecord(data.money)
    || typeof data.money.amount !== 'string'
    || typeof data.money.currency !== 'string'
    || (data.referenceExternalTransactionId !== undefined && !isNonEmptyString(data.referenceExternalTransactionId))) {
    throw new InvalidWagerMessageError('WagerTransactionRequested has invalid fields.');
  }
  return value as unknown as WagerTransactionRequested;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
