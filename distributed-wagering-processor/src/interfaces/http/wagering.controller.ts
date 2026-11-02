import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { Money } from '../../shared/domain/money.js';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.js';
import { RuntimeService } from '../runtime.service.js';
import { log, metrics } from '../../observability.js';

@Controller()
export class WageringController {
  constructor(private readonly runtime: RuntimeService) {}
  @Post('wagering/transactions')
  async submit(@Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) throw new HttpException('Idempotency-Key is required.', HttpStatus.BAD_REQUEST);
    const fields = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId'] as const;
    const referenceExternalTransactionId = body.referenceExternalTransactionId;
    if (fields.some(key => typeof body[key] !== 'string') || typeof body.kind !== 'string' || !Object.values(WagerTransactionKind).includes(body.kind as WagerTransactionKind) || body.kind === WagerTransactionKind.OPENING || typeof body.money !== 'object' || body.money === null) {
      throw new HttpException('Invalid wager payload.', HttpStatus.BAD_REQUEST);
    }
    if (referenceExternalTransactionId !== undefined
      && (typeof referenceExternalTransactionId !== 'string' || referenceExternalTransactionId.trim().length === 0)) {
      throw new HttpException('referenceExternalTransactionId must be a non-empty string.', HttpStatus.BAD_REQUEST);
    }
    const result = await this.runtime.processWager({
      providerId: body.providerId as string, externalTransactionId: body.externalTransactionId as string, idempotencyKey,
      playerId: body.playerId as string, walletId: body.walletId as string, roundId: body.roundId as string,
      gameId: body.gameId as string, kind: body.kind as WagerTransactionKind, money: Money.from(body.money as { amount: string; currency: string }),
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    });
    metrics.increment('wager_transactions_total', { kind: body.kind as string, status: result.status, replay: String(result.idempotentReplay) });
    log('wager_transaction_committed', { transactionId: result.transactionId, walletId: body.walletId,
      providerId: body.providerId, correlationId: result.transactionId, status: result.status, idempotentReplay: result.idempotentReplay });
    response.status(result.status === 'REJECTED' ? HttpStatus.UNPROCESSABLE_ENTITY : result.status === 'PENDING_REFERENCE' ? HttpStatus.ACCEPTED : HttpStatus.CREATED);
    return { ...result, balance: result.balance.toJSON() };
  }
  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') id: string) {
    const result = await this.runtime.transaction('id = ?', [id]);
    if (result === null) throw new HttpException('Transaction not found.', HttpStatus.NOT_FOUND);
    return result;
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    const result = await this.runtime.transaction('provider_id = ? and external_transaction_id = ?', [providerId, externalTransactionId]);
    if (result === null) throw new HttpException('Transaction not found.', HttpStatus.NOT_FOUND);
    return result;
  }
}
