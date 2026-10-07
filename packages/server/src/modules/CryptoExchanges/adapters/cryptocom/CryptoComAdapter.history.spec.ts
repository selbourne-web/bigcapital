import * as fs from 'fs';
import * as path from 'path';
import {
  CRYPTOCOM_RETENTION_MS,
  CryptoComAdapter,
  quoteExactNumbers,
} from './CryptoComAdapter';
import { ExchangeSchemaError } from '../errors';

// Fixtures for trades/orders/transactions are DOCS-DERIVED (the probed key had none):
// https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-get-trades.md
// https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-get-order-history.md
// https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-get-transactions.md
// Deposit/withdrawal fixtures follow the 2026-10-06 live probe (amounts are JSON numbers):
// https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-get-deposit-history.md
// https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-get-withdrawal-history.md

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const creds = { apiKey: 'TEST_KEY', apiSecret: 'TEST_SECRET' };
type Call = { url: string; init: any; body: any };

function makeFetch(responder: (call: Call, n: number) => { body: string }) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const call = { url: String(url), init, body: JSON.parse(init.body) };
    calls.push(call);
    const r = responder(call, calls.length);
    return { ok: true, status: 200, text: async () => r.body } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('CryptoComAdapter.fetchHistory', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;
  const RETENTION = CRYPTOCOM_RETENTION_MS;
  const sleeps: number[] = [];
  const hist = (fn: typeof fetch) =>
    new CryptoComAdapter(
      fn,
      30_000,
      () => NOW,
      undefined,
      async (ms) => {
        sleeps.push(ms);
      },
    );
  const ok = (result: unknown) => ({
    body: JSON.stringify({ code: 0, result }),
  });
  const emptyFor = (method: string) =>
    ok(
      method.includes('deposit')
        ? { deposit_list: [] }
        : method.includes('withdrawal')
          ? { withdrawal_list: [] }
          : { data: [] },
    );
  const cur = (stream: string, windowEnd: number, page?: number) =>
    JSON.stringify({ stream, windowEnd, ...(page ? { page } : {}) });

  async function drain(a: CryptoComAdapter, q: { since?: Date }) {
    const records: any[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const r = await a.fetchHistory(creds, { ...q, cursor });
      records.push(...r.records);
      cursor = r.nextCursor;
      calls++;
    } while (cursor && calls < 1000);
    return { records, calls };
  }

  beforeEach(() => {
    sleeps.length = 0;
  });

  it('exposes historyPageCost 10', () => {
    const a = hist(makeFetch(() => ok({})).fn);
    expect(a.rateLimit.historyPageCost).toBe(10);
  });

  it('clamps a 14-month since to the retention floor and walks contiguous 1-day windows in stream order', async () => {
    const { fn, calls } = makeFetch((c) => emptyFor(c.body.method));
    const { records, calls: nCalls } = await drain(hist(fn), {
      since: new Date(NOW - 14 * 30 * DAY),
    });
    expect(records).toEqual([]);
    expect(nCalls).toBeGreaterThan(3);
    expect([...new Set(calls.map((c) => c.body.method))]).toEqual([
      'private/get-trades',
      'private/get-order-history',
      'private/get-transactions',
      'private/get-deposit-history',
      'private/get-withdrawal-history',
    ]);
    const trades = calls.filter((c) => c.body.method === 'private/get-trades');
    expect(trades[0].body.params).toEqual({
      start_time: NOW - DAY,
      end_time: NOW,
      limit: 100,
    });
    for (let i = 1; i < trades.length; i++) {
      expect(trades[i].body.params.end_time).toBe(
        trades[i - 1].body.params.start_time,
      );
    }
    expect(trades[trades.length - 1].body.params.start_time).toBe(
      NOW - RETENTION,
    );
    for (const c of calls) {
      const p = c.body.params;
      expect(p.start_time ?? p.start_ts).toBeGreaterThanOrEqual(
        NOW - RETENTION,
      );
    }
  });

  it('never exceeds 8 requests per call and paces slow endpoints', async () => {
    const { fn, calls } = makeFetch((c) => emptyFor(c.body.method));
    const r = await hist(fn).fetchHistory(creds, {});
    expect(calls).toHaveLength(8);
    expect(JSON.parse(r.nextCursor!)).toEqual({
      stream: 'trades',
      windowEnd: NOW - 8 * DAY,
    });
    expect(sleeps).toEqual(Array(7).fill(1100));
  });

  it('re-requests a window that returned exactly 100 rows from the oldest row, losing nothing', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      trade_id: String(1000 + i),
      create_time: NOW - 1000 - i * 10, // newest first; oldest = NOW - 1990
    }));
    const { fn, calls } = makeFetch((c, n) =>
      n === 1 ? ok({ data: rows }) : emptyFor(c.body.method),
    );
    const a = hist(fn);
    const first = await a.fetchHistory(creds, {});
    expect(first.records).toHaveLength(100);
    expect(new Set(first.records.map((r) => r.exchangeRecordId)).size).toBe(
      100,
    );
    expect(JSON.parse(first.nextCursor!)).toEqual({
      stream: 'trades',
      windowEnd: NOW - 1989,
    });
    await a.fetchHistory(creds, { cursor: first.nextCursor });
    // same window re-requested, ending just after (so including) the oldest row
    expect(calls[1].body.params.end_time).toBe(NOW - 1989);
    expect(calls[1].body.params.start_time).toBe(NOW - 1989 - DAY);
  });

  it('does not loop when 100 rows share the last millisecond of the window', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      trade_id: String(i),
      create_time: NOW - 1,
    }));
    const { fn } = makeFetch((c, n) =>
      n === 1 ? ok({ data: rows }) : emptyFor(c.body.method),
    );
    const r = await hist(fn).fetchHistory(creds, {});
    expect(JSON.parse(r.nextCursor!).windowEnd).toBe(NOW - 1);
  });

  it('is idempotent for a record seen in two overlapping windows', async () => {
    const a = hist(makeFetch(() => ({ body: fixture('trades-page.json') })).fn);
    const r1 = await a.fetchHistory(creds, {});
    const r2 = await a.fetchHistory(creds, {
      cursor: cur('trades', NOW - 1000),
    });
    const ids = (r: { records: any[] }) =>
      r.records.map((x) => x.exchangeRecordId);
    expect(ids(r1)).toEqual(['trade:1210447366', 'trade:1210447367']);
    expect(ids(r2)).toEqual(ids(r1));
    expect(r1.records[0]).toMatchObject({
      type: 'trade',
      occurredAt: new Date(1693000100000),
    });
  });

  it('maps order history rows (all statuses kept raw) as trades with order: ids', async () => {
    const a = hist(
      makeFetch(() => ({ body: fixture('order-history-page.json') })).fn,
    );
    const r = await a.fetchHistory(creds, { cursor: cur('orders', NOW) });
    expect(r.records.map((x) => [x.type, x.exchangeRecordId])).toEqual([
      ['trade', 'order:19848525'],
      ['trade', 'order:19848527'],
    ]);
    expect((r.records[1].payload as any).status).toBe('CANCELED');
  });

  it('maps transactions: fee rows, skips duplicates of other streams, keeps the rest as unparsed', async () => {
    const a = hist(
      makeFetch(() => ({ body: fixture('transactions-page.json') })).fn,
    );
    const r = await a.fetchHistory(creds, {
      cursor: cur('transactions', NOW),
    });
    expect(r.records.map((x) => x.type)).toEqual(['fee', 'unparsed']);
    expect(r.records[0].exchangeRecordId).toBe('tx:187439');
    expect((r.records[1].payload as any).row.journal_type).toBe(
      'MANUAL_CONVERSION',
    );
  });

  it('round-trips the cursor and rejects malformed cursors with ExchangeSchemaError', async () => {
    const { fn, calls } = makeFetch((c) => emptyFor(c.body.method));
    const a = hist(fn);
    const r1 = await a.fetchHistory(creds, {});
    const n = calls.length;
    const r2 = await a.fetchHistory(creds, { cursor: r1.nextCursor });
    expect(calls[n].body.params.end_time).toBe(NOW - 8 * DAY);
    expect(JSON.parse(r2.nextCursor!).windowEnd).toBe(NOW - 16 * DAY);
    const rt = cur('deposits', NOW, 2);
    expect(JSON.parse(rt)).toEqual({
      stream: 'deposits',
      windowEnd: NOW,
      page: 2,
    });
    const before = calls.length;
    await a.fetchHistory(creds, { cursor: rt });
    expect(calls[before].body.params.page).toBe(2);

    for (const bad of [
      'not json',
      'null',
      '[]',
      '{"stream":"bogus","windowEnd":1}',
      '{"stream":"trades","windowEnd":-1}',
      '{"stream":"trades","windowEnd":"1"}',
      '{"stream":"deposits","windowEnd":5,"page":-1}',
      '{"stream":"deposits","windowEnd":5,"page":1.5}',
    ]) {
      await expect(
        a.fetchHistory(creds, { cursor: bad }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    }
  });

  it('walks deposit pages (page_size 200, 90-day window) with exact amounts', async () => {
    const dep = JSON.parse(fixture('deposit-history.json'));
    const full = Array.from({ length: 200 }, (_, i) => ({
      ...dep.result.deposit_list[0],
      id: String(5000 + i),
    }));
    const { fn, calls } = makeFetch((c) => {
      if (c.body.method !== 'private/get-deposit-history') {
        return emptyFor(c.body.method);
      }
      return c.body.params.page === 0
        ? ok({ deposit_list: full })
        : { body: fixture('deposit-history.json') };
    });
    const a = hist(fn);
    const p0 = await a.fetchHistory(creds, { cursor: cur('deposits', NOW) });
    expect(p0.records).toHaveLength(200);
    expect(calls[0].body.params).toEqual({
      start_ts: NOW - 90 * DAY,
      end_ts: NOW,
      page: 0,
      page_size: 200,
    });
    expect(JSON.parse(p0.nextCursor!)).toEqual({
      stream: 'deposits',
      windowEnd: NOW,
      page: 1,
    });
    const p1 = await a.fetchHistory(creds, { cursor: p0.nextCursor });
    expect(calls[1].body.params.page).toBe(1);
    expect(p1.records.map((r) => r.exchangeRecordId)).toEqual([
      'dep:2220',
      'dep:2219',
      'dep:2218',
    ]);
    // short page: window done, next window ends where this one started
    expect(JSON.parse(p1.nextCursor!)).toEqual({
      stream: 'deposits',
      windowEnd: NOW - 90 * DAY,
    });
    expect(p1.records.every((r) => r.type === 'deposit')).toBe(true);
    const payloads = p1.records.map((r) => r.payload as any);
    // JSON numbers 0.00050000 / 1.0 / 0.00000000 / 12345678901.12345678 stay exact text
    expect(payloads.map((p) => [p.amount, p.fee])).toEqual([
      ['0.00050000', '0.00000000'],
      ['100', '1.0'],
      ['12345678901.12345678', '0'],
    ]);
    expect(payloads[0].normalizedAsset).toBe('BTC');
    expect(p1.records[0].occurredAt).toEqual(new Date(1693000200000));
  });

  it('maps withdrawals; the final window of the final stream returns no cursor', async () => {
    const { fn } = makeFetch((c) =>
      c.body.method === 'private/get-withdrawal-history'
        ? { body: fixture('withdrawal-history.json') }
        : emptyFor(c.body.method),
    );
    const a = hist(fn);
    const r = await a.fetchHistory(creds, {
      cursor: cur('withdrawals', NOW - 90 * DAY),
    });
    expect(r.records.map((x) => [x.type, x.exchangeRecordId])).toEqual([
      ['withdrawal', 'wd:3301'],
    ]);
    expect((r.records[0].payload as any).amount).toBe('250.00000000');
    expect((r.records[0].payload as any).fee).toBe('0.02000000');
    expect(r.nextCursor).toBeUndefined(); // window reached the 180-day floor
    const mid = await a.fetchHistory(creds, {
      cursor: cur('withdrawals', NOW),
    });
    expect(mid.nextCursor).toBeDefined();
  });

  it('applies the 14-day overlap to deposit lists but not to trades', async () => {
    const { fn, calls } = makeFetch((c) => emptyFor(c.body.method));
    await drain(hist(fn), { since: new Date(NOW - 2 * DAY) });
    const trades = calls.filter((c) => c.body.method === 'private/get-trades');
    expect(trades[trades.length - 1].body.params.start_time).toBe(
      NOW - 2 * DAY,
    );
    const deps = calls.filter(
      (c) => c.body.method === 'private/get-deposit-history',
    );
    expect(deps[deps.length - 1].body.params.start_ts).toBe(NOW - 16 * DAY);
  });

  it('keeps unknown shapes as unparsed records and never drops them', async () => {
    const bad = {
      deposit_list: [
        {
          id: '1',
          currency: 'BTC',
          amount: 'weird',
          fee: 0,
          create_time: 1693000000000,
        },
        'garbage',
        {
          id: '2',
          currency: 'BTC',
          amount: 1e-7,
          fee: 0,
          create_time: 1693000000000,
        },
      ],
    };
    const raw = JSON.stringify({ code: 0, result: bad }).replace(
      '"amount":1e-7',
      '"amount":1e-7',
    );
    const a = hist(makeFetch(() => ({ body: raw })).fn);
    const r = await a.fetchHistory(creds, { cursor: cur('deposits', NOW) });
    expect(r.records.map((x) => x.type)).toEqual([
      'unparsed',
      'unparsed',
      'deposit',
    ]);
    expect((r.records[2].payload as any).amount).toBe('0.0000001');
    const again = await a.fetchHistory(creds, {
      cursor: cur('deposits', NOW),
    });
    expect(again.records[1].exchangeRecordId).toBe(
      r.records[1].exchangeRecordId,
    );

    const tr = hist(
      makeFetch(() =>
        ok({ data: [{ trade_id: '9', create_time: 'nope' }, 42] }),
      ).fn,
    );
    const t = await tr.fetchHistory(creds, {});
    expect(t.records.map((x) => x.type)).toEqual(['unparsed', 'unparsed']);
  });

  it('throws ExchangeSchemaError when a result list is not an array', async () => {
    const a = hist(makeFetch(() => ok({ data: 'nope' })).fn);
    await expect(a.fetchHistory(creds, {})).rejects.toBeInstanceOf(
      ExchangeSchemaError,
    );
  });

  describe('quoteExactNumbers', () => {
    it('quotes amount/fee number tokens only, leaving strings and other keys', () => {
      const raw =
        '{"amount":0.00050000,"fee":1,"x":{"amount":"5"},"note":"\\"amount\\":7","amount_x":3}';
      const parsed = JSON.parse(quoteExactNumbers(raw));
      expect(parsed.amount).toBe('0.00050000');
      expect(parsed.fee).toBe('1');
      expect(parsed.x.amount).toBe('5');
      expect(parsed.note).toBe('"amount":7');
      expect(parsed.amount_x).toBe(3);
    });
  });
});
