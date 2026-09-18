import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  Param,
  Post,
  Req,
  type DynamicModule,
  type ExceptionFilter,
  type ArgumentsHost,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { Request, Response, NextFunction } from 'express';
import type { WebSocket } from 'ws';
import { HmacAuthenticator, NonceService, SessionService, SiweAuthenticator } from './auth';
import { isSecureRequest } from './config';
import { BaseApiService } from './service';
import { UnavailableDashboardReadPort, type BaseDashboardReadPort } from './dashboard';
import type {
  BaseApiConfig,
  BaseAuthContext,
  BaseClock,
  BaseNotificationPort,
  BaseSignaturePort,
  BaseSnapshotPort,
  BaseSwapQuotePort,
  BaseSwapPreflightPort,
  EligibilityPort,
  BotScope,
} from './types';
import type { BaseRepository } from './ports';

export const BASE_CONFIG = Symbol('BASE_CONFIG');
export const BASE_REPOSITORY = Symbol('BASE_REPOSITORY');
export const BASE_SNAPSHOT = Symbol('BASE_SNAPSHOT');
export const BASE_SIGNATURES = Symbol('BASE_SIGNATURES');
export const BASE_CLOCK = Symbol('BASE_CLOCK');
export const BASE_NOTIFICATIONS = Symbol('BASE_NOTIFICATIONS');
export const BASE_NONCES = Symbol('BASE_NONCES');
export const BASE_SESSIONS = Symbol('BASE_SESSIONS');
export const BASE_SIWE = Symbol('BASE_SIWE');
export const BASE_HMAC = Symbol('BASE_HMAC');
export const BASE_SERVICE = Symbol('BASE_SERVICE');
export const BASE_DASHBOARD = Symbol('BASE_DASHBOARD');
export const BASE_SWAP_QUOTES = Symbol('BASE_SWAP_QUOTES');
export const BASE_SWAP_PREFLIGHT = Symbol('BASE_SWAP_PREFLIGHT');
export const BASE_ELIGIBILITY = Symbol('BASE_ELIGIBILITY');

export interface BaseApiModuleOptions {
  readonly config: BaseApiConfig;
  readonly repository: BaseRepository;
  readonly snapshot: BaseSnapshotPort;
  readonly signatures: BaseSignaturePort;
  readonly clock: BaseClock;
  readonly notifications: BaseNotificationPort;
  readonly nonceService?: NonceService;
  readonly sessionService?: SessionService;
  readonly dashboard?: BaseDashboardReadPort;
  readonly swapQuotes?: BaseSwapQuotePort;
  readonly swapPreflight?: BaseSwapPreflightPort;
  readonly eligibility?: EligibilityPort;
}

@Injectable()
export class BaseCorsMiddleware implements NestMiddleware {
  constructor(@Inject(BASE_CONFIG) private readonly config: BaseApiConfig) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const origin = header(request, 'origin');
    if (!origin) {
      next();
      return;
    }
    const allowed = (this.config.browserOrigins ?? []).includes(origin);
    if (!allowed) {
      response.status(403).json({ code: 'CORS_ORIGIN_DENIED' });
      return;
    }
    response.header('Vary', 'Origin');
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Katon-Key-Id, X-Katon-Timestamp, X-Katon-Body-Sha256, X-Katon-Signature');
    response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.status(204).send();
      return;
    }
    next();
  }
}

@Injectable()
export class BaseTransportMiddleware implements NestMiddleware {
  constructor(@Inject(BASE_CONFIG) private readonly config: BaseApiConfig) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // CORS middleware handles the preflight response. Keep transport policy
    // from turning an otherwise valid preflight into a TLS error.
    if (request.method === 'OPTIONS') {
      next();
      return;
    }
    const authenticatedGet = request.path === '/v1/standing-bids/me' || request.path.endsWith('/route');
    const protectedPath = request.path === '/v1/ws' || request.method !== 'GET' || authenticatedGet;
    if (!protectedPath) {
      next();
      return;
    }
    const encrypted = Boolean((request.socket as { encrypted?: boolean }).encrypted);
    const forwardedProto = header(request, 'x-forwarded-proto');
    if (!isSecureRequest({
      encrypted,
      protocol: request.protocol,
      forwardedProto,
      hostname: request.hostname,
      trustProxyHops: this.config.trustProxyHops,
      allowInsecureLocal: this.config.allowInsecureLocal,
      production: process.env.NODE_ENV === 'production',
    })) {
      response.status(426).json({ code: 'TLS_REQUIRED' });
      return;
    }
    next();
  }
}

@Controller('/v1')
export class BaseApiController {
  constructor(
    @Inject(BASE_CONFIG) private readonly config: BaseApiConfig,
    @Inject(BASE_SERVICE) private readonly service: BaseApiService,
    @Inject(BASE_CLOCK) private readonly clock: BaseClock,
    @Inject(BASE_NONCES) private readonly nonces: NonceService,
    @Inject(BASE_SESSIONS) private readonly sessions: SessionService,
    @Inject(BASE_SIWE) private readonly siwe: SiweAuthenticator,
    @Inject(BASE_HMAC) private readonly hmac: HmacAuthenticator,
    @Inject(BASE_DASHBOARD) private readonly dashboard: BaseDashboardReadPort,
  ) {}

  @Get('/auth/nonce')
  async nonce(): Promise<Readonly<Record<string, string | number>>> {
    const nonce = await this.nonces.issuePersistent(this.clock.nowSeconds(), this.config);
    return {
      nonce: nonce.nonce,
      issuedAt: nonce.issuedAt,
      expirationTime: nonce.expirationTime,
      domain: nonce.domain,
      chainId: nonce.chainId,
    };
  }

  @Post('/auth/verify')
  async verify(@Body() body: unknown): Promise<Readonly<Record<string, string>>> {
    const input = parseVerifyRequest(body);
    const result = await this.siwe.verify(input, this.clock.nowSeconds());
    return { address: result.identity, sessionToken: result.sessionToken };
  }

  @Get('/facilities')
  async facilities(): Promise<readonly unknown[]> {
    return this.dashboard.getFacilities();
  }

  @Get('/facilities/:id')
  async facility(@Param('id') id: string): Promise<unknown> {
    return this.dashboard.getFacility(addressParam(id, 'facility'));
  }

  @Get('/oracles/:asset')
  async oracle(@Param('asset') asset: string): Promise<unknown> {
    return this.dashboard.getOracle(addressParam(asset, 'asset'));
  }

  @Get('/liquidations/:id/route')
  async route(@Param('id') id: string, @Req() request: Request): Promise<unknown> {
    return this.service.route(id, await this.authenticate(request));
  }

  @Post('/liquidations')
  async createLiquidation(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    return this.service.createLiquidation(body, await this.authenticate(request, 'keeper'));
  }

  @Post('/swaps/quote')
  async quoteSwap(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    return this.service.quoteSwap(body, await this.authenticate(request));
  }

  @Post('/swap-orders')
  async swapOrder(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    return this.service.swapOrder(body, await this.authenticate(request, 'lp'));
  }

  @Get('/liquidations')
  async listLiquidations(): Promise<unknown> {
    return this.service.listLiquidations();
  }

  @Get('/liquidations/:id')
  async getLiquidation(@Param('id') id: string): Promise<unknown> {
    return this.service.getLiquidation(id);
  }

  @Post('/bids')
  async placeBid(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    return this.service.placeBid(body, await this.authenticate(request, 'lp'));
  }

  @Post('/standing-bids')
  async standingBid(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    return this.service.standingBid(body, await this.authenticate(request, 'lp'));
  }

  @Get('/standing-bids/me')
  async standingBidsMe(@Req() request: Request): Promise<unknown> {
    return this.service.standingBidsMe(await this.authenticate(request, 'lp'));
  }

  private async authenticate(request: Request, requiredScope?: BotScope): Promise<BaseAuthContext> {
    const authorization = header(request, 'authorization');
    if (!authorization) throw new Error('AUTH_REQUIRED');
    if (authorization.startsWith('Bearer katon_session_')) {
      return this.sessions.authenticate(authorization.slice('Bearer '.length), this.clock.nowSeconds());
    }
    return this.hmac.authenticate({
      authorization,
      keyId: header(request, 'x-katon-key-id'),
      timestamp: header(request, 'x-katon-timestamp'),
      bodySha256: header(request, 'x-katon-body-sha256'),
      signature: header(request, 'x-katon-signature'),
      method: request.method,
      path: request.path,
      body: requestBody(request),
      requiredScope,
    });
  }
}

@WebSocketGateway({ path: '/v1/ws' })
export class BaseWebSocketGateway {
  private readonly unsubscribers = new Map<WebSocket, () => void>();

  constructor(
    @Inject(BASE_CONFIG) private readonly config: BaseApiConfig,
    @Inject(BASE_CLOCK) private readonly clock: BaseClock,
    @Inject(BASE_SESSIONS) private readonly sessions: SessionService,
    @Inject(BASE_HMAC) private readonly hmac: HmacAuthenticator,
    @Inject(BASE_NOTIFICATIONS) private readonly notifications: BaseNotificationPort,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      if (!isSecureRequest({
        encrypted: Boolean((request.socket as { encrypted?: boolean }).encrypted),
        forwardedProto: header(request, 'x-forwarded-proto'),
        hostname: hostName(request),
        trustProxyHops: this.config.trustProxyHops,
        allowInsecureLocal: this.config.allowInsecureLocal,
        production: process.env.NODE_ENV === 'production',
      })) throw new Error('TLS_REQUIRED');
      const auth = await this.authenticate(request);
      const subscribe = this.notifications.subscribe;
      if (!subscribe) throw new Error('WS_NOT_CONFIGURED');
      const unsubscribe = subscribe.call(this.notifications, auth.identity, (notification) => {
        if (client.readyState === 1) client.send(JSON.stringify({ type: notification.type, payload: notification.payload }));
      });
      this.unsubscribers.set(client, unsubscribe);
      client.send(JSON.stringify({ type: 'ready', address: auth.identity }));
    } catch {
      client.close(1008, 'AUTH_REQUIRED');
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.unsubscribers.get(client)?.();
    this.unsubscribers.delete(client);
  }

  private async authenticate(request: IncomingMessage): Promise<BaseAuthContext> {
    const authorization = header(request, 'authorization');
    if (!authorization) throw new Error('AUTH_REQUIRED');
    if (authorization.startsWith('Bearer katon_session_')) {
      return this.sessions.authenticate(authorization.slice('Bearer '.length), this.clock.nowSeconds());
    }
    return this.hmac.authenticate({
      authorization,
      keyId: header(request, 'x-katon-key-id'),
      timestamp: header(request, 'x-katon-timestamp'),
      bodySha256: header(request, 'x-katon-body-sha256'),
      signature: header(request, 'x-katon-signature'),
      method: 'GET',
      path: '/v1/ws',
      body: '',
    });
  }
}

@Injectable()
export class BaseApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const code = stableErrorCode(exception);
    response.status(errorStatus(code)).json({ code });
  }
}

/** Runs the open-RFQ rank/expiry loop without owning a wallet or submitting transactions. */
@Injectable()
export class BaseRfqTicker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;

  constructor(@Inject(BASE_SERVICE) private readonly service: Pick<BaseApiService, 'tick'>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.service.tick().catch(() => undefined);
    }, 1_000);
    const unref = (this.timer as unknown as { unref?: () => void }).unref;
    unref?.call(this.timer);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

@Module({})
export class BaseApiModule implements NestModule {
  static register(options: BaseApiModuleOptions): DynamicModule {
    const nonceService = options.nonceService ?? new NonceService();
    const sessionService = options.sessionService ?? new SessionService(options.config);
    return {
      module: BaseApiModule,
      controllers: [BaseApiController],
      providers: [
        BaseCorsMiddleware,
        BaseTransportMiddleware,
        BaseApiExceptionFilter,
        BaseRfqTicker,
        BaseWebSocketGateway,
        { provide: BASE_CONFIG, useValue: options.config },
        { provide: BASE_REPOSITORY, useValue: options.repository },
        { provide: BASE_SNAPSHOT, useValue: options.snapshot },
        { provide: BASE_SIGNATURES, useValue: options.signatures },
        { provide: BASE_CLOCK, useValue: options.clock },
        { provide: BASE_NOTIFICATIONS, useValue: options.notifications },
        { provide: BASE_NONCES, useValue: nonceService },
        { provide: BASE_SESSIONS, useValue: sessionService },
        { provide: BASE_DASHBOARD, useValue: options.dashboard ?? new UnavailableDashboardReadPort() },
        { provide: BASE_SWAP_QUOTES, useValue: options.swapQuotes },
        { provide: BASE_SWAP_PREFLIGHT, useValue: options.swapPreflight },
        { provide: BASE_ELIGIBILITY, useValue: options.eligibility },
        {
          provide: BASE_SIWE,
          useFactory: (nonces: NonceService, sessions: SessionService, config: BaseApiConfig) => new SiweAuthenticator(nonces, sessions, config),
          inject: [BASE_NONCES, BASE_SESSIONS, BASE_CONFIG],
        },
        {
          provide: BASE_HMAC,
          useFactory: (config: BaseApiConfig, clock: BaseClock) => new HmacAuthenticator(config, () => clock.nowSeconds()),
          inject: [BASE_CONFIG, BASE_CLOCK],
        },
        {
          provide: BASE_SERVICE,
          useFactory: (
            config: BaseApiConfig,
            repository: BaseRepository,
            snapshot: BaseSnapshotPort,
            signatures: BaseSignaturePort,
            clock: BaseClock,
            notifications: BaseNotificationPort,
            swapQuotes: BaseSwapQuotePort | undefined,
            swapPreflight: BaseSwapPreflightPort | undefined,
            eligibility: EligibilityPort | undefined,
          ) => new BaseApiService(config, repository, snapshot, signatures, clock, notifications, swapQuotes, eligibility, swapPreflight),
          inject: [BASE_CONFIG, BASE_REPOSITORY, BASE_SNAPSHOT, BASE_SIGNATURES, BASE_CLOCK, BASE_NOTIFICATIONS, BASE_SWAP_QUOTES, BASE_SWAP_PREFLIGHT, BASE_ELIGIBILITY],
        },
      ],
      exports: [BASE_SERVICE, BASE_REPOSITORY, BASE_SNAPSHOT, BASE_DASHBOARD],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(BaseCorsMiddleware, BaseTransportMiddleware).forRoutes('*');
  }
}

function requestBody(request: Request): string {
  const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody) return rawBody.toString('utf8');
  if (request.body === undefined) return '';
  return JSON.stringify(request.body);
}

function parseVerifyRequest(value: unknown): { readonly message: string; readonly signature: `0x${string}` } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REQUEST_OBJECT_REQUIRED');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('message') || !keys.includes('signature')) throw new Error('REQUEST_FIELDS_INVALID');
  if (typeof record.message !== 'string' || !/^0x[0-9a-fA-F]+$/.test(String(record.signature))) throw new Error('REQUEST_FIELDS_INVALID');
  return { message: record.message, signature: String(record.signature).toLowerCase() as `0x${string}` };
}

function header(request: Request | IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function addressParam(value: string, name: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`ADDRESS_INVALID:${name}`);
  return value.toLowerCase() as `0x${string}`;
}

function hostName(request: IncomingMessage): string | undefined {
  const host = header(request, 'host');
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(':')[0];
  }
}

function stableErrorCode(exception: unknown): string {
  if (exception instanceof Error && /^[A-Z0-9_:-]+$/.test(exception.message)) return exception.message;
  return 'INTERNAL_ERROR';
}

function errorStatus(code: string): number {
  if (code === 'TLS_REQUIRED') return 426;
  if (code === 'SNAPSHOT_UNAVAILABLE' || code.endsWith('_UNAVAILABLE')) return 503;
  if (code === 'INTERNAL_ERROR') return 500;
  if (code === 'RFQ_NOT_FOUND' || code === 'STANDING_BID_NOT_FOUND' || code === 'SWAP_ORDER_NOT_FOUND') return 404;
  if (code === 'UNAUTHORIZED' || code === 'BOT_SCOPE_DENIED' || code === 'SIGNER_NOT_DELEGATED' || code === 'CORS_ORIGIN_DENIED' || code === 'ELIGIBILITY_REQUIRED' || code === 'ELIGIBILITY_DENIED' || code === 'MAINNET_DISABLED' || code === 'LIQUIDATION_DISABLED') return 403;
  if (code === 'AUTH_REQUIRED' || code.startsWith('SESSION_') || code.startsWith('SIWE_') || code.startsWith('BOT_') || code === 'SIGNATURE_INVALID') return 401;
  if (code.endsWith('_EXISTS') || code === 'OPPORTUNITY_ALREADY_EXISTS') return 409;
  return 400;
}
