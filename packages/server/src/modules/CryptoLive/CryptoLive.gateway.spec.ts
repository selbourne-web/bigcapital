import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MESSAGE_MAPPING_METADATA } from '@nestjs/websockets/constants';
import { TenantModel } from '../System/models/TenantModel';
import { SystemUser } from '../System/models/SystemUser';
import { UserTenant } from '../System/models/UserTenant.model';
import { PriceFeedManager } from '../CryptoPrices/PriceFeedManager.service';
import { PriceCache } from '../CryptoPrices/PriceCache.service';
import { SocketGateway } from '../Socket/Socket.gateway';
import { PriceQuote } from '../CryptoPrices/feeds/PriceFeed';
import { CRYPTO_LIVE_EMITTER } from '../CryptoExchanges/CryptoExchanges.types';
import {
  CRYPTO_LIVE_NAMESPACE,
  EVENTS,
  isOriginAllowed,
  PRICES_ROOM,
  resolveAllowedOrigin,
  tenantRoom,
} from './CryptoLive.constants';
import { CryptoLiveGateway } from './CryptoLive.gateway';
import { CryptoLiveAuth, CryptoLiveAuthError } from './CryptoLiveAuth.service';
import { CryptoLiveEmitterService } from './CryptoLiveEmitter.service';
import { cryptoLiveProviders } from './CryptoLive.module';
import { readFileSync } from 'fs';
import { join } from 'path';

const NOW = 1_800_000_000_000;

/** Records `namespace.to(room).emit(event, payload)`. */
class FakeNamespace {
  emitted: { room: string; event: string; payload: unknown }[] = [];
  middleware?: (socket: any, next: (e?: Error) => void) => unknown;
  use(fn: any) {
    this.middleware = fn;
  }
  to(room: string) {
    return {
      emit: (event: string, payload: unknown) =>
        this.emitted.push({ room, event, payload }),
    };
  }
  in(room: string) {
    return this.to(room);
  }
  emit(event: string, payload: unknown) {
    this.emitted.push({ room: '<ALL>', event, payload });
  }
}

let seq = 0;
const makeSocket = (auth: unknown, headers: Record<string, string> = {}) => {
  const socket: any = {
    id: `sock-${++seq}`,
    handshake: { auth, headers },
    data: {},
    conn: new EventEmitter(),
    rooms: new Set<string>(),
    join: jest.fn((rooms: string | string[]) => {
      for (const r of ([] as string[]).concat(rooms)) socket.rooms.add(r);
    }),
    leave: jest.fn(),
    disconnect: jest.fn(),
  };
  return socket;
};

const fakePrices = () => {
  const listeners = new Set<(q: PriceQuote) => void>();
  const unsubscribe = jest.fn();
  return {
    listeners,
    unsubscribe,
    manager: {
      onQuote: jest.fn((cb: (q: PriceQuote) => void) => {
        listeners.add(cb);
        return () => {
          unsubscribe();
          listeners.delete(cb);
        };
      }),
    } as unknown as PriceFeedManager,
    quote: (q: PriceQuote) => listeners.forEach((l) => l(q)),
  };
};

const quote = (asset: string, usd: number, extra: object = {}) =>
  ({
    asset,
    usd,
    source: 'kraken',
    asOf: NOW,
    stale: false,
    quote: 'USD',
    ...extra,
  }) as PriceQuote;

/** Identity table: token -> who it belongs to. Everything else is rejected. */
const fakeAuth = () =>
  ({
    authenticate: jest.fn(async (token: string, organizationId: string) => {
      const table: Record<
        string,
        { userId: number; orgs: Record<string, number>; exp: number }
      > = {
        'tok-u1': { userId: 1, orgs: { 'org-a': 10 }, exp: NOW + 60_000 },
        'tok-u2': { userId: 2, orgs: { 'org-b': 20 }, exp: NOW + 600_000 },
        'tok-expired': { userId: 3, orgs: { 'org-a': 10 }, exp: NOW - 1 },
      };
      const row = table[token];
      if (!row) throw new CryptoLiveAuthError('invalid-token');
      if (row.exp <= NOW) throw new CryptoLiveAuthError('token-expired');
      // Like MySQL, the organization lookup is case-insensitive and yields the
      // canonical spelling stored in the tenants table.
      const canonical = Object.keys(row.orgs).find(
        (k) => k.toLowerCase() === organizationId.toLowerCase(),
      );
      if (!canonical) throw new CryptoLiveAuthError('not-member');
      return {
        userId: row.userId,
        tenantId: row.orgs[canonical],
        organizationId: canonical,
        expiresAt: row.exp,
      };
    }),
  }) as unknown as CryptoLiveAuth & { authenticate: jest.Mock };

const setup = (options: Record<string, unknown> = {}) => {
  jest.useFakeTimers({ now: NOW });
  const ns = new FakeNamespace();
  const prices = fakePrices();
  const auth = fakeAuth();
  const cache = { all: jest.fn(async (): Promise<PriceQuote[]> => []) };
  const gateway = new CryptoLiveGateway(
    auth,
    prices.manager,
    cache as unknown as PriceCache,
    {
      allowedOrigin: () => 'https://app.example.com',
      ...options,
    },
  );
  (gateway as any).namespace = ns;
  gateway.afterInit(ns as any);
  gateway.onModuleInit();

  /** Runs the namespace middleware, then the connection handler on success. */
  const connect = async (socket: any) => {
    const next = jest.fn();
    await ns.middleware!(socket, next);
    const error: Error | undefined = next.mock.calls[0]?.[0];
    if (!error) {
      gateway.handleConnection(socket);
      // let the async price snapshot settle
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    return { error, next };
  };
  return { gateway, ns, prices, auth, cache, connect };
};

beforeAll(() => Logger.overrideLogger(false));

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('CORS origin rules', () => {
  const allowed = 'https://app.example.com';

  it('allows a request with no Origin header (same-origin proxy / non-browser)', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed('', allowed)).toBe(true);
  });

  it('allows exactly the configured origin (trailing slash and case tolerant)', () => {
    expect(isOriginAllowed('https://app.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://app.example.com', `${allowed}/`)).toBe(
      true,
    );
    expect(isOriginAllowed('HTTPS://APP.EXAMPLE.COM', allowed)).toBe(true);
  });

  it('denies every other origin, including lookalikes', () => {
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://app.example.com.evil.io', allowed)).toBe(
      false,
    );
    expect(isOriginAllowed('http://app.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('null', allowed)).toBe(false);
  });

  it('denies all cross-origin requests when nothing is configured, and never treats * as a wildcard', () => {
    expect(isOriginAllowed('https://app.example.com', '')).toBe(false);
    expect(isOriginAllowed('https://anything.test', '*')).toBe(false);
    expect(isOriginAllowed(undefined, '')).toBe(true); // no Origin: not a browser cross-origin call
  });

  it('prefers CRYPTO_ALLOWED_ORIGIN over BASE_URL and falls back to BASE_URL', () => {
    expect(
      resolveAllowedOrigin({
        CRYPTO_ALLOWED_ORIGIN: 'https://a.test',
        BASE_URL: 'https://b.test',
      } as any),
    ).toBe('https://a.test');
    expect(resolveAllowedOrigin({ BASE_URL: 'https://b.test' } as any)).toBe(
      'https://b.test',
    );
    expect(resolveAllowedOrigin({} as any)).toBe('');
  });

  it('declares the /crypto namespace on the shared /socket path', () => {
    const options = Reflect.getMetadata(
      'websockets:gateway_options',
      CryptoLiveGateway,
    );
    expect(options.namespace).toBe(CRYPTO_LIVE_NAMESPACE);
    expect(options.namespace).toBe('/crypto');
    expect(options.path).toBe('/socket');
  });

  it('declares the SAME engine-level options as the legacy gateway, so Nest scan order cannot change either namespace', () => {
    // Nest keeps one socket.io Server per path; the first-scanned gateway's
    // options become server-wide. Both must therefore be equivalent.
    const engineOptions = (gateway: unknown) => {
      const { namespace: _n, ...rest } = Reflect.getMetadata(
        'websockets:gateway_options',
        gateway as object,
      );
      return rest;
    };
    const legacy = engineOptions(SocketGateway);
    expect(legacy.path).toBe('/socket');
    expect(engineOptions(CryptoLiveGateway)).toEqual(legacy);
    expect(engineOptions(CryptoLiveGateway)).not.toHaveProperty(
      'maxHttpBufferSize',
    );
  });

  it('does not honour a wildcard Origin in the middleware (authoritative check)', async () => {
    const { connect, auth } = setup();
    const s = makeSocket(
      { token: 'tok-u1', organizationId: 'org-a' },
      { origin: '*' },
    );
    expect((await connect(s)).error).toBeInstanceOf(Error);
    expect(auth.authenticate).not.toHaveBeenCalled();
    // and with a wildcard configured, any present Origin is still refused
    const wild = setup({ allowedOrigin: () => '*' });
    const s2 = makeSocket(
      { token: 'tok-u1', organizationId: 'org-a' },
      { origin: 'https://app.example.com' },
    );
    expect((await wild.connect(s2)).error).toBeInstanceOf(Error);
  });
});

describe('CryptoLiveGateway handshake', () => {
  it('refuses a connection with no auth payload at all', async () => {
    const { connect, auth } = setup();
    const { error } = await connect(makeSocket(undefined));
    expect(error).toBeInstanceOf(Error);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing token', { organizationId: 'org-a' }],
    ['missing organizationId', { token: 'tok-u1' }],
    ['empty token', { token: '', organizationId: 'org-a' }],
    ['empty organizationId', { token: 'tok-u1', organizationId: '' }],
    ['non-string token', { token: 123, organizationId: 'org-a' }],
    ['object organizationId', { token: 'tok-u1', organizationId: { $ne: 1 } }],
    ['oversized token', { token: 'x'.repeat(5000), organizationId: 'org-a' }],
    [
      'oversized organizationId',
      { token: 'tok-u1', organizationId: 'o'.repeat(500) },
    ],
  ])('refuses %s without consulting the auth service', async (_n, auth) => {
    const ctx = setup();
    const { error } = await ctx.connect(makeSocket(auth));
    expect(error).toBeInstanceOf(Error);
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
  });

  it('refuses an invalid token and an expired token', async () => {
    const { connect } = setup();
    expect(
      (await connect(makeSocket({ token: 'bogus', organizationId: 'org-a' })))
        .error,
    ).toBeInstanceOf(Error);
    expect(
      (
        await connect(
          makeSocket({ token: 'tok-expired', organizationId: 'org-a' }),
        )
      ).error,
    ).toBeInstanceOf(Error);
  });

  it('refuses a valid token for an organization the user does not belong to', async () => {
    const { connect, gateway } = setup();
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-b' });
    const { error } = await connect(s);
    expect(error).toBeInstanceOf(Error);
    expect(s.join).not.toHaveBeenCalled();
    expect(gateway.connectedCount).toBe(0);
  });

  it('gives every rejection the same client-facing message (no enumeration)', async () => {
    const { connect } = setup();
    const messages = new Set<string>();
    for (const auth of [
      { token: 'bogus', organizationId: 'org-a' },
      { token: 'tok-expired', organizationId: 'org-a' },
      { token: 'tok-u1', organizationId: 'org-b' },
      { organizationId: 'org-a' },
    ]) {
      messages.add((await connect(makeSocket(auth))).error!.message);
    }
    expect([...messages]).toEqual(['unauthorized']);
  });

  it('refuses a disallowed browser Origin even with a valid token', async () => {
    const { connect, auth } = setup();
    const s = makeSocket(
      { token: 'tok-u1', organizationId: 'org-a' },
      { origin: 'https://evil.example.com' },
    );
    expect((await connect(s)).error).toBeInstanceOf(Error);
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('accepts the allowed Origin and a request without Origin', async () => {
    const { connect } = setup();
    const withOrigin = makeSocket(
      { token: 'tok-u1', organizationId: 'org-a' },
      { origin: 'https://app.example.com' },
    );
    const noOrigin = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    expect((await connect(withOrigin)).error).toBeUndefined();
    expect((await connect(noOrigin)).error).toBeUndefined();
  });

  it('on success joins exactly the prices room and the tenant room, nothing else', async () => {
    const { connect, gateway } = setup();
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    expect((await connect(s)).error).toBeUndefined();

    expect([...s.rooms].sort()).toEqual([PRICES_ROOM, tenantRoom(10)].sort());
    expect(PRICES_ROOM).toBe('prices');
    expect(tenantRoom(10)).toBe('tenant:10');
    expect(gateway.connectedCount).toBe(1);
  });

  it('exposes no client-callable message handlers, so a fake join/subscribe changes nothing', async () => {
    const { connect } = setup();
    const proto = CryptoLiveGateway.prototype as any;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        typeof Object.getOwnPropertyDescriptor(proto, name)?.value ===
          'function' &&
        Reflect.getMetadata(MESSAGE_MAPPING_METADATA, proto[name]) !==
          undefined,
    );
    expect(handlers).toEqual([]);

    // A client emitting `join` for another tenant's room reaches no listener:
    // the gateway registers none on the socket.
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    s.on = jest.fn();
    s.onAny = jest.fn();
    await connect(s);
    expect(s.on).not.toHaveBeenCalled();
    expect(s.onAny).not.toHaveBeenCalled();
    expect(s.join).toHaveBeenCalledTimes(1);
    expect([...s.rooms]).not.toContain(tenantRoom(20));
  });
});

describe('connection limits and cleanup', () => {
  it('refuses the 11th concurrent socket of one user and frees a slot on disconnect', async () => {
    const { connect, gateway } = setup();
    const creds = { token: 'tok-u1', organizationId: 'org-a' };
    const sockets: any[] = [];
    for (let i = 0; i < 10; i++) {
      const s = makeSocket(creds);
      expect((await connect(s)).error).toBeUndefined();
      sockets.push(s);
    }
    expect((await connect(makeSocket(creds))).error).toBeInstanceOf(Error);
    expect(gateway.connectedCount).toBe(10);

    // another user is unaffected
    expect(
      (await connect(makeSocket({ token: 'tok-u2', organizationId: 'org-b' })))
        .error,
    ).toBeUndefined();

    gateway.handleDisconnect(sockets[0]);
    expect((await connect(makeSocket(creds))).error).toBeUndefined();
  });

  it('frees the slot when the transport closes before the connection completes', async () => {
    const { gateway, ns, auth } = setup({ maxSocketsPerUser: 1 });
    const creds = { token: 'tok-u1', organizationId: 'org-a' };
    const first = makeSocket(creds);
    await ns.middleware!(first, jest.fn()); // authenticated, never reached handleConnection
    first.conn.emit('close');

    const second = makeSocket(creds);
    const next = jest.fn();
    await ns.middleware!(second, next);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(auth.authenticate).toHaveBeenCalledTimes(2);
    expect(gateway.connectedCount).toBe(0);
  });

  it('disconnects the socket when the JWT expires (and not before)', async () => {
    const { connect, gateway } = setup();
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' }); // exp = NOW + 60s
    await connect(s);

    jest.advanceTimersByTime(59_999);
    expect(s.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(s.disconnect).toHaveBeenCalledWith(true);
    expect(gateway.connectedCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('survives expiries beyond the 32-bit setTimeout limit', async () => {
    const { connect, auth } = setup();
    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
    auth.authenticate.mockResolvedValueOnce({
      userId: 5,
      tenantId: 50,
      organizationId: 'org-x',
      expiresAt: NOW + THIRTY_DAYS,
    });
    const s = makeSocket({ token: 'whatever', organizationId: 'org-x' });
    await connect(s);

    jest.advanceTimersByTime(THIRTY_DAYS - 1);
    expect(s.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it('clears the expiry timer when the client disconnects first', async () => {
    const { connect, gateway } = setup();
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    await connect(s);
    expect(jest.getTimerCount()).toBe(1);

    gateway.handleDisconnect(s);
    expect(jest.getTimerCount()).toBe(0);
    gateway.handleDisconnect(s); // idempotent
    expect(gateway.connectedCount).toBe(0);
  });

  it('uses an injected clock/timers instead of the globals', async () => {
    const handle = {} as any;
    const timers = {
      setTimeout: jest.fn().mockReturnValue(handle),
      clearTimeout: jest.fn(),
    };
    const { connect, gateway } = setup({ now: () => NOW, timers });
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    await connect(s);
    expect(timers.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
    );
    gateway.handleDisconnect(s);
    expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
  });
});

describe('price ticks', () => {
  it('broadcasts throttled ticks (latest per asset, contract fields) to the prices room only', async () => {
    const { connect, prices, ns } = setup({ throttleMs: 1000 });
    await connect(makeSocket({ token: 'tok-u2', organizationId: 'org-b' }));

    prices.quote(quote('BTC', 100));
    prices.quote(
      quote('BTC', 101, {
        source: 'binance',
        quote: 'USDT',
        change24hPct: 2.5,
      }),
    );
    prices.quote(quote('ETH', 10, { stale: true }));
    expect(ns.emitted).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    expect(ns.emitted).toHaveLength(1);
    const [msg] = ns.emitted;
    expect(msg.room).toBe(PRICES_ROOM);
    expect(msg.event).toBe(EVENTS.PRICES_TICK);
    expect(EVENTS.PRICES_TICK).toBe('prices:tick');
    const ticks = msg.payload as PriceQuote[];
    expect(ticks).toHaveLength(2);
    expect(ticks.find((t) => t.asset === 'BTC')).toEqual({
      asset: 'BTC',
      usd: 101,
      source: 'binance',
      asOf: NOW,
      stale: false,
      quote: 'USDT',
      change24hPct: 2.5,
    });
    expect(ticks.find((t) => t.asset === 'ETH')?.stale).toBe(true);
  });

  it('keeps working (and keeps no timers) when no quotes ever arrive', async () => {
    const { connect, ns } = setup();
    await connect(makeSocket({ token: 'tok-u2', organizationId: 'org-b' }));
    jest.advanceTimersByTime(10_000);
    expect(ns.emitted).toHaveLength(0);
    // only the token-expiry timer of the connected socket exists
    expect(jest.getTimerCount()).toBe(1);
  });

  it('ignores quotes (no throttle timer) while nobody is connected', () => {
    const { prices, ns } = setup();
    prices.quote(quote('BTC', 100));
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(ns.emitted).toHaveLength(0);
  });

  it('stops the throttle timer and drops pending ticks when the last client leaves', async () => {
    const { connect, gateway, prices, ns } = setup();
    const s = makeSocket({ token: 'tok-u2', organizationId: 'org-b' });
    await connect(s);
    prices.quote(quote('BTC', 100));
    expect(jest.getTimerCount()).toBe(2); // expiry + throttle

    gateway.handleDisconnect(s);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(ns.emitted).toHaveLength(0);
  });
});

describe('connection-synced events', () => {
  it('reaches ONLY the owning tenant room, with ids and status only', async () => {
    const { connect, gateway, ns } = setup();
    await connect(makeSocket({ token: 'tok-u1', organizationId: 'org-a' }));
    await connect(makeSocket({ token: 'tok-u2', organizationId: 'org-b' }));

    gateway.emitConnectionSynced('org-a', 42, 'active');

    expect(ns.emitted).toEqual([
      {
        room: tenantRoom(10),
        event: EVENTS.CONNECTION_SYNCED,
        payload: { connectionId: 42, status: 'active' },
      },
    ]);
    expect(EVENTS.CONNECTION_SYNCED).toBe('crypto:connection-synced');
  });

  it('emits nothing for an organization with no connected sockets, and again after they leave', async () => {
    const { connect, gateway, ns } = setup();
    gateway.emitConnectionSynced('org-a', 1, 'active');
    expect(ns.emitted).toHaveLength(0);

    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    await connect(s);
    gateway.emitConnectionSynced('org-a', 1, 'active');
    expect(ns.emitted).toHaveLength(1);

    gateway.handleDisconnect(s);
    gateway.emitConnectionSynced('org-a', 1, 'active');
    expect(ns.emitted).toHaveLength(1);
  });

  it('is what the CRYPTO_LIVE_EMITTER wrapper calls', async () => {
    const { connect, gateway, ns } = setup();
    await connect(makeSocket({ token: 'tok-u2', organizationId: 'org-b' }));
    new CryptoLiveEmitterService(gateway).connectionSynced('org-b', 7, 'error');
    expect(ns.emitted).toEqual([
      {
        room: tenantRoom(20),
        event: 'crypto:connection-synced',
        payload: { connectionId: 7, status: 'error' },
      },
    ]);
  });

  it('never throws into the sync processor when the server is not ready', () => {
    const gateway = new CryptoLiveGateway(fakeAuth(), fakePrices().manager, {
      all: async () => [],
    } as unknown as PriceCache);
    expect(() =>
      new CryptoLiveEmitterService(gateway).connectionSynced(
        'org-a',
        1,
        'active',
      ),
    ).not.toThrow();
  });
});

describe('payload hygiene', () => {
  const FORBIDDEN =
    /free|locked|balance|secret|passphrase|apikey|api_key|credential|token|password/i;
  const keysDeep = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        keysDeep(v, out);
      }
    }
    return out;
  };

  it('no emitted payload carries balances or secrets, even if upstream objects carry extras', async () => {
    const { connect, gateway, prices, ns } = setup();
    await connect(makeSocket({ token: 'tok-u1', organizationId: 'org-a' }));

    prices.quote(
      quote('BTC', 100, {
        free: '1.5',
        locked: '0.1',
        balance: 5,
        apiSecret: 'shh',
        nested: { balance: 1 },
      }),
    );
    jest.advanceTimersByTime(1000);
    (gateway as any).emitConnectionSynced('org-a', 3, 'active', {
      balances: [{ asset: 'BTC', free: '1', locked: '0' }],
      apiKey: 'k',
    });

    expect(ns.emitted.length).toBe(2);
    const keys = ns.emitted.flatMap((m) => keysDeep(m.payload));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => FORBIDDEN.test(k))).toEqual([]);
    expect(JSON.stringify(ns.emitted)).not.toMatch(/shh|"k"/);
  });
});

describe('lifecycle', () => {
  it('subscribes to onQuote once and unsubscribes on destroy, leaving no timers', async () => {
    const { connect, gateway, prices } = setup();
    expect(prices.manager.onQuote).toHaveBeenCalledTimes(1);
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    await connect(s);
    prices.quote(quote('BTC', 1));
    expect(jest.getTimerCount()).toBe(2);

    gateway.onModuleDestroy();

    expect(prices.unsubscribe).toHaveBeenCalledTimes(1);
    expect(prices.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(gateway.connectedCount).toBe(0);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('starts no outbound sockets and makes no timers by itself', () => {
    const { gateway } = setup();
    expect(jest.getTimerCount()).toBe(0);
    gateway.onModuleDestroy();
  });
});

describe('organization id case', () => {
  it('reaches the tenant room whatever the spelling of the client or of the sync job', async () => {
    const { connect, gateway, ns } = setup();
    // client connects with a different spelling than the canonical 'org-a'
    await connect(makeSocket({ token: 'tok-u1', organizationId: 'ORG-A' }));

    gateway.emitConnectionSynced('org-a', 1, 'active');
    gateway.emitConnectionSynced('ORG-A', 2, 'active');

    expect(
      ns.emitted.map((m) => [m.room, (m.payload as any).connectionId]),
    ).toEqual([
      [tenantRoom(10), 1],
      [tenantRoom(10), 2],
    ]);
  });

  it('counts sockets of one organization connecting with different spellings together', async () => {
    const { connect, gateway, ns } = setup();
    const a = makeSocket({ token: 'tok-u1', organizationId: 'ORG-A' });
    const b = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    await connect(a);
    await connect(b);
    gateway.handleDisconnect(a);
    gateway.emitConnectionSynced('org-a', 1, 'active');
    expect(ns.emitted).toHaveLength(1); // still reachable through b
    gateway.handleDisconnect(b);
    gateway.emitConnectionSynced('org-a', 1, 'active');
    expect(ns.emitted).toHaveLength(1);
  });
});

describe('price snapshot on connect', () => {
  it('sends the cached prices to the connecting socket only', async () => {
    const { connect, cache } = setup();
    const first = makeSocket({ token: 'tok-u2', organizationId: 'org-b' });
    first.emit = jest.fn();
    await connect(first);
    expect(first.emit).not.toHaveBeenCalled(); // empty cache: nothing sent

    cache.all.mockResolvedValue([
      quote('BTC', 100, { balance: 9, free: '1' }),
      quote('ETH', 10, { change24hPct: 1.5 }),
    ]);
    const second = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    second.emit = jest.fn();
    await connect(second);

    expect(second.emit).toHaveBeenCalledTimes(1);
    const [event, ticks] = second.emit.mock.calls[0];
    expect(event).toBe(EVENTS.PRICES_TICK);
    expect(ticks).toEqual([
      {
        asset: 'BTC',
        usd: 100,
        source: 'kraken',
        asOf: NOW,
        stale: false,
        quote: 'USD',
      },
      {
        asset: 'ETH',
        usd: 10,
        source: 'kraken',
        asOf: NOW,
        stale: false,
        quote: 'USD',
        change24hPct: 1.5,
      },
    ]);
    expect(first.emit).not.toHaveBeenCalled(); // the already-connected socket gets nothing
  });

  it('survives a failing cache and does not send to a socket that left meanwhile', async () => {
    const { connect, gateway, cache } = setup();
    cache.all.mockRejectedValueOnce(new Error('redis down'));
    const s = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    s.emit = jest.fn();
    expect((await connect(s)).error).toBeUndefined();
    expect(s.emit).not.toHaveBeenCalled();

    cache.all.mockResolvedValueOnce([quote('BTC', 1)]);
    const t = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    t.emit = jest.fn();
    await connect(t);
    // connect() already settled; simulate leaving before the snapshot resolves
    const u = makeSocket({ token: 'tok-u1', organizationId: 'org-a' });
    u.emit = jest.fn();
    let release!: (q: PriceQuote[]) => void;
    cache.all.mockReturnValueOnce(new Promise((r) => (release = r)));
    const next = jest.fn();
    await (gateway as any).authenticateHandshake(u, next);
    gateway.handleConnection(u);
    gateway.handleDisconnect(u);
    release([quote('BTC', 1)]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(u.emit).not.toHaveBeenCalled();
  });
});

describe('Nest wiring (real providers, stubbed externals)', () => {
  const compile = () =>
    Test.createTestingModule({
      providers: [
        ...cryptoLiveProviders,
        { provide: ConfigService, useValue: { get: () => 'unit-test-secret' } },
        { provide: SystemUser.name, useValue: {} },
        { provide: TenantModel.name, useValue: {} },
        { provide: UserTenant.name, useValue: {} },
        { provide: PriceFeedManager, useValue: fakePrices().manager },
        { provide: PriceCache, useValue: { all: async () => [] } },
      ],
    }).compile();

  it('resolves CRYPTO_LIVE_EMITTER to the real emitter backed by the gateway', async () => {
    const moduleRef = await compile();
    const emitter = moduleRef.get(CRYPTO_LIVE_EMITTER);
    expect(emitter).toBeInstanceOf(CryptoLiveEmitterService);
    expect((emitter as any).gateway).toBe(moduleRef.get(CryptoLiveGateway));
    await moduleRef.close();
  });

  it('is imported by the application module', () => {
    const source = readFileSync(
      join(__dirname, '../App/App.module.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { CryptoLiveModule } from '../CryptoLive/CryptoLive.module';",
    );
    expect(source).toContain('    CryptoLiveModule,');
  });

  it('does not import CryptoExchanges (no module cycle) and re-exports the token', () => {
    const source = readFileSync(
      join(__dirname, 'CryptoLive.module.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/CryptoExchanges\.module/);
    expect(source).toMatch(/export \{[^}]*CRYPTO_LIVE_EMITTER/);
  });
});
