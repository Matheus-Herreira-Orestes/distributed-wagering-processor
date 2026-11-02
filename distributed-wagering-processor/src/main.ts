import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './interfaces/http/http-error.filter.js';

const app = await NestFactory.create(AppModule);
app.useGlobalFilters(new HttpErrorFilter());
await app.listen(process.env.PORT ?? 3000);
