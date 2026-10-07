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
    'crypto.swap:write',
    'staking:write',
    'card.spend:write',
    'earn.deposit:write',
    'something.unknown:write',
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

    const walletsOnly = (wallets: any[]) =>
      makeFetch(
        byPath({
          '/v1/crypto-account': {
            body: JSON.stringify({ ok: true, account: { wallets } }),
          },
          '/v1/fiat-account': { body: '{"ok":true,"account":{"balances":[]}}' },
        }),
      ).fn;
    const W = (currency: string, balance: any, extra: any = {}) => ({
      currency,
      balance: { amount: balance },
      ...extra,
    });
    const amt = (a: string) => ({ amount: a });

    it('balance is authoritative: balance 10, available 0, locked 0 => free 0, locked 10', async () => {
      const fn = walletsOnly([
        W('AAA', '10', { available: amt('0'), locked: amt('0') }),
      ]);
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'AAA', free: '0', locked: '10' },
      ]);
    });
    it('locked is derived from balance - available even if `locked` disagrees', async () => {
      const fn = walletsOnly([
        W('AAA', '10.5', { available: amt('4.25'), locked: amt('1') }),
      ]);
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'AAA', free: '4.25', locked: '6.25' },
      ]);
    });
    it('absent or null available/locked => free = balance, locked 0', async () => {
      const fn = walletsOnly([
        W('AAA', '3'),
        W('BBB', '2', { available: null, locked: null }),
      ]);
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'AAA', free: '3', locked: '0' },
        { asset: 'BBB', free: '2', locked: '0' },
      ]);
    });
    it('available > balance clamps locked at 0', async () => {
      const fn = walletsOnly([W('AAA', '1', { available: amt('2') })]);
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'AAA', free: '2', locked: '0' },
      ]);
    });
    it('skips odd wallets (negative, non-decimal, missing balance) without failing', async () => {
      const fn = walletsOnly([
        W('NEG', '-5'),
        W('BAD', '1e5'),
        W('NUM', 5),
        { currency: 'NOBAL' },
        null,
        { balance: amt('1') },
        W('OK', '1'),
      ]);
      expect(await adapter(fn).fetchBalances(creds)).toEqual([
        { asset: 'OK', free: '1', locked: '0' },
      ]);
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

  describe('query, drain and drift', () => {
    it('signature excludes the query, which is serialized in stable order', async () => {
      const { fn, calls } = makeFetch(() => ({
        body: fixture('api-key-current.json'),
      }));
      const a = adapter(fn);
      await (a as any).get(
        { apiKey: 'TEST_KEY', apiSecret: 'TEST_SECRET' },
        '/v1/crypto-account',
        { sort_by: 'id', count: 50, order: 'desc' },
      );
      expect(calls[0].url).toBe(
        'https://wapi.crypto.com/v1/crypto-account?count=50&order=desc&sort_by=id',
      );
      expect(calls[0].init.headers['Cdc-Api-Signature']).toBe(
        createHmac('sha256', 'TEST_SECRET')
          .update(`${NOW}GET/v1/crypto-account`)
          .digest('base64'),
      );
    });

    it('allow-list rejects unknown paths, with or without a query', async () => {
      const { fn, calls } = makeFetch(() => ({ body: '{}' }));
      const a = adapter(fn);
      const c = { apiKey: 'K', apiSecret: 'S' };
      await expect((a as any).get(c, '/v1/portfolio')).rejects.toThrow(
        /Refusing/,
      );
      await expect(
        (a as any).get(c, '/v1/portfolio', { a: 1 }),
      ).rejects.toThrow(/Refusing/);
      expect(calls).toHaveLength(0);
    });

    it.each([401, 403, 429])(
      'reads the body on %s so the connection is released',
      async (status) => {
        const text = jest.fn(async () => '');
        const fn = jest.fn(async () => ({ ok: false, status, text })) as any;
        await adapter(fn)
          .inspectKey(creds)
          .catch(() => undefined);
        expect(text).toHaveBeenCalled();
      },
    );

    it('waits instead of drifting more than 5s ahead of the clock', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const stamps: string[] = [];
      const fn = jest.fn(async (_u: any, init: any) => {
        stamps.push(init.headers['Cdc-Api-Timestamp']);
        if (stamps.length === 1) await gate;
        return {
          ok: true,
          status: 200,
          text: async () => fixture('api-key-current.json'),
        } as any;
      }) as unknown as typeof fetch;
      const sleep = jest.fn(async () => undefined);
      const a = new CryptoComAppAdapter(
        fn,
        30_000,
        () => NOW,
        undefined,
        sleep,
      );
      const p1 = a.inspectKey(creds);
      await new Promise((r) => setImmediate(r));
      // push the lane 10s ahead of the clock, as if many calls had burst
      const lane: any = [...(a as any).lanes.values()][0];
      lane.lastTs = NOW + 10_000;
      const p2 = a.inspectKey(creds);
      release();
      await Promise.all([p1, p2]);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(5_001);
      expect(Number(stamps[1])).toBeGreaterThan(Number(stamps[0]));
    });
  });

  describe('fetchHistory', () => {
    const page = (name: string) => JSON.parse(fixture(name));
    const body = (o: unknown) => ({ body: JSON.stringify(o) });
    const env = (txs: any[], next?: any) => ({
      ok: true,
      transactions: txs,
      meta: { pagination: { total: 1, ...(next ? { next } : {}) } },
    });
    const NEXT = {
      last_id: '0000000000000050',
      count: 50,
      pagination_key: 'K',
      sort_by: 'id',
      order: 'desc',
    };
    const one = (patch: Record<string, unknown> = {}) => ({
      ...page('transactions-last.json').transactions[0],
      ...patch,
    });
    const params = (c: Call) =>
      Object.fromEntries(new URL(c.url).searchParams.entries());

    it('walks three pages, ignoring a wrong total, and ends when next is absent', async () => {
      const files = [
        'transactions-page1.json',
        'transactions-page2.json',
        'transactions-last.json',
      ];
      const { fn, calls } = makeFetch((_c, n) => ({
        body: fixture(files[n - 1]),
      }));
      const a = adapter(fn);
      const r1 = await a.fetchHistory(creds, {});
      expect(r1.records).toHaveLength(50);
      expect(JSON.parse(r1.nextCursor!)).toEqual(
        page('transactions-page1.json').meta.pagination.next,
      );
      const r2 = await a.fetchHistory(creds, { cursor: r1.nextCursor });
      expect(r2.records).toHaveLength(4);
      expect(JSON.parse(r2.nextCursor!).pagination_key).toBe('PAGEKEY2');
      const r3 = await a.fetchHistory(creds, { cursor: r2.nextCursor });
      expect(r3.records).toHaveLength(3);
      expect(r3.nextCursor).toBeUndefined();
      // request spying: only GET /v1/transactions; exact query params
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.init.method).toBe('GET');
        expect(new URL(c.url).pathname).toBe('/v1/transactions');
      }
      expect(params(calls[0])).toEqual({ count: '50' });
      expect(params(calls[1])).toEqual({
        last_id: '00000000000000051',
        count: '50',
        pagination_key: 'PAGEKEY1',
        sort_by: 'id',
        order: 'desc',
      });
      expect(params(calls[2])).toEqual({
        last_id: '00000000000000047',
        count: '50',
        pagination_key: 'PAGEKEY2',
        sort_by: 'id',
        order: 'desc',
      });
    });

    it('maps kinds and nature, marks internal transfers, keeps swap pair as two rows', async () => {
      const { fn } = makeFetch(() => ({
        body: fixture('transactions-page1.json'),
      }));
      const r = await adapter(fn).fetchHistory(creds, {});
      const byKind = (k: string) =>
        r.records.filter((x: any) => x.payload.item.kind === k)[0] as any;
      expect(byKind('crypto_deposit').type).toBe('deposit');
      expect(byKind('crypto_deposit').payload.internalTransfer).toBe(false);
      expect(byKind('finance.dpos.staking.crypto_wallet').type).toBe('reward');
      const out = byKind('crypto_to_exchange_transfer');
      expect(out.type).toBe('withdrawal');
      expect(out.payload.internalTransfer).toBe(true);
      const inn = byKind('exchange_to_crypto_transfer');
      expect(inn.type).toBe('deposit');
      expect(inn.payload.internalTransfer).toBe(true);
      const debit = byKind('crypto_wallet_swap_debited');
      const credit = byKind('crypto_wallet_swap_credited');
      expect(debit.type).toBe('trade');
      expect(credit.type).toBe('trade');
      expect(debit.exchangeRecordId).not.toBe(credit.exchangeRecordId);
      expect(debit.exchangeRecordId).toBe(`app:${debit.payload.item.id}:sdone`);
      // amounts stay strings in the payload
      expect(typeof debit.payload.item.amount.amount).toBe('string');
      expect(debit.occurredAt).toEqual(new Date(debit.payload.item.created_at));
      expect(new Set(r.records.map((x) => x.exchangeRecordId)).size).toBe(50);
    });

    it('falls back to nature when kind is unmapped, and withdraw matches', async () => {
      const { fn } = makeFetch(() =>
        body(
          env([
            one({ id: '1', kind: 'zzz', nature: 'rewards_platform_x' }),
            one({ id: '2', kind: 'crypto_withdrawal', nature: 'payment' }),
            one({ id: '3', kind: 'zzz', nature: 'payment' }),
          ]),
        ),
      );
      const r = await adapter(fn).fetchHistory(creds, {});
      expect(r.records.map((x) => x.type)).toEqual([
        'reward',
        'withdrawal',
        'unparsed',
      ]);
    });

    it('stops at since, emits only newer records and no nextCursor', async () => {
      const p = page('transactions-page1.json');
      const since = new Date(p.transactions[9].created_at);
      const { fn, calls } = makeFetch(() => ({ body: JSON.stringify(p) }));
      const r = await adapter(fn).fetchHistory(creds, { since });
      expect(r.records).toHaveLength(10); // items 0..9 (created_at >= since)
      expect(r.nextCursor).toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it('tolerates unknown kind, pending status, missing fee and missing amount', async () => {
      const noFee: any = one({ id: '11' });
      delete noFee.fee;
      const noAmount: any = one({ id: '12' });
      delete noAmount.amount;
      const { fn } = makeFetch(() =>
        body(
          env([
            one({ id: '10', kind: 'brand_new_kind', nature: 'brand_new' }),
            noFee,
            noAmount,
            one({ id: '13', status: 'pending' }),
            one({ id: '14', status: undefined }),
            null,
            'junk',
            one({ id: '15', created_at: 'garbage' }),
            one({ id: '16', amount: { currency: 'BTC', amount: 1.5 } }),
          ]),
        ),
      );
      const r = await adapter(fn).fetchHistory(creds, {});
      expect(r.records).toHaveLength(9);
      expect(r.records.map((x) => x.type)).toEqual([
        'unparsed',
        'deposit', // the base fixture item is a crypto_deposit; missing fee tolerated
        'unparsed',
        'deposit',
        'unparsed',
        'unparsed',
        'unparsed',
        'unparsed',
        'unparsed',
      ]);
      expect(r.records[3].exchangeRecordId).toBe('app:13:spending');
      expect(r.records[4].exchangeRecordId).toMatch(
        /^unparsed:app:[0-9a-f]{32}$/,
      );
      expect(r.records.every((x) => x.occurredAt instanceof Date)).toBe(true);
    });

    it('a status change of the same transaction is a new record id', async () => {
      const mk = (status: string) =>
        adapter(makeFetch(() => body(env([one({ id: '9', status })]))).fn);
      const a = await mk('pending').fetchHistory(creds, {});
      const b = await mk('done').fetchHistory(creds, {});
      expect(a.records[0].exchangeRecordId).toBe('app:9:spending');
      expect(b.records[0].exchangeRecordId).toBe('app:9:sdone');
    });

    it('unparsed id is a stable content hash (dedupes re-fetches)', async () => {
      const mk = () =>
        adapter(
          makeFetch(() => body(env([one({ id: '9', status: undefined })]))).fn,
        );
      const a = await mk().fetchHistory(creds, {});
      const b = await mk().fetchHistory(creds, {});
      expect(a.records[0].exchangeRecordId).toBe(b.records[0].exchangeRecordId);
    });

    it.each([
      ['ok missing', { transactions: [] }],
      ['transactions missing', { ok: true }],
      ['transactions not an array', { ok: true, transactions: {} }],
    ])('envelope %s throws ExchangeSchemaError', async (_n, b) => {
      const { fn } = makeFetch(() => body(b));
      await expect(adapter(fn).fetchHistory(creds, {})).rejects.toBeInstanceOf(
        ExchangeSchemaError,
      );
    });

    it('ok:false is an exchange-reported error (shared send path), not a stored record', async () => {
      const { fn } = makeFetch(() => body({ ok: false, transactions: [] }));
      await expect(adapter(fn).fetchHistory(creds, {})).rejects.toBeInstanceOf(
        ExchangeNetworkError,
      );
    });

    it('non-JSON response throws ExchangeSchemaError', async () => {
      const { fn } = makeFetch(() => ({ body: '<html>' }));
      await expect(adapter(fn).fetchHistory(creds, {})).rejects.toBeInstanceOf(
        ExchangeSchemaError,
      );
    });

    it('missing next mid-data ends the stream; missing meta/total is fine', async () => {
      const { fn } = makeFetch(() =>
        body({ ok: true, transactions: [one({ id: '1' })] }),
      );
      const r = await adapter(fn).fetchHistory(creds, {});
      expect(r.records).toHaveLength(1);
      expect(r.nextCursor).toBeUndefined();
    });

    it('ids that are not numeric-ordered are all kept', async () => {
      const { fn } = makeFetch(() =>
        body(
          env(
            [one({ id: '900' }), one({ id: '12' }), one({ id: '500' })],
            NEXT,
          ),
        ),
      );
      const r = await adapter(fn).fetchHistory(creds, {});
      expect(r.records).toHaveLength(3);
      expect(r.nextCursor).toBeDefined();
    });

    it.each([
      ['not json', 'nope'],
      ['array', '[]'],
      ['null', 'null'],
      ['missing last_id', JSON.stringify({ ...NEXT, last_id: undefined })],
      ['non-numeric last_id', JSON.stringify({ ...NEXT, last_id: 'abc' })],
      ['huge count', JSON.stringify({ ...NEXT, count: 500 })],
      ['zero count', JSON.stringify({ ...NEXT, count: 0 })],
      ['string count', JSON.stringify({ ...NEXT, count: '50' })],
      ['asc order', JSON.stringify({ ...NEXT, order: 'asc' })],
      [
        'oversize key',
        JSON.stringify({ ...NEXT, pagination_key: 'x'.repeat(300) }),
      ],
      ['bad sort_by', JSON.stringify({ ...NEXT, sort_by: 'id; drop' })],
      ['oversize cursor', 'x'.repeat(5000)],
    ])(
      'malformed cursor (%s) throws ExchangeSchemaError without any request',
      async (_n, cursor) => {
        const { fn, calls } = makeFetch(() => body(env([])));
        await expect(
          adapter(fn).fetchHistory(creds, { cursor }),
        ).rejects.toBeInstanceOf(ExchangeSchemaError);
        expect(calls).toHaveLength(0);
      },
    );

    it('extra keys in a cursor are not forwarded', async () => {
      const { fn, calls } = makeFetch(() => body(env([])));
      await adapter(fn).fetchHistory(creds, {
        cursor: JSON.stringify({ ...NEXT, evil: '1' }),
      });
      expect(Object.keys(params(calls[0])).sort()).toEqual([
        'count',
        'last_id',
        'order',
        'pagination_key',
        'sort_by',
      ]);
    });

    it('a malformed or non-progressing next from the server is a schema error', async () => {
      const bad = makeFetch(() => body(env([], { ...NEXT, count: 'x' })));
      await expect(
        adapter(bad.fn).fetchHistory(creds, {}),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
      const stuck = makeFetch(() => body(env([], NEXT)));
      await expect(
        adapter(stuck.fn).fetchHistory(creds, { cursor: JSON.stringify(NEXT) }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });

    it('an empty page with next still continues', async () => {
      const { fn } = makeFetch(() => body(env([], NEXT)));
      const r = await adapter(fn).fetchHistory(creds, {});
      expect(r.records).toEqual([]);
      expect(JSON.parse(r.nextCursor!)).toEqual(NEXT);
    });

    it('429 surfaces as a rate-limit error', async () => {
      const { fn } = makeFetch(() => ({ status: 429, body: '' }));
      await expect(adapter(fn).fetchHistory(creds, {})).rejects.toBeInstanceOf(
        ExchangeRateLimitError,
      );
    });
  });
});
