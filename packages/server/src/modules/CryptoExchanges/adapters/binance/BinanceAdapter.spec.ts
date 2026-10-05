import * as fs from 'fs';
import * as path from 'path';
import { BinanceAdapter } from './BinanceAdapter';
import { signBinance } from './binance.signing';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

const fixtureText = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const fixture = (name: string) => JSON.parse(fixtureText(name));

// Public example credentials from the Binance docs; not real.
const API_KEY =
  'vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A';
const SECRET =
  'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
const creds = { apiKey: `  ${API_KEY} `, apiSecret: ` ${SECRET}\n` };

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const WINDOW = 90 * DAY;

type Call = { url: string; path: string; params: URLSearchParams; init: any };
type Reply = {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
};

function makeFetch(responder: (call: Call, n: number) => Reply) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname,
      params: u.searchParams,
      init,
    };
    calls.push(call);
    const r = responder(call, calls.length);
    const headers = r.headers ?? {};
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => r.body ?? JSON.stringify(r.json),
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const adapterWith = (fn: typeof fetch, opts = {}) =>
  new BinanceAdapter(fn, () => NOW, opts);

/** Router returning the docs fixtures per endpoint. */
function router(overrides: Record<string, (c: Call) => Reply> = {}) {
  return (c: Call): Reply => {
    if (overrides[c.path]) return overrides[c.path](c);
    switch (c.path) {
      case '/api/v3/account':
        return { json: fixture('account.json') };
      case '/api/v3/exchangeInfo':
        return { json: fixture('exchange-info.json') };
      case '/sapi/v1/account/apiRestrictions':
        return { json: fixture('api-restrictions.json') };
      default:
        return { json: [] };
    }
  };
}

async function drain(a: BinanceAdapter, since?: Date) {
  const records: any[] = [];
  const cursors: (string | undefined)[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await a.fetchHistory(creds, { since, cursor });
    records.push(...page.records);
    cursor = page.nextCursor;
    cursors.push(cursor);
    if (!cursor) break;
  }
  return { records, cursors };
}

describe('BinanceAdapter', () => {
  it('exposes id and rate limit', () => {
    const a = adapterWith(makeFetch(router()).fn);
    expect(a.id).toBe('binance');
    expect(a.rateLimit.capacity).toBeGreaterThan(0);
    expect(a.rateLimit.refillPerSec).toBeGreaterThan(0);
  });

  describe('request shape', () => {
    it('sends a signed GET to the fixed host with the key only in X-MBX-APIKEY', async () => {
      const { fn, calls } = makeFetch(router());
      await adapterWith(fn).fetchBalances(creds);
      const { url, init, params, path: p } = calls[0];
      expect(url.startsWith('https://api.binance.com/api/v3/account?')).toBe(
        true,
      );
      expect(p).toBe('/api/v3/account');
      expect(init.method).toBe('GET');
      expect(init.headers['X-MBX-APIKEY']).toBe(API_KEY);
      expect(Object.keys(init.headers)).toEqual(['X-MBX-APIKEY']);
      expect(init.body).toBeUndefined();
      expect(url).not.toContain(API_KEY);
      expect(url).not.toContain(SECRET);
      expect(params.get('timestamp')).toBe(String(NOW));
      expect(params.get('recvWindow')).toBe('10000');
      const signature = params.get('signature')!;
      const unsigned = url.split('?')[1].replace(/&signature=[0-9a-f]+$/, '');
      expect(signature).toBe(signBinance(unsigned, SECRET));
    });

    it('never follows redirects and passes a timeout signal', async () => {
      const { fn, calls } = makeFetch(router());
      await adapterWith(fn).fetchBalances(creds);
      expect(calls[0].init.redirect).toBe('error');
      expect(calls[0].init.signal).toBeDefined();
    });

    it('calls the public exchangeInfo endpoint unsigned and without the API key', async () => {
      const { fn, calls } = makeFetch(router());
      await adapterWith(fn).fetchHistory(creds, { cursor: 'trd:>:0' });
      const info = calls.find((c) => c.path === '/api/v3/exchangeInfo')!;
      expect(info.params.get('signature')).toBeNull();
      expect(info.init.headers?.['X-MBX-APIKEY']).toBeUndefined();
    });
  });

  describe('inspectKey', () => {
    const inspect = async (body: unknown) => {
      const { fn, calls } = makeFetch(() => ({ json: body }));
      const result = await adapterWith(fn).inspectKey(creds);
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe('/sapi/v1/account/apiRestrictions');
      return result;
    };
    const readOnlyKey = (): Record<string, unknown> => ({
      ...fixture('api-restrictions.json'),
      enableInternalTransfer: false,
      permitsUniversalTransfer: false,
      enablePortfolioMarginTrading: false,
    });

    it('is not read-only for the docs example (internal transfer, universal transfer, portfolio margin on)', async () => {
      const r = await inspect(fixture('api-restrictions.json'));
      expect(r.readOnly).toBe(false);
      expect(r.permissions).toEqual(
        expect.arrayContaining([
          'enableReading',
          'enableInternalTransfer',
          'permitsUniversalTransfer',
          'enablePortfolioMarginTrading',
        ]),
      );
    });

    it('is read-only when only reading (and fix read-only) is enabled', async () => {
      const r = await inspect(readOnlyKey());
      expect(r.readOnly).toBe(true);
      expect(r.permissions).toEqual(['enableReading', 'enableFixReadOnly']);
    });

    it.each([
      'enableWithdrawals',
      'enableInternalTransfer',
      'enableMargin',
      'enableFutures',
      'permitsUniversalTransfer',
      'enableVanillaOptions',
      'enableFixApiTrade',
      'enableSpotAndMarginTrading',
      'enablePortfolioMarginTrading',
    ])('is not read-only when %s is enabled', async (flag) => {
      const r = await inspect({ ...readOnlyKey(), [flag]: true });
      expect(r.readOnly).toBe(false);
      expect(r.permissions).toContain(flag);
    });

    it('is not read-only when reading is disabled', async () => {
      const r = await inspect({ ...readOnlyKey(), enableReading: false });
      expect(r.readOnly).toBe(false);
    });

    it.each([true, false, 'yes', null])(
      'is not read-only when an unrecognised flag is present (%p)',
      async (value) => {
        const r = await inspect({
          ...readOnlyKey(),
          enableTeleportation: value,
        });
        expect(r.readOnly).toBe(false);
        expect(r.permissions).toContain('unrecognized:enableTeleportation');
      },
    );

    it('is not read-only when a known trading flag is missing or not a boolean', async () => {
      const missing = readOnlyKey();
      delete missing.enableMargin;
      const r1 = await inspect(missing);
      expect(r1.readOnly).toBe(false);
      expect(r1.permissions).toContain('missing:enableMargin');
      expect(
        (await inspect({ ...readOnlyKey(), enableFutures: 'false' })).readOnly,
      ).toBe(false);
      expect(
        (await inspect({ ...readOnlyKey(), enableWithdrawals: 0 })).readOnly,
      ).toBe(false);
    });

    it('is unverifiable when the response is not an object', async () => {
      expect(await inspect([])).toEqual({
        readOnly: 'unverifiable',
        permissions: [],
      });
      expect(await inspect('nope')).toEqual({
        readOnly: 'unverifiable',
        permissions: [],
      });
    });
  });

  describe('fetchBalances', () => {
    it('parses free/locked, normalizes assets and drops zero rows', async () => {
      const { fn } = makeFetch(router());
      const balances = await adapterWith(fn).fetchBalances(creds);
      const by = Object.fromEntries(balances.map((b) => [b.asset, b]));
      expect(by.BTC).toEqual({
        asset: 'BTC',
        free: '4723846.89208129',
        locked: '0',
      });
      expect(by.LTC).toEqual({
        asset: 'LTC',
        free: '4763368.68006011',
        locked: '1.5',
      });
      expect(by.ETH).toBeUndefined();
      // Earn wrapper tokens are reported as the exchange names them (upper-cased only).
      expect(by.LDBTC).toEqual({ asset: 'LDBTC', free: '0.25', locked: '0' });
    });

    it('sums duplicate rows exactly', async () => {
      const { fn } = makeFetch(() => ({
        json: {
          balances: [
            { asset: 'btc', free: '0.1', locked: '0' },
            { asset: 'BTC', free: '0.2', locked: '0.00000001' },
          ],
        },
      }));
      const [b] = await adapterWith(fn).fetchBalances(creds);
      expect(b).toEqual({ asset: 'BTC', free: '0.3', locked: '0.00000001' });
    });

    it('rejects an unexpected shape with a redacted schema error', async () => {
      const { fn } = makeFetch(() => ({
        json: {
          balances: [{ asset: 'BTC', free: 'abc', locked: '0' }],
          apiKey: 'leak',
        },
      }));
      const err: any = await adapterWith(fn)
        .fetchBalances(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeSchemaError);
      expect(JSON.stringify(err.rawBody)).not.toContain('leak');
      const { fn: fn2 } = makeFetch(() => ({ json: { nothing: true } }));
      await expect(
        adapterWith(fn2).fetchBalances(creds),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });
  });

  describe('fetchHistory', () => {
    const since = new Date(NOW - 100 * DAY);
    const sinceMs = since.getTime();

    const historyRouter = () =>
      router({
        '/sapi/v1/capital/deposit/hisrec': (c) =>
          // Only the first window has data so duplicates do not mask window handling.
          c.params.get('startTime') === String(sinceMs)
            ? { json: fixture('deposits.json') }
            : { json: [] },
        '/sapi/v1/capital/withdraw/history': (c) =>
          c.params.get('startTime') === String(sinceMs)
            ? { json: fixture('withdrawals.json') }
            : { json: [] },
        '/api/v3/myTrades': (c) =>
          c.params.get('symbol') === 'BTCUSDT'
            ? {
                json: fixture('my-trades.json').map((t: any, i: number) => ({
                  ...t,
                  symbol: 'BTCUSDT',
                  time: NOW - 50 * DAY + i * 1000, // inside the since window
                })),
              }
            : { json: [] },
      });

    it('walks deposit and withdrawal windows of at most 90 days, then trades per held symbol', async () => {
      const { fn, calls } = makeFetch(historyRouter());
      const { records, cursors } = await drain(adapterWith(fn), since);

      const dep = calls.filter(
        (c) => c.path === '/sapi/v1/capital/deposit/hisrec',
      );
      expect(
        dep.map((c) => [c.params.get('startTime'), c.params.get('endTime')]),
      ).toEqual([
        [String(sinceMs), String(sinceMs + WINDOW - 1)],
        [String(sinceMs + WINDOW), String(NOW)],
      ]);
      const wd = calls.filter(
        (c) => c.path === '/sapi/v1/capital/withdraw/history',
      );
      expect(wd).toHaveLength(2);
      for (const c of [...dep, ...wd]) {
        expect(c.params.get('limit')).toBe('1000');
        expect(c.params.get('offset')).toBe('0');
        expect(
          Number(c.params.get('endTime')) - Number(c.params.get('startTime')),
        ).toBeLessThan(WINDOW);
      }

      // Symbols with a held base asset and a major (or held) quote, sorted; zero-balance ETH excluded.
      const traded = calls
        .filter((c) => c.path === '/api/v3/myTrades')
        .map((c) => c.params.get('symbol'));
      expect(traded).toEqual(['BTCEUR', 'BTCUSDT', 'LTCBTC', 'LTCUSDT']);
      expect(cursors[cursors.length - 1]).toBeUndefined();

      const byId = Object.fromEntries(
        records.map((r) => [`${r.type}|${r.exchangeRecordId}`, r]),
      );
      expect(Object.keys(byId).sort()).toEqual(
        [
          'deposit|769800519366885376',
          'withdrawal|b6ae22b3aa844210a7041aee7589627c',
          'fee|b6ae22b3aa844210a7041aee7589627c:fee',
          'trade|BTCUSDT:28457',
          'trade|BTCUSDT:28458',
          'fee|BTCUSDT:28457:fee',
        ].sort(),
      );
      expect(
        new Set(records.map((r) => `${r.type}|${r.exchangeRecordId}`)).size,
      ).toBe(records.length);

      expect(byId['deposit|769800519366885376'].occurredAt).toEqual(
        new Date(1661493146000),
      );
      expect(
        byId['withdrawal|b6ae22b3aa844210a7041aee7589627c'].occurredAt,
      ).toEqual(new Date('2019-10-12T11:12:02Z'));
      const fee = byId['fee|BTCUSDT:28457:fee'];
      expect(fee.occurredAt).toEqual(new Date(NOW - 50 * DAY));
      expect(fee.payload).toMatchObject({
        tradeId: 'BTCUSDT:28457',
        asset: 'BNB',
        normalizedAsset: 'BNB',
        fee: '10.10000000',
      });
      expect(
        byId['fee|b6ae22b3aa844210a7041aee7589627c:fee'].payload,
      ).toMatchObject({
        asset: 'USDT',
        fee: '0.004',
      });
      expect(byId['trade|BTCUSDT:28457'].payload).toMatchObject({
        symbol: 'BTCUSDT',
        id: 28457,
        price: '4.00000100',
      });
      expect(byId['trade|BTCUSDT:28457'].type).toBe('trade');
    });

    it('does not record pending deposits or non-completed withdrawals', async () => {
      const { fn } = makeFetch(historyRouter());
      const { records } = await drain(adapterWith(fn), since);
      expect(
        records.find((r) => r.exchangeRecordId === '769800519366885377'),
      ).toBeUndefined();
      expect(
        records.find((r) => r.exchangeRecordId.startsWith('c7ae22b3')),
      ).toBeUndefined();
    });

    it('encodes stage, window start, offset and origin in the cursor', async () => {
      const { fn } = makeFetch(historyRouter());
      const a = adapterWith(fn);
      const p1 = await a.fetchHistory(creds, { since });
      expect(p1.nextCursor).toBe(`dep:${sinceMs + WINDOW}:0:${sinceMs}`);
      const p2 = await a.fetchHistory(creds, { since, cursor: p1.nextCursor });
      expect(p2.nextCursor).toBe(`wd:${sinceMs}:0:${sinceMs}`);
      const p3 = await a.fetchHistory(creds, { since, cursor: p2.nextCursor });
      expect(p3.nextCursor).toBe(`wd:${sinceMs + WINDOW}:0:${sinceMs}`);
      const p4 = await a.fetchHistory(creds, { since, cursor: p3.nextCursor });
      expect(p4.nextCursor).toBe('trd:>:0');
    });

    it('pages within a window by offset when a full page of 1000 comes back', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        ...fixture('deposits.json')[0],
        id: String(i),
      }));
      const { fn, calls } = makeFetch(
        router({ '/sapi/v1/capital/deposit/hisrec': () => ({ json: rows }) }),
      );
      const a = adapterWith(fn);
      const page = await a.fetchHistory(creds, { since });
      expect(page.records).toHaveLength(1000);
      expect(page.nextCursor).toBe(`dep:${sinceMs}:1000:${sinceMs}`);
      await a.fetchHistory(creds, { since, cursor: page.nextCursor });
      expect(calls[1].params.get('offset')).toBe('1000');
      expect(calls[1].params.get('startTime')).toBe(String(sinceMs));
    });

    it('defaults the lower bound to the configured lookback when since is missing', async () => {
      const { fn, calls } = makeFetch(router());
      await adapterWith(fn, { initialLookbackDays: 10 }).fetchHistory(
        creds,
        {},
      );
      expect(calls[0].params.get('startTime')).toBe(String(NOW - 10 * DAY));
      expect(calls[0].params.get('endTime')).toBe(String(NOW));
    });

    it('pages trades by fromId and moves to the next symbol afterwards', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        ...fixture('my-trades.json')[1],
        symbol: 'BTCEUR',
        id: 500 + i,
      }));
      const { fn, calls } = makeFetch(
        router({ '/api/v3/myTrades': () => ({ json: rows }) }),
      );
      const a = adapterWith(fn);
      const p1 = await a.fetchHistory(creds, { cursor: 'trd:>:0' });
      const first = calls.find((c) => c.path === '/api/v3/myTrades')!;
      expect(first.params.get('symbol')).toBe('BTCEUR');
      expect(first.params.get('fromId')).toBe('0');
      expect(first.params.get('limit')).toBe('1000');
      expect(p1.nextCursor).toBe('trd:BTCEUR:1500');

      const { fn: fn2, calls: calls2 } = makeFetch(router());
      const b = adapterWith(fn2);
      const p2 = await b.fetchHistory(creds, { cursor: 'trd:BTCEUR:1500' });
      const trades2 = () => calls2.filter((c) => c.path === '/api/v3/myTrades');
      expect(trades2()[0].params.get('fromId')).toBe('1500');
      expect(p2.nextCursor).toBe('trd:>BTCEUR:0');
      const p3 = await b.fetchHistory(creds, { cursor: p2.nextCursor });
      expect(trades2().pop()!.params.get('symbol')).toBe('BTCUSDT');
      expect(p3.nextCursor).toBe('trd:>BTCUSDT:0');
    });

    it('finishes without a myTrades call when no symbol follows the cursor', async () => {
      const { fn, calls } = makeFetch(router());
      const page = await adapterWith(fn).fetchHistory(creds, {
        cursor: 'trd:>LTCUSDT:0',
      });
      expect(page).toEqual({ records: [], nextCursor: undefined });
      expect(calls.some((c) => c.path === '/api/v3/myTrades')).toBe(false);
    });

    it('uses a time window for the first trades request when since is within 24h, else filters client-side', async () => {
      const recent = new Date(NOW - 2 * 3_600_000);
      const { fn, calls } = makeFetch(
        router({ '/api/v3/myTrades': () => ({ json: [] }) }),
      );
      await adapterWith(fn).fetchHistory(creds, {
        since: recent,
        cursor: 'trd:>:0',
      });
      const t = calls.find((c) => c.path === '/api/v3/myTrades')!;
      expect(t.params.get('startTime')).toBe(String(recent.getTime()));
      expect(t.params.get('endTime')).toBe(String(NOW));
      expect(t.params.get('fromId')).toBeNull();

      const old = new Date(1499865600000); // after trade 28457, before 28458
      const { fn: fn2, calls: calls2 } = makeFetch(
        router({
          '/api/v3/myTrades': () => ({
            json: fixture('my-trades.json').map((r: any) => ({
              ...r,
              symbol: 'BTCEUR',
            })),
          }),
        }),
      );
      const page = await adapterWith(fn2).fetchHistory(creds, {
        since: old,
        cursor: 'trd:>:0',
      });
      const t2 = calls2.find((c) => c.path === '/api/v3/myTrades')!;
      expect(t2.params.get('startTime')).toBeNull();
      expect(
        page.records
          .filter((r) => r.type === 'trade')
          .map((r) => r.exchangeRecordId),
      ).toEqual(['BTCEUR:28458']);
    });

    it('rejects a malformed cursor and malformed rows', async () => {
      const a = adapterWith(makeFetch(router()).fn);
      await expect(
        a.fetchHistory(creds, { cursor: 'bogus' }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
      await expect(
        a.fetchHistory(creds, { cursor: 'dep:1:2' }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
      const bad = adapterWith(
        makeFetch(
          router({
            '/sapi/v1/capital/deposit/hisrec': () => ({
              json: { not: 'array' },
            }),
          }),
        ).fn,
      );
      await expect(bad.fetchHistory(creds, { since })).rejects.toBeInstanceOf(
        ExchangeSchemaError,
      );
      const badTrade = adapterWith(
        makeFetch(router({ '/api/v3/myTrades': () => ({ json: [{ id: 1 }] }) }))
          .fn,
      );
      await expect(
        badTrade.fetchHistory(creds, { cursor: 'trd:>:0' }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });
  });

  describe('read-only guard', () => {
    it('only ever calls the allow-listed read endpoints', async () => {
      const { fn, calls } = makeFetch(router());
      const a = adapterWith(fn);
      await a.inspectKey(creds);
      await a.fetchBalances(creds);
      await drain(a, new Date(NOW - 100 * DAY));
      expect([...new Set(calls.map((c) => c.path))].sort()).toEqual(
        [
          '/api/v3/account',
          '/api/v3/exchangeInfo',
          '/api/v3/myTrades',
          '/sapi/v1/account/apiRestrictions',
          '/sapi/v1/capital/deposit/hisrec',
          '/sapi/v1/capital/withdraw/history',
        ].sort(),
      );
      expect(calls.every((c) => c.init.method === 'GET')).toBe(true);
    });

    it.each([
      '/api/v3/order',
      '/sapi/v1/capital/withdraw/apply',
      '/sapi/v1/asset/transfer',
      '/sapi/v1/convert/acceptQuote',
    ])('refuses %s before any fetch', async (p) => {
      const { fn, calls } = makeFetch(router());
      await expect((adapterWith(fn) as any).call(creds, p, {})).rejects.toThrow(
        /non-read/,
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('error mapping', () => {
    const fail = (reply: Reply) =>
      adapterWith(makeFetch(() => reply).fn)
        .fetchBalances(creds)
        .catch((e) => e);

    it('maps 429 and 418 to a retryable rate limit error honouring Retry-After', async () => {
      const e: any = await fail({
        status: 429,
        body: '',
        headers: { 'retry-after': '7' },
      });
      expect(e).toBeInstanceOf(ExchangeRateLimitError);
      expect(e.retryable).toBe(true);
      expect(e.retryAfterMs).toBe(7000);
      const e2: any = await fail({
        status: 418,
        body: '{"code":-1003,"msg":"banned"}',
      });
      expect(e2).toBeInstanceOf(ExchangeRateLimitError);
      expect(e2.retryAfterMs).toBeUndefined();
    });

    it('maps code -1003 to a rate limit error', async () => {
      expect(
        await fail({
          status: 400,
          json: { code: -1003, msg: 'Too much request weight used' },
        }),
      ).toBeInstanceOf(ExchangeRateLimitError);
    });

    it.each([-2015, -2014, -1022, -1002])(
      'maps code %i to a non-retryable auth error',
      async (code) => {
        const e: any = await fail({
          status: 401,
          json: {
            code,
            msg: 'Invalid API-key, IP, or permissions for action.',
          },
        });
        expect(e).toBeInstanceOf(ExchangeAuthError);
        expect(e.retryable).toBe(false);
      },
    );

    it('treats -1021 as retryable clock skew, not an auth error', async () => {
      const e: any = await fail({
        status: 400,
        json: {
          code: -1021,
          msg: 'Timestamp for this request is outside of the recvWindow.',
        },
      });
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e).not.toBeInstanceOf(ExchangeAuthError);
      expect(e.retryable).toBe(true);
      expect(e.userMessage).toMatch(/clock/i);
    });

    it('maps 5xx, HTML and non-JSON bodies to a retryable network error', async () => {
      for (const reply of [
        { status: 503, body: '{"code":-1001,"msg":"Internal error"}' },
        { status: 502, body: '<html>Bad gateway</html>' },
        { status: 403, body: '<html>Cloudflare WAF</html>' },
        { status: 200, body: 'not json' },
        { status: 400, json: { code: -1000, msg: 'Unknown error' } },
      ]) {
        const e: any = await fail(reply);
        expect(e).toBeInstanceOf(ExchangeNetworkError);
        expect(e.retryable).toBe(true);
      }
    });

    it('reports other API errors as non-retryable', async () => {
      const e: any = await fail({
        status: 400,
        json: { code: -1121, msg: 'Invalid symbol.' },
      });
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.retryable).toBe(false);
    });

    it('carries a sanitized raw body for an unexpected JSON shape', async () => {
      const e: any = await fail({ json: { weird: 1, signature: 'abc' } });
      expect(e).toBeInstanceOf(ExchangeSchemaError);
      expect(e.rawBody).toEqual({ weird: 1, signature: '[REDACTED]' });
    });

    it('never leaks credentials in error messages', async () => {
      const fn = jest.fn(async () => {
        throw new Error(`connect failed for ${API_KEY} using ${SECRET}`);
      }) as unknown as typeof fetch;
      const e: any = await adapterWith(fn)
        .fetchBalances(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.message).not.toContain(API_KEY);
      expect(e.message).not.toContain(SECRET);
      expect(e.retryable).toBe(true);
      const e2: any = await fail({
        status: 400,
        json: { code: -9999, msg: `bad ${API_KEY}` },
      });
      expect(e2.message).not.toContain(API_KEY);
    });

    it('turns a hung request into a retryable timeout error and does not wedge later calls', async () => {
      let n = 0;
      const fn = jest.fn((url: any, init: any) => {
        n++;
        if (n === 1) {
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => fixtureText('account.json'),
        });
      }) as unknown as typeof fetch;
      const a = adapterWith(fn, { requestTimeoutMs: 50 });
      const e: any = await a.fetchBalances(creds).catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.retryable).toBe(true);
      expect(e.message).toMatch(/timed out/);
      expect((await a.fetchBalances(creds)).length).toBeGreaterThan(0);
    });
  });
});
