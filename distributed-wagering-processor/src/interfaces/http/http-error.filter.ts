import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { DomainError, InvalidMoneyError } from '../../shared/domain/domain-error.js';
import { WalletAlreadyExistsError } from '../../wallets/application/create-wallet-error.js';
import { ExternalTransactionConflictError, IdempotencyConflictError, LedgerPersistenceConflictError, WalletNotFoundError } from '../../wagering/application/process-bet-error.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(value: object): void } }>();
    const status = this.status(error);
    const message = error instanceof Error ? error.message : 'Internal server error.';
    response.status(status).json({ statusCode: status, message });
  }
  private status(error: unknown): number {
    if (error instanceof HttpException) return error.getStatus();
    if (error instanceof WalletNotFoundError) return HttpStatus.NOT_FOUND;
    if (error instanceof WalletAlreadyExistsError || error instanceof IdempotencyConflictError
      || error instanceof ExternalTransactionConflictError || error instanceof LedgerPersistenceConflictError) return HttpStatus.CONFLICT;
    if (error instanceof DomainError || error instanceof InvalidMoneyError) return HttpStatus.BAD_REQUEST;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
