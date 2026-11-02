import { Controller, Get } from '@nestjs/common';
import { RuntimeService } from '../runtime.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly runtime: RuntimeService) {}
  @Get()
  get(): Promise<Record<string, number>> { return this.runtime.metricsSnapshot(); }
}
