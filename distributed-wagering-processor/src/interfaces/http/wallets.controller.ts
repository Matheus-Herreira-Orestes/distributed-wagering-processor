import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Money } from '../../shared/domain/money.js';
import { RuntimeService } from '../runtime.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly runtime: RuntimeService) {}
  @Post()
  async create(@Body() body: { playerId?: string; initialBalance?: { amount: string; currency: string } }) {
    if (typeof body.playerId !== 'string' || body.initialBalance === undefined) throw new HttpException('Invalid wallet payload.', HttpStatus.BAD_REQUEST);
    const result = await this.runtime.createWallet({ playerId: body.playerId, initialBalance: Money.from(body.initialBalance) });
    return { id: result.wallet.id, playerId: result.wallet.playerId, balance: result.wallet.balance.toJSON(), version: result.wallet.version };
  }
  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.runtime.wallet(walletId);
    if (wallet === null) throw new HttpException('Wallet not found.', HttpStatus.NOT_FOUND);
    return wallet;
  }
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if (await this.runtime.wallet(walletId) === null) throw new HttpException('Wallet not found.', HttpStatus.NOT_FOUND);
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      throw new HttpException('limit must be an integer from 1 to 100.', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.runtime.ledger(walletId, cursor, limit === undefined ? 50 : Number(limit));
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid ledger cursor.') {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      throw error;
    }
  }
  @Post(':walletId/reconciliation')
  async reconciliation(@Param('walletId') walletId: string) {
    const result = await this.runtime.reconcile(walletId);
    if (result === null) throw new HttpException('Wallet not found.', HttpStatus.NOT_FOUND);
    return result;
  }
}
