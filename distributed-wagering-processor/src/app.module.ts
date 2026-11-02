import { Module } from '@nestjs/common';
import { HealthController } from './interfaces/http/health.controller.js';
import { WalletsController } from './interfaces/http/wallets.controller.js';
import { WageringController } from './interfaces/http/wagering.controller.js';
import { MetricsController } from './interfaces/http/metrics.controller.js';
import { RuntimeService } from './interfaces/runtime.service.js';

@Module({
  controllers: [HealthController, WalletsController, WageringController, MetricsController],
  providers: [RuntimeService],
})
export class AppModule {}
