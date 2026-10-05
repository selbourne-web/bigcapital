import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { PriceFeedManager } from '../CryptoPrices/PriceFeedManager.service';
import { PriceQuote } from '../CryptoPrices/feeds/PriceFeed';
import {
  CRYPTO_LIVE_NAMESPACE,
  CRYPTO_LIVE_OPTIONS,
  CRYPTO_LIVE_PATH,
  cryptoLiveCorsOrigin,
  DEFAULT_THROTTLE_MS,
  EVENTS,
  isOriginAllowed,
  MAX_HTTP_BUFFER_SIZE,
  MAX_ORGANIZATION_ID_LENGTH,
  MAX_SOCKETS_PER_USER,
  MAX_TOKEN_LENGTH,
  PRICES_ROOM,
  resolveAllowedOrigin,
  tenantRoom,
} from './CryptoLive.constants';
import {
  CryptoLiveAuth,
  CryptoLiveAuthError,
  CryptoLiveRejection,
} from './CryptoLiveAuth.service';
import {
  createPriceThrottle,
  PriceThrottle,
  ThrottleTimers,
} from './PriceThrottle';
import cryptoConfig from '../../common/config/crypto';

export interface CryptoLiveOptions {
  now?: () => number;
  timers?: ThrottleTimers;
  throttleMs?: number;
  maxSocketsPerUser?: number;
  allowedOrigin?: () => string;
}

/** Longest delay `setTimeout` accepts (2^31 - 1 ms); longer expiries are re-armed. */
const MAX_TIMEOUT_MS = 2_147_483_647;

interface SocketState {
  userId: number;
  tenantId: number;
  organizationId: string;
  expiresAt: number;
  /** Counted against the per-user cap. */
  reserved: boolean;
  /** `handleConnection` ran: rooms joined, counted in the org registry. */
  connected: boolean;
  timer?: unknown;
}

/**
 * Authenticated live channel for the crypto feature.
 *
 * Isolated from the legacy `SocketGateway` (namespace `/`, no auth): same engine path
 * `/socket`, different namespace `/crypto`. Nest shares one socket.io Server per path,
 * so the Server-level options of whichever gateway is created first (CORS, buffer size)
 * win; therefore the Origin rule is ALSO enforced here, in the namespace middleware
 * (it covers the websocket transport, which browsers do not subject to CORS).
 *
 * A socket joins only `prices` and `tenant:<tenantId>`, decided server-side from the
 * verified JWT and organization membership. There are no client-callable message
 * handlers, so clients cannot join, leave or subscribe to anything.
 */
@Injectable()
@WebSocketGateway({
  namespace: CRYPTO_LIVE_NAMESPACE,
  path: CRYPTO_LIVE_PATH,
  cors: { origin: cryptoLiveCorsOrigin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
})
export class CryptoLiveGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  namespace: Namespace;

  private readonly logger = new Logger(CryptoLiveGateway.name);
  private readonly states = new Map<Socket, SocketState>();
  private readonly socketsPerUser = new Map<number, number>();
  /** organizationId -> tenant room owner and its connected socket count. */
  private readonly organizations = new Map<
    string,
    { tenantId: number; sockets: number }
  >();
  private readonly throttle: PriceThrottle;
  private unsubscribe?: () => void;
  private connected = 0;

  private readonly now: () => number;
  private readonly timers: ThrottleTimers;
  private readonly maxSocketsPerUser: number;
  private readonly allowedOrigin: () => string;

  constructor(
    private readonly auth: CryptoLiveAuth,
    private readonly priceFeedManager: PriceFeedManager,
    @Optional()
    @Inject(CRYPTO_LIVE_OPTIONS)
    options: CryptoLiveOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxSocketsPerUser = options.maxSocketsPerUser ?? MAX_SOCKETS_PER_USER;
    this.allowedOrigin =
      options.allowedOrigin ??
      (() => cryptoConfig().allowedOrigin || resolveAllowedOrigin());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.throttle = createPriceThrottle(
      (ticks) =>
        this.namespace
          ?.to(PRICES_ROOM)
          .emit(EVENTS.PRICES_TICK, ticks.map(toWireQuote)),
      options.throttleMs ?? DEFAULT_THROTTLE_MS,
      this.timers,
    );
  }

  /** Number of connected (authenticated) sockets. */
  get connectedCount(): number {
    return this.connected;
  }

  onModuleInit() {
    // Subscribing opens nothing and starts no timer; quotes are ignored until a client connects.
    this.unsubscribe = this.priceFeedManager.onQuote((quote) => {
      if (this.connected > 0) this.throttle.push(quote);
    });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const socket of [...this.states.keys()]) {
      this.cleanup(socket);
      socket.disconnect(true);
    }
    this.throttle.stop();
  }

  afterInit(namespace: Namespace) {
    namespace.use((socket, next) => this.authenticateHandshake(socket, next));
  }

  /** Namespace middleware: a rejected handshake never becomes a connection. */
  async authenticateHandshake(
    socket: Socket,
    next: (error?: Error) => void,
  ): Promise<void> {
    try {
      if (
        !isOriginAllowed(
          socket.handshake?.headers?.origin,
          this.allowedOrigin(),
        )
      ) {
        throw new CryptoLiveAuthError('origin');
      }
      const { token, organizationId } = readHandshake(socket.handshake?.auth);
      const identity = await this.auth.authenticate(token, organizationId);

      if (
        (this.socketsPerUser.get(identity.userId) ?? 0) >=
        this.maxSocketsPerUser
      ) {
        throw new CryptoLiveAuthError('too-many-connections');
      }
      this.socketsPerUser.set(
        identity.userId,
        (this.socketsPerUser.get(identity.userId) ?? 0) + 1,
      );
      this.states.set(socket, {
        userId: identity.userId,
        tenantId: identity.tenantId,
        organizationId,
        expiresAt: identity.expiresAt,
        reserved: true,
        connected: false,
      });
      // The transport can close before the connection completes; release the slot then too.
      socket.conn?.once('close', () => this.cleanup(socket));
      next();
    } catch (error) {
      const category: CryptoLiveRejection =
        error instanceof CryptoLiveAuthError ? error.category : 'invalid-token';
      // Socket id and category only: never the token, auth payload or error object.
      this.logger.warn(`Socket ${socket.id} rejected: ${category}`);
      next(new Error('unauthorized'));
    }
  }

  handleConnection(client: Socket) {
    const state = this.states.get(client);
    if (!state) {
      // Not authenticated by our middleware: never keep it.
      client.disconnect(true);
      return;
    }
    state.connected = true;
    this.connected += 1;
    const org = this.organizations.get(state.organizationId);
    if (org) org.sockets += 1;
    else {
      this.organizations.set(state.organizationId, {
        tenantId: state.tenantId,
        sockets: 1,
      });
    }
    void client.join([PRICES_ROOM, tenantRoom(state.tenantId)]);
    this.armExpiry(client, state);
  }

  handleDisconnect(client: Socket) {
    this.cleanup(client);
  }

  /**
   * Emits `crypto:connection-synced` to the tenant room that owns `organizationId`.
   * Only ids and status are ever placed in the payload. An organization with no
   * connected sockets has no known room and nothing is emitted.
   */
  emitConnectionSynced(
    organizationId: string,
    connectionId: number,
    status: string,
  ): void {
    const org = this.organizations.get(organizationId);
    if (!org || !this.namespace) return;
    this.namespace
      .to(tenantRoom(org.tenantId))
      .emit(EVENTS.CONNECTION_SYNCED, { connectionId, status });
  }

  private armExpiry(client: Socket, state: SocketState) {
    const remaining = state.expiresAt - this.now();
    if (remaining <= 0) {
      this.logger.debug(`Socket ${client.id} closed: token expired`);
      this.cleanup(client);
      client.disconnect(true);
      return;
    }
    state.timer = this.timers.setTimeout(
      () => {
        state.timer = undefined;
        this.armExpiry(client, state);
      },
      Math.min(remaining, MAX_TIMEOUT_MS),
    );
  }

  /** Idempotent: releases every resource tied to one socket. */
  private cleanup(socket: Socket) {
    const state = this.states.get(socket);
    if (!state) return;
    this.states.delete(socket);
    if (state.timer !== undefined) this.timers.clearTimeout(state.timer);

    if (state.reserved) {
      const left = (this.socketsPerUser.get(state.userId) ?? 1) - 1;
      if (left > 0) this.socketsPerUser.set(state.userId, left);
      else this.socketsPerUser.delete(state.userId);
    }
    if (state.connected) {
      this.connected -= 1;
      const org = this.organizations.get(state.organizationId);
      if (org && --org.sockets <= 0)
        this.organizations.delete(state.organizationId);
      if (this.connected === 0) this.throttle.stop();
    }
  }
}

/** Validates the handshake `auth` payload: bounded non-empty strings only. */
const readHandshake = (
  auth: unknown,
): { token: string; organizationId: string } => {
  const { token, organizationId } = (auth ?? {}) as Record<string, unknown>;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    typeof organizationId !== 'string' ||
    organizationId.length === 0 ||
    organizationId.length > MAX_ORGANIZATION_ID_LENGTH
  ) {
    throw new CryptoLiveAuthError('bad-handshake');
  }
  return { token, organizationId };
};

/** Explicit field pick: nothing outside the contract can ever reach a client. */
const toWireQuote = (q: PriceQuote): PriceQuote => {
  const wire: PriceQuote = {
    asset: q.asset,
    usd: q.usd,
    source: q.source,
    asOf: q.asOf,
    stale: q.stale,
    quote: q.quote,
  };
  if (typeof q.change24hPct === 'number') wire.change24hPct = q.change24hPct;
  return wire;
};
