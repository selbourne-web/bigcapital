import * as fs from 'fs';
import * as path from 'path';
import { PionexAdapter } from './PionexAdapter';
import { pionexSign } from './pionex.signing';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const NOW = 1_700_000_000_000;
const creds = { apiKey: ' TEST_KEY ', apiSecret: ' TEST_SECRET\n' };
type Call = { url: string; path: string; query: URLSearchParams; init: any };

function makeFetch(responder: (call: Call, n: number) => any) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname,
      query: u.searchParams,
      init,
    };
    calls.push(call);
    const r = responder(call, calls.length);
    if (r.throw) throw r.throw;
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      text: async () => r.body,
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const byPath = (map: Record<string, any>) => (c: Call) =>
  map[c.path] ?? { body: '{"result":true,"data":{}}' };
const fullMap = () => ({
  '/api/v1/account/balances': { body: fixture('account-balances.json') },
  '/api/v1/wallet/balancesFull': { body: fixture('wallet-balances-full.json') },
});
const adapter = (
  fn: typeof fetch,
  now: () => number = () => NOW,
  sleep: (ms: number) => Promise<void> = async () => undefined,
) => new PionexAdapter(fn, 30_000, now, sleep);
const err = (code: string, message = 'TEST_KEY TEST_SECRET') =>
  JSON.stringify({ result: false, code, message, timestamp: NOW });

describe('PionexAdapter', () => {
  it('exposes id, rate limit and partial history coverage', () => {
    const a = adapter(makeFetch(() => ({ body: '{}' })).fn);
    expect(a.id).toBe('pionex');
    expect(a.rateLimit).toEqual({
      capacity: 10,
      refillPerSec: 10,
      historyPageCost: 10,
    });
    expect(a.rateLimit.historyPageCost).toBeLessThanOrEqual(
      a.rateLimit.capacity,
    );
    expect(a.historyCoverage).toEqual({
      level: 'partial',
      note: 'Pionex API history is limited to the latest 100 fills per market and excludes deposits, withdrawals and bot activity; import the CSV exports for complete history.',
    });
  });

  it('sends a signed GET to the fixed host with trimmed credentials and now-1000 timestamp', async () => {
    const { fn, calls } = makeFetch(byPath(fullMap()));
    await adapter(fn).fetchBalances(creds);
    const { url, init, query } = calls[0];
    expect(
      url.startsWith('https://api.pionex.com/api/v1/account/balances?'),
    ).toBe(true);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(init.headers['PIONEX-KEY']).toBe('TEST_KEY');
    expect(query.get('timestamp')).toBe(String(NOW - 1000));
    expect(init.headers['PIONEX-SIGNATURE']).toBe(
      pionexSign({
        method: 'GET',
        path: '/api/v1/account/balances',
        query: { timestamp: NOW - 1000 },
        secret: 'TEST_SECRET',
      }),
    );
    expect(JSON.stringify(init)).not.toContain('TEST_SECRET');
    expect(url).not.toContain('TEST_SECRET');
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true);
  });

  describe('fetchBalances', () => {
    it('merges trading balances with bot and earn funds without double counting the spot segment', async () => {
      const { fn, calls } = makeFetch(byPath(fullMap()));
      const res = await adapter(fn).fetchBalances(creds);
      expect(res).toEqual([
        // balancesFull spot segment repeats BTC 0.5/0.1: must not be added
        { asset: 'BTC', free: '0.5', locked: '0.301' }, // 0.1 frozen + 0.2 + 0.001 earn
        { asset: 'USDT', free: '100.25', locked: '254.25' }, // 205.5 + 48.75 bots; negative bot skipped
        { asset: 'XDOGE', free: '1000', locked: '0' }, // mixed-case code upper-cased
      ]);
      expect(calls.map((c) => c.path)).toEqual([
        '/api/v1/account/balances',
        '/api/v1/wallet/balancesFull',
      ]);
    });

    const withBot = (detail: unknown, trading?: unknown) =>
      byPath({
        '/api/v1/account/balances': {
          body: JSON.stringify(
            trading ?? { result: true, data: { balances: [] } },
          ),
        },
        '/api/v1/wallet/balancesFull': {
          body: JSON.stringify({
            result: true,
            data: { botAccount: { detail } },
          }),
        },
      });

    it('skips zero, negative and malformed trading and bot entries, unknown segments and null lists', async () => {
      const { fn } = makeFetch(
        withBot(
          [
            {
              type: 'trading_bot',
              list: [
                {
                  investmentToken: 'USDT',
                  investmentAmount: '10',
                  profit: '-10',
                }, // zero
                {
                  investmentToken: 'USDT',
                  investmentAmount: '1',
                  profit: '-5',
                }, // negative
                {
                  investmentToken: 'USDT',
                  investmentAmount: 'abc',
                  profit: '1',
                },
                { investmentToken: 'USDT', investmentAmount: '1', profit: 'x' },
                { investmentToken: '', investmentAmount: '1', profit: '0' },
                { investmentAmount: '1', profit: '0' },
                null,
                'str',
                {
                  investmentToken: 'eth',
                  investmentAmount: '2',
                  profit: '0.5',
                },
              ],
            },
            { type: 'arbitrage', list: null },
            { type: 'trading_bot', list: 'nope' },
            {
              type: 'brand_new_segment',
              list: [{ investmentToken: 'BTC', investmentAmount: '9' }],
            },
            { type: 'spot', list: [{ coin: 'BTC', free: '9', frozen: '0' }] },
            null,
            7,
          ],
          {
            result: true,
            data: {
              balances: [
                { coin: 'BTC', free: '0', frozen: '0' },
                { coin: 'ADA', free: '-1', frozen: '0' },
                { coin: 'SOL', free: 'x', frozen: '0' },
                { coin: '', free: '1', frozen: '0' },
                null,
                { coin: 'XRP', free: '3', frozen: '0' },
              ],
            },
          },
        ),
      );
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'XRP', free: '3', locked: '0' },
        { asset: 'ETH', free: '0', locked: '2.5' },
      ]);
    });

    it('keeps exact decimals when amounts arrive as JSON numbers', async () => {
      const { fn } = makeFetch(
        byPath({
          '/api/v1/account/balances': {
            body: '{"result":true,"data":{"balances":[{"coin":"BTC","free":0.12345678901234567890,"frozen":0.10}]}}',
          },
          '/api/v1/wallet/balancesFull': {
            body: '{"result":true,"data":{"botAccount":{"detail":[{"type":"lending","list":[{"investmentToken":"BTC","investmentAmount":1.10,"profit":0.0000000000000000001}]}]}}}',
          },
        }),
      );
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        {
          asset: 'BTC',
          free: '0.1234567890123456789',
          locked: '1.2000000000000000001',
        },
      ]);
    });

    it('accepts a balancesFull without botAccount', async () => {
      const { fn } = makeFetch(
        byPath({
          '/api/v1/account/balances': {
            body: fixture('account-balances.json'),
          },
          '/api/v1/wallet/balancesFull': {
            body: '{"result":true,"data":{"totalInUsdt":"1"}}',
          },
        }),
      );
      expect(
        (await adapter(fn).fetchBalances(creds)).map((b) => b.asset),
      ).toEqual(['BTC', 'USDT', 'XDOGE']);
    });

    it.each([
      [
        'data.balances is not an array',
        {
          '/api/v1/account/balances':
            '{"result":true,"data":{"balances":"nope"}}',
        },
      ],
      ['no data', { '/api/v1/account/balances': '{"result":true}' }],
      [
        'balancesFull data is not an object',
        { '/api/v1/wallet/balancesFull': '{"result":true,"data":[]}' },
      ],
      [
        'botAccount.detail is not an array',
        {
          '/api/v1/wallet/balancesFull':
            '{"result":true,"data":{"botAccount":{"detail":"x"}}}',
        },
      ],
      ['not an envelope', { '/api/v1/account/balances': '{"balances":[]}' }],
      ['not json', { '/api/v1/account/balances': '<html>' }],
    ])(
      'throws ExchangeSchemaError for structurally wrong envelope: %s',
      async (_n, override) => {
        const map: Record<string, any> = fullMap();
        for (const [p, body] of Object.entries(override)) map[p] = { body };
        const { fn } = makeFetch(byPath(map));
        await expect(adapter(fn).fetchBalances(creds)).rejects.toBeInstanceOf(
          ExchangeSchemaError,
        );
      },
    );

    it('propagates a failing balancesFull instead of under-reporting bot funds', async () => {
      const map = {
        ...fullMap(),
        '/api/v1/wallet/balancesFull': { status: 503, body: 'x' },
      };
      const { fn } = makeFetch(byPath(map));
      const e: any = await adapter(fn)
        .fetchBalances(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.retryable).toBe(true);
    });
  });

  describe('missing Bot reading permission', () => {
    const denied = () => ({
      ...fullMap(),
      '/api/v1/wallet/balancesFull': {
        status: 200,
        body: err('PERMISSION_DENIED'),
      },
    });

    it('degrades to spot balances only and warns once per key', async () => {
      const warn = jest
        .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { fn } = makeFetch(byPath(denied()));
        const a = adapter(fn);
        const expected = [
          { asset: 'BTC', free: '0.5', locked: '0.1' },
          { asset: 'USDT', free: '100.25', locked: '0' },
          { asset: 'XDOGE', free: '1000', locked: '0' },
        ];
        expect(await a.fetchBalances(creds)).toEqual(expected);
        expect(await a.fetchBalances(creds)).toEqual(expected);
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toContain('Bot reading permission');
        expect(msg).not.toMatch(/TEST_KEY|TEST_SECRET/);
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      ['INVALID_APIKEY', 200],
      ['IP_NOT_WHITELISTED', 200],
      ['TRADE_PARAMETER_ERROR', 200],
      ['x', 429],
      ['x', 503],
    ])(
      'still propagates %s / HTTP %s from balancesFull',
      async (code, status) => {
        const map = {
          ...fullMap(),
          '/api/v1/wallet/balancesFull': { status, body: err(code) },
        };
        const { fn } = makeFetch(byPath(map));
        await expect(adapter(fn).fetchBalances(creds)).rejects.toBeInstanceOf(
          status === 429
            ? ExchangeRateLimitError
            : status === 503 || code === 'TRADE_PARAMETER_ERROR'
              ? ExchangeNetworkError
              : ExchangeAuthError,
        );
      },
    );

    it('inspectKey warns when the bot probe is PERMISSION_DENIED, not otherwise', async () => {
      const probe = (p: any) =>
        makeFetch(
          byPath({
            '/api/v1/account/balances': {
              body: fixture('account-balances.json'),
            },
            '/api/v1/bot/orders': p,
          }),
        ).fn;
      const warned = await adapter(
        probe({ body: err('PERMISSION_DENIED') }),
      ).inspectKey(creds);
      expect(warned.permissions).toEqual(['read']);
      expect(warned.warnings).toEqual([
        'Bot and lending balances need the Bot reading permission; without it only spot balances are imported.',
      ]);
      for (const p of [
        { body: '{"result":true,"data":{"results":[]}}' },
        { status: 503, body: 'x' },
        { status: 429, body: '' },
        { throw: new Error('down') },
        { body: err('INVALID_APIKEY') },
      ]) {
        expect((await adapter(probe(p)).inspectKey(creds)).warnings).toEqual(
          [],
        );
      }
    });
  });

  describe('inspectKey', () => {
    it('returns unverifiable/read and adds bot-read when the bot probe succeeds', async () => {
      const { fn, calls } = makeFetch(
        byPath({
          '/api/v1/account/balances': {
            body: fixture('account-balances.json'),
          },
          '/api/v1/bot/orders': {
            body: '{"result":true,"data":{"results":[],"nextPageToken":null}}',
          },
        }),
      );
      expect(await adapter(fn).inspectKey(creds)).toEqual({
        readOnly: 'unverifiable',
        permissions: ['read', 'bot-read'],
        warnings: [],
      });
      expect(calls.map((c) => c.path)).toEqual([
        '/api/v1/account/balances',
        '/api/v1/bot/orders',
      ]);
      expect(calls[1].query.get('status')).toBe('running');
    });

    it.each([
      ['auth error', { status: 200, body: err('IP_NOT_WHITELISTED') }],
      ['401', { status: 401, body: err('INVALID_APIKEY') }],
      ['rate limit', { status: 429, body: '' }],
      ['5xx', { status: 503, body: 'x' }],
      ['network error', { throw: new Error('socket hang up') }],
      ['bad json', { body: 'nope' }],
    ])('never propagates a bot probe %s', async (_n, probe) => {
      const { fn } = makeFetch(
        byPath({
          '/api/v1/account/balances': {
            body: fixture('account-balances.json'),
          },
          '/api/v1/bot/orders': probe,
        }),
      );
      expect(await adapter(fn).inspectKey(creds)).toEqual({
        readOnly: 'unverifiable',
        permissions: ['read'],
        warnings: [],
      });
    });

    const authCases: [string, number, RegExp][] = [
      ['INVALID_APIKEY', 200, /does not recognise/i],
      ['APIKEY_LOST', 200, /did not receive the API key/i],
      ['APIKEY_EXPIRED', 200, /expired/i],
      ['INVALID_SIGNATURE', 200, /signature/i],
      ['SIGNATURE_LOST', 200, /did not receive the request signature/i],
      ['PERMISSION_DENIED', 403, /permission/i],
      ['IP_NOT_WHITELISTED', 200, /allow-list/i],
      ['INVALID_TIMESTAMP', 200, /clock/i],
    ];
    it.each(authCases)(
      'maps %s to an ExchangeAuthError',
      async (code, status, re) => {
        const { fn } = makeFetch(() => ({ status, body: err(code) }));
        const e: any = await adapter(fn)
          .inspectKey(creds)
          .catch((x) => x);
        expect(e).toBeInstanceOf(ExchangeAuthError);
        expect(e.retryable).toBe(false);
        expect(e.userMessage).toMatch(re);
        expect(e.message + e.userMessage).not.toMatch(/TEST_KEY|TEST_SECRET/);
      },
    );

    it('gives each auth code a distinct user message', async () => {
      const messages = new Set<string>();
      for (const [code, status] of authCases) {
        const { fn } = makeFetch(() => ({ status, body: err(code) }));
        const e: any = await adapter(fn)
          .inspectKey(creds)
          .catch((x) => x);
        messages.add(e.userMessage);
      }
      expect(messages.size).toBe(authCases.length);
    });

    it('treats result:false as an error even with HTTP 200, and 401 as auth for unknown codes', async () => {
      let r = makeFetch(() => ({ status: 200, body: err('SOMETHING_NEW') }));
      let e: any = await adapter(r.fn)
        .inspectKey(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('SOMETHING_NEW');
      r = makeFetch(() => ({ status: 401, body: err('SOMETHING_NEW') }));
      e = await adapter(r.fn)
        .inspectKey(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeAuthError);
      r = makeFetch(() => ({ status: 401, body: 'Unauthorized' }));
      e = await adapter(r.fn)
        .inspectKey(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeAuthError);
    });

    it.each(['TRADE_PARAMETER_ERROR', 'TRADE_INVALID_SYMBOL'])(
      'maps %s (HTTP 200) to a non-auth, non-retryable error carrying the code',
      async (code) => {
        const { fn } = makeFetch(() => ({ status: 200, body: err(code) }));
        const e: any = await adapter(fn)
          .inspectKey(creds)
          .catch((x) => x);
        expect(e).toBeInstanceOf(ExchangeNetworkError);
        expect(e).not.toBeInstanceOf(ExchangeAuthError);
        expect(e.retryable).toBe(false);
        expect(e.message).toContain(code);
      },
    );

    it('redacts secrets from network errors', async () => {
      const { fn } = makeFetch(() => ({
        throw: new Error('boom TEST_SECRET TEST_KEY'),
      }));
      const e: any = await adapter(fn)
        .inspectKey(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeNetworkError);
      expect(e.message).not.toMatch(/TEST_SECRET|TEST_KEY/);
    });

    it('does not echo server messages containing secrets', async () => {
      const { fn } = makeFetch(() => ({ body: 'not json TEST_SECRET' }));
      const e: any = await adapter(fn)
        .inspectKey(creds)
        .catch((x) => x);
      expect(e).toBeInstanceOf(ExchangeSchemaError);
      expect(JSON.stringify(e.rawBody)).not.toContain('TEST_SECRET');
    });
  });

  describe('429 cool-down', () => {
    it('fails fast inside 60 s without a network request, then recovers; other keys unaffected', async () => {
      let t = NOW;
      const { fn, calls } = makeFetch((c, n) =>
        n === 1
          ? { status: 429, body: '' }
          : { body: fixture('account-balances.json') },
      );
      const a = adapter(fn, () => t);
      const first: any = await a.inspectKey(creds).catch((x) => x);
      expect(first).toBeInstanceOf(ExchangeRateLimitError);
      expect(first.retryAfterMs).toBe(60_000);
      expect(first.retryable).toBe(true);
      expect(calls).toHaveLength(1);

      t += 30_000;
      const second: any = await a.inspectKey(creds).catch((x) => x);
      expect(second).toBeInstanceOf(ExchangeRateLimitError);
      expect(second.retryAfterMs).toBe(30_000);
      expect(calls).toHaveLength(1); // no request inside the ban

      const other = await a
        .inspectKey({ apiKey: 'OTHER', apiSecret: 's' })
        .catch((x) => x);
      expect(other).not.toBeInstanceOf(ExchangeRateLimitError);
      expect(calls).toHaveLength(3); // other key: balances + bot probe

      t += 30_001;
      await a.inspectKey(creds);
      expect(calls.length).toBeGreaterThan(3);
    });
  });

  describe('pacing', () => {
    const sleeps = () => {
      const waits: number[] = [];
      return { waits, sleep: async (ms: number) => void waits.push(ms) };
    };

    it('paces fills/allOrders at 600 ms and other calls at 120 ms per key and path', async () => {
      const { waits, sleep } = sleeps();
      const { fn } = makeFetch(() => ({ body: '{"result":true,"data":{}}' }));
      const a = adapter(fn, () => NOW, sleep);
      const c = (a as any).call.bind(a);
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/fills', {
        symbol: 'BTC_USDT',
      });
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/fills', {
        symbol: 'BTC_USDT',
      });
      expect(waits).toEqual([600]);
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/allOrders', {
        symbol: 'BTC_USDT',
      });
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/allOrders', {
        symbol: 'BTC_USDT',
      });
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/common/symbols', {});
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/common/symbols', {});
      expect(waits).toEqual([600, 600, 120]);
      // another key is not paced against K
      await c({ apiKey: 'L', apiSecret: 's' }, '/api/v1/trade/fills', {
        symbol: 'BTC_USDT',
      });
      expect(waits).toEqual([600, 600, 120]);
    });

    it('does not sleep once the gap has elapsed on the injected clock', async () => {
      const { waits, sleep } = sleeps();
      let t = NOW;
      const { fn } = makeFetch(() => ({ body: '{"result":true,"data":{}}' }));
      const a = adapter(fn, () => t, sleep);
      const c = (a as any).call.bind(a);
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/fills', {});
      t += 600;
      await c({ apiKey: 'K', apiSecret: 's' }, '/api/v1/trade/fills', {});
      expect(waits).toEqual([]);
    });
  });

  describe('per-key lanes', () => {
    it('a slow call for key A does not delay key B', async () => {
      let releaseA!: () => void;
      const gate = new Promise<void>((r) => (releaseA = r));
      const fn = jest.fn(async (_url: any, init: any) => {
        if (init.headers['PIONEX-KEY'] === 'KEY_A') await gate;
        return {
          ok: true,
          status: 200,
          text: async () => fixture('account-balances.json'),
        } as any;
      }) as unknown as typeof fetch;
      const a = adapter(fn);
      const pA = (a as any).call(
        { apiKey: 'KEY_A', apiSecret: 's' },
        '/api/v1/account/balances',
        {},
      );
      const resB = await (a as any).call(
        { apiKey: 'KEY_B', apiSecret: 's' },
        '/api/v1/account/balances',
        {},
      );
      expect(resB.result).toBe(true);
      releaseA();
      await pA;
    });

    it('serializes calls of one key and cleans up idle state', async () => {
      const order: string[] = [];
      const fn = jest.fn(async (url: any) => {
        order.push(`start ${new URL(String(url)).pathname}`);
        await new Promise((r) => setImmediate(r));
        order.push('end');
        return {
          ok: true,
          status: 200,
          text: async () => '{"result":true,"data":{}}',
        } as any;
      }) as unknown as typeof fetch;
      const a = adapter(fn);
      const k = { apiKey: 'K', apiSecret: 's' };
      await Promise.all([
        (a as any).call(k, '/api/v1/account/balances', {}),
        (a as any).call(k, '/api/v1/common/symbols', {}),
      ]);
      expect(order).toEqual([
        'start /api/v1/account/balances',
        'end',
        'start /api/v1/common/symbols',
        'end',
      ]);
      await new Promise((r) => setImmediate(r));
      expect((a as any).lanes.size).toBe(0);
    });
  });

  describe('allow-list', () => {
    it.each([
      '/api/v1/assets/transfer',
      '/api/v1/trade/order',
      '/api/v1/account/balances/../../trade/order',
    ])('refuses %s without any network request', async (p) => {
      const { fn, calls } = makeFetch(() => ({ body: '{}' }));
      await expect(
        (adapter(fn) as any).call({ apiKey: 'K', apiSecret: 's' }, p, {}),
      ).rejects.toThrow(/Refusing to call non-read Pionex endpoint/);
      expect(calls).toHaveLength(0);
    });

    it('refuses unsafe query values', async () => {
      const { fn, calls } = makeFetch(() => ({ body: '{}' }));
      await expect(
        (adapter(fn) as any).call(
          { apiKey: 'K', apiSecret: 's' },
          '/api/v1/trade/fills',
          {
            symbol: 'BTC_USDT&side=SELL',
          },
        ),
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringMatching(/unsafe/),
      });
      expect(calls).toHaveLength(0);
    });
  });

  it('fetchHistory is a stub returning no records until Task 3', async () => {
    const { fn, calls } = makeFetch(() => ({ body: '{}' }));
    expect(await adapter(fn).fetchHistory()).toEqual({ records: [] });
    expect(calls).toHaveLength(0);
  });
});
