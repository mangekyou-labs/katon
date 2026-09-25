import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import {
  BaseApiExceptionFilter,
  BaseApiModule,
  type BaseApiModuleOptions,
} from './module';

export async function createBaseApi(options: BaseApiModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(BaseApiModule.register(options), { rawBody: true });
  app.getHttpAdapter().getInstance().set('trust proxy', options.config.trustProxyHops);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalFilters(new BaseApiExceptionFilter());
  await options.repository.ensureIndexes?.();
  return app;
}

export * from './adapters';
export * from './auth';
export * from './config';
export * from './dashboard';
export * from './external-providers';
export * from './memory';
export * from './module';
export * from './mongo';
export * from './ports';
export * from './service';
export * from './swap-sources';
export * from './types';
export {
  domainFor,
  orderToStored,
  parseBidRequest,
  parseLiquidationRequest,
  parseStandingBidRequest,
  parseSwapOrderRequest,
  parseSwapQuoteRequest,
  swapDomainFor,
  swapOrderToStored,
  storedToSwapOrder,
  storedToOrder,
  ZERO_HASH,
} from './validation';
export type { BidRequestInput, LiquidationRequestInput, StandingBidRequestInput, SwapOrderRequestInput, SwapQuoteRequestInput } from './validation';
