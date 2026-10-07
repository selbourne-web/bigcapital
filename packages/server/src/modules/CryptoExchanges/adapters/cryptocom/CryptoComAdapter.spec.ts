import * as fs from 'fs';
import * as path from 'path';
import { CryptoComAdapter } from './CryptoComAdapter';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const creds = { apiKey: ' TEST_KEY ', apiSecret: ' TEST_SECRET\n' };
type Call = { url: string; init: any; body: any };

function makeFetch(responder: (call: Call, n: number) => any) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const call = { url: String(url), init, body: JSON.parse(init.body) };
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
const byMethod = (map: Record<string, any>) => (c: Call) =>
  map[c.body.method] ?? { body: '{}' };
const adapter = (fn: typeof fetch) =>
  new CryptoComAdapter(fn, 30_000, () => 1_700_000_000_000);

describe('CryptoComAdapter', () => {
  it('exposes id, rate limit and partial history coverage', () => {
    const a = adapter(makeFetch(() => ({ body: '{}' })).fn);
    expect(a.id).toBe('crypto_com');
    expect(a.rateLimit).toEqual({
      capacity: 3,
      refillPerSec: 10,
      historyPageCost: 10,
    });
    expect(a.historyCoverage.level).toBe('partial');
  });

  it('posts a signed JSON request to the fixed host with trimmed credentials', async () => {
    const { fn, calls } = makeFetch(() => ({
      body: fixture('user-balance.json'),
    }));
    await adapter(fn).fetchBalances(creds);
    const { url, init, body } = calls[0];
    expect(url).toBe('https://api.crypto.com/exchange/v1/private/user-balance');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(body.api_key).toBe('TEST_KEY');
    expect(body.nonce).toBe(1_700_000_000_000);
    expect(body.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain('TEST_SECRET');
  });

  describe('fetchBalances', () => {
    it('maps non-zero positions, free = quantity - reserved, exact decimals', async () => {
      const { fn } = makeFetch(() => ({ body: fixture('user-balance.json') }));
      const res = await adapter(fn).fetchBalances(creds);
      expect(res).toEqual([
        { asset: 'BTC', free: '1.25', locked: '0.25' },
        { asset: 'CRO', free: '250.123456789012345678', locked: '0' },
        { asset: 'USDT', free: '0', locked: '10' },
      ]);
    });

    it('throws ExchangeSchemaError on unknown shape', async () => {
      const { fn } = makeFetch(() => ({
        body: '{"code":0,"result":{"data":"nope"}}',
      }));
      await expect(adapter(fn).fetchBalances(creds)).rejects.toBeInstanceOf(
        ExchangeSchemaError,
      );
    });
  });

  describe('inspectKey', () => {
    it('warns about withdrawal when the probe succeeds, never leaking addresses', async () => {
      const { fn, calls } = makeFetch(
        byMethod({
          'private/user-balance': { body: fixture('user-balance.json') },
          'private/get-deposit-address': {
            body: fixture('deposit-address-ok.json'),
          },
        }),
      );
      const res = await adapter(fn).inspectKey(creds);
      expect(res.readOnly).toBe('unverifiable');
      expect(res.permissions).toEqual(['read']);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings![0]).toMatch(/withdrawal/i);
      expect(JSON.stringify(res)).not.toContain('SECRETADDRESSPROBE');
      expect(calls.map((c) => c.body.method)).toEqual([
        'private/user-balance',
        'private/get-deposit-address',
      ]);
      expect(calls[1].body.params).toEqual({ currency: 'BTC' });
    });

    it('returns no warning when the probe is denied', async () => {
      const { fn } = makeFetch(
        byMethod({
          'private/user-balance': { body: fixture('user-balance.json') },
          'private/get-deposit-address': {
            body: fixture('deposit-address-denied.json'),
          },
        }),
      );
      expect(await adapter(fn).inspectKey(creds)).toEqual({
        readOnly: 'unverifiable',
        permissions: ['read'],
        warnings: [],
      });
    });

    it.each([
      [40101, 401, /signature/i],
      [40102, 400, /clock/i],
      [40103, 401, /allow-list/i],
    ])(
      'maps code %s to a distinct ExchangeAuthError',
      async (code, status, re) => {
        const { fn } = makeFetch(() => ({
          status,
          body: JSON.stringify({ code, message: 'TEST_KEY TEST_SECRET' }),
        }));
        const err: any = await adapter(fn)
          .inspectKey(creds)
          .catch((e) => e);
        expect(err).toBeInstanceOf(ExchangeAuthError);
        expect(err.userMessage).toMatch(re);
        expect(err.message + err.userMessage).not.toMatch(
          /TEST_KEY|TEST_SECRET/,
        );
      },
    );

    it('throws ExchangeNetworkError on network failure, redacting secrets', async () => {
      const { fn } = makeFetch(() => ({
        throw: new Error('boom TEST_SECRET'),
      }));
      const err: any = await adapter(fn)
        .inspectKey(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeNetworkError);
      expect(err.message).not.toContain('TEST_SECRET');
    });

    it.each([
      ['network error', { throw: new Error('socket hang up') }],
      ['5xx', { status: 503, body: 'x' }],
      ['rate limit', { status: 429, body: '' }],
    ])('does not fail when the probe hits %s', async (_n, probe) => {
      const { fn } = makeFetch(
        byMethod({
          'private/user-balance': { body: fixture('user-balance.json') },
          'private/get-deposit-address': probe,
        }),
      );
      expect(await adapter(fn).inspectKey(creds)).toEqual({
        readOnly: 'unverifiable',
        permissions: ['read'],
        warnings: [],
      });
    });
  });

  it('maps HTTP 429 to ExchangeRateLimitError', async () => {
    const { fn } = makeFetch(() => ({ status: 429, body: '' }));
    await expect(adapter(fn).fetchBalances(creds)).rejects.toBeInstanceOf(
      ExchangeRateLimitError,
    );
  });

  it('fetchHistory is a Task 3 stub returning no records', async () => {
    const a = adapter(makeFetch(() => ({ body: '{}' })).fn);
    expect(await a.fetchHistory(creds, {})).toEqual({ records: [] });
  });
});
