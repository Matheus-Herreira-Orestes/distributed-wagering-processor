import { Controller, Get } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { RuntimeService } from '../runtime.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly runtime: RuntimeService) {}
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    if (!await this.runtime.ready()) throw new ServiceUnavailableException('PostgreSQL or SQS is unavailable.');
    return { status: 'ok' };
  }
}
