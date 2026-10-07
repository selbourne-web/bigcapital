import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'crypto';
import { CryptoComAppAdapter, classifyScopes } from './CryptoComAppAdapter';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const creds = { apiKey: ' TEST_KEY ', apiSecret: ' TEST_SECRET\n' };
type Call = { url: string; init: any };
const NOW = 1_700_000_000_000;

function makeFetch(responder: (call: Call, n: number) => any) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const call = { url: String(url), init };
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
  map[new URL(c.url).pathname] ?? { body: '{}' };
const adapter = (fn: typeof fetch, now: () => number = () => NOW) =>
  new CryptoComAppAdapter(fn, 30_000, now);
const keyBody = (patch: Record<string, unknown>) => {
  const j = JSON.parse(fixture('api-key-current.json'));
  Object.assign(j.api_key, patch);
  return JSON.stringify(j);
};

describe('classifyScopes', () => {
  it('probed key (fiat.deposit:write) is unverifiable', () => {
    const j = JSON.parse(fixture('api-key-current.json'));
    const r = classifyScopes(j.api_key.scopes);
    expect(r.readOnly).toBe('unverifiable');
    expect(r.writeScopes).toEqual(['fiat.deposit:write']);
    expect(r.permissions).toHaveLength(7);
  });
  it('all :read is read-only', () => {
    expect(classifyScopes(['balance:read', 'market:read'])).toEqual({
      readOnly: true,
      permissions: ['balance:read', 'market:read'],
      writeScopes: [],
    });
  });
  it.each([
    'crypto.withdrawal:write',
    'trade:write',
    'crypto.transfer:write',
    'exchange.order:write',
    'fiat.payment:write',
    'crypto.send:write',
  ])('%s is not read-only', (s) => {
    expect(classifyScopes(['balance:read', s]).readOnly).toBe(false);
  });
  it('unknown suffix fails closed', () => {
    expect(classifyScopes(['foo:execute']).readOnly).toBe(false);
    expect(classifyScopes(['nocolon']).readOnly).toBe(false);
  });
  it('normalizes case and whitespace', () => {
    expect(classifyScopes(['FIAT.DEPOSIT:WRITE ', ' Balance:Read'])).toEqual({
      readOnly: 'unverifiable',
      permissions: ['fiat.deposit:write', 'balance:read'],
      writeScopes: ['fiat.deposit:write'],
    });
    expect(classifyScopes([' CRYPTO.WITHDRAWAL:WRITE']).readOnly).toBe(false);
  });
  it('mixed: false beats unverifiable beats true', () => {
    expect(classifyScopes(['a:read', 'fiat.deposit:write']).readOnly).toBe(
      'unverifiable',
    );
    expect(
      classifyScopes(['fiat.deposit:write', 'crypto.withdrawal:write'])
        .readOnly,
    ).toBe(false);
    expect(classifyScopes(['fiat.deposit:write', 'x:yy']).readOnly).toBe(false);
  });
  it('empty list fails closed', () => {
    expect(classifyScopes([]).readOnly).toBe(false);
  });
});

describe('CryptoComAppAdapter', () => {
  it('exposes id, rate limit and full history coverage', () => {
    const a = adapter(makeFetch(() => ({ body: '{}' })).fn);
    expect(a.id).toBe('crypto_com_app');
    expect(a.rateLimit).toEqual({
      capacity: 5,
      refillPerSec: 0.5,
      historyPageCost: 2,
    });
    expect(a.rateLimit.capacity).toBeGreaterThanOrEqual(
      a.rateLimit.historyPageCost,
    );
    expect(a.historyCoverage.level).toBe('full');
  });

  it('sends a signed GET with trimmed credentials to the fixed host', async () => {
    const { fn, calls } = makeFetch(() => ({
      body: fixture('api-key-current.json'),
    }));
    await adapter(fn).inspectKey(creds);
    const { url, init } = calls[0];
    expect(url).toBe('https://wapi.crypto.com/v1/api-keys/current');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    expect(init.headers['Cdc-Api-Key']).toBe('TEST_KEY');
    expect(init.headers['Cdc-Api-Timestamp']).toBe(String(NOW));
    expect(init.headers['User-Agent']).toBeTruthy();
    expect(init.headers['Cdc-Api-Signature']).toBe(
      createHmac('sha256', 'TEST_SECRET')
        .update(`${NOW}GET/v1/api-keys/current`)
        .digest('base64'),
    );
    expect(JSON.stringify(init.headers)).not.toContain('TEST_SECRET');
  });

  describe('inspectKey', () => {
    it('classifies scopes and returns expiresAt as a Date', async () => {
      const { fn } = makeFetch(() => ({
        body: fixture('api-key-current.json'),
      }));
      const r = await adapter(fn).inspectKey(creds);
      expect(r.readOnly).toBe('unverifiable');
      expect(r.writeScopes).toEqual(['fiat.deposit:write']);
      expect(r.permissions).toContain('balance:read');
      expect(r.expiresAt).toEqual(new Date('2099-01-01T00:00:00.000Z'));
    });

    it('flags a withdrawal-capable key as not read-only', async () => {
      const { fn } = makeFetch(() => ({
        body: fixture('api-key-current-write.json'),
      }));
      const r = await adapter(fn).inspectKey(creds);
      expect(r.readOnly).toBe(false);
      expect(r.writeScopes).toEqual(['crypto.withdrawal:write']);
    });

    it.each([
      [{ status: 'revoked' }],
      [{ revoked_at: '2026-02-01T00:00:00.000Z' }],
    ])('rejects a revoked or inactive key %p', async (patch) => {
      const { fn } = makeFetch(() => ({ body: keyBody(patch) }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeAuthError);
      expect(err.message).toMatch(/revoked or inactive/);
    });

    it('rejects an expired key', async () => {
      const { fn } = makeFetch(() => ({
        body: keyBody({ expires_at: '2020-01-01T00:00:00.000Z' }),
      }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeAuthError);
      expect(err.message).toMatch(/expired/);
    });

    it('throws ExchangeSchemaError on unknown shapes', async () => {
      for (const body of [
        '{"ok":true}',
        keyBody({ scopes: 'balance:read' }),
        keyBody({ expires_at: 'not a date' }),
        'not json',
      ]) {
        const { fn } = makeFetch(() => ({ body }));
        await expect(adapter(fn).inspectKey(creds)).rejects.toBeInstanceOf(
          ExchangeSchemaError,
        );
      }
    });

    it.each([
      [401, /signature/i],
      [403, /ip-restricted/i],
    ])('maps HTTP %s to a distinct ExchangeAuthError', async (status, re) => {
      const { fn } = makeFetch(() => ({
        status,
        body: '{"message":"TEST_KEY TEST_SECRET"}',
      }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeAuthError);
      expect(err.userMessage).toMatch(re);
      expect(err.message + err.userMessage).not.toMatch(/TEST_KEY|TEST_SECRET/);
    });

    it('429 throws ExchangeRateLimitError waiting 60 seconds', async () => {
      const { fn } = makeFetch(() => ({ status: 429, body: '' }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeRateLimitError);
      expect(err.retryAfterMs).toBe(60_000);
    });

    it('5xx and network failures are ExchangeNetworkError, redacting secrets', async () => {
      const { fn: f1 } = makeFetch(() => ({ status: 503, body: 'x' }));
      await expect(adapter(f1).inspectKey(creds)).rejects.toBeInstanceOf(
        ExchangeNetworkError,
      );
      const { fn } = makeFetch(() => ({
        throw: new Error('boom TEST_SECRET'),
      }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeNetworkError);
      expect(err.message).not.toContain('TEST_SECRET');
    });
  });

  describe('fetchBalances', () => {
    const both = () =>
      makeFetch(
        byPath({
          '/v1/crypto-account': { body: fixture('crypto-account.json') },
          '/v1/fiat-account': { body: fixture('fiat-account.json') },
        }),
      );

    it('merges non-zero wallets and fiat balances by asset with exact decimals', async () => {
      const { fn, calls } = both();
      const res = await adapter(fn).fetchBalances(creds);
      expect(res).toEqual(
        expect.arrayContaining([
          { asset: 'BTC', free: '1.25', locked: '0.25' },
          { asset: 'CRO', free: '250.123456789012345678', locked: '0' },
          // wallet USDT (0 free, 10 locked) + fiat USDT 5.5
          { asset: 'USDT', free: '5.5', locked: '10' },
          { asset: 'USD', free: '100.5', locked: '0' },
        ]),
      );
      expect(res).toHaveLength(4);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        '/v1/crypto-account',
        '/v1/fiat-account',
      ]);
    });

    it('never calls /v1/portfolio', async () => {
      const { fn, calls } = both();
      await adapter(fn).fetchBalances(creds);
      expect(calls.some((c) => c.url.includes('portfolio'))).toBe(false);
    });

    const emptyAcct = '{"ok":true,"account":{}}';
    it.each([
      ['crypto no wallets', emptyAcct, fixture('fiat-account.json')],
      [
        'wallet bad amount',
        '{"ok":true,"account":{"wallets":[{"currency":"BTC","balance":{"amount":"1e5"}}]}}',
        fixture('fiat-account.json'),
      ],
      [
        'wallet missing locked',
        '{"ok":true,"account":{"wallets":[{"currency":"BTC","balance":{"amount":"1"},"available":{"amount":"1"}}]}}',
        fixture('fiat-account.json'),
      ],
      ['fiat no balances', fixture('crypto-account.json'), emptyAcct],
      [
        'fiat bad amount',
        fixture('crypto-account.json'),
        '{"ok":true,"account":{"balances":[{"currency":"USD","amount":5}]}}',
      ],
    ])('throws ExchangeSchemaError: %s', async (_n, crypto, fiat) => {
      const { fn } = makeFetch(
        byPath({
          '/v1/crypto-account': { body: crypto },
          '/v1/fiat-account': { body: fiat },
        }),
      );
      await expect(adapter(fn).fetchBalances(creds)).rejects.toBeInstanceOf(
        ExchangeSchemaError,
      );
    });

    it('tolerates a large list of zero wallets', async () => {
      const wallets = Array.from({ length: 1955 }, (_, i) => ({
        currency: `Z${i}`,
        balance: { amount: '0' },
      }));
      const { fn } = makeFetch(
        byPath({
          '/v1/crypto-account': {
            body: JSON.stringify({ ok: true, account: { wallets } }),
          },
          '/v1/fiat-account': {
            body: '{"ok":true,"account":{"balances":[]}}',
          },
        }),
      );
      expect(await adapter(fn).fetchBalances(creds)).toEqual([]);
    });
  });

  describe('per-key lanes', () => {
    it('serializes one key, keeps timestamps monotonic, does not block other keys, and cleans up', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const order: string[] = [];
      const fn = jest.fn(async (_url: any, init: any) => {
        const key = init.headers['Cdc-Api-Key'];
        order.push(`${key}:${init.headers['Cdc-Api-Timestamp']}`);
        if (
          key === 'A' &&
          order.filter((o) => o.startsWith('A:')).length === 1
        ) {
          await gate;
        }
        return {
          ok: true,
          status: 200,
          text: async () => fixture('api-key-current.json'),
        } as any;
      }) as unknown as typeof fetch;
      const a = adapter(fn);
      const a1 = a.inspectKey({ apiKey: 'A', apiSecret: 's' });
      const a2 = a.inspectKey({ apiKey: 'A', apiSecret: 's' });
      const b = a.inspectKey({ apiKey: 'B', apiSecret: 's' });
      await b; // B is not stuck behind A's blocked call
      expect(order.filter((o) => o.startsWith('A:'))).toHaveLength(1);
      release();
      await Promise.all([a1, a2]);
      const ts = order
        .filter((o) => o.startsWith('A:'))
        .map((o) => Number(o.slice(2)));
      expect(ts[1]).toBeGreaterThan(ts[0]); // same clock value, still strictly increasing
      await new Promise((r) => setImmediate(r));
      expect((a as any).lanes.size).toBe(0);
    });
  });

  it('fetchHistory is a stub until Task 5', async () => {
    const a = adapter(makeFetch(() => ({ body: '{}' })).fn);
    expect(await a.fetchHistory(creds, {})).toEqual({ records: [] });
  });
});
