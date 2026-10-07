import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  CRYPTOCOM_RETENTION_MS,
  CryptoComAdapter,
  quoteExactNumbers,
} from './CryptoComAdapter';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

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
      'private/staking/get-reward-history',
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
      if (p.start_time !== undefined) {
        expect(p.start_time).toBeGreaterThanOrEqual(NOW - RETENTION);
      }
    }
    // I4: deposit/withdrawal lists are NOT clamped to 180 days; they follow since - 14d
    for (const m of [
      'private/get-deposit-history',
      'private/get-withdrawal-history',
    ]) {
      const lists = calls.filter((c) => c.body.method === m);
      const lowest = Math.min(...lists.map((c) => c.body.params.start_ts));
      expect(lowest).toBe(NOW - 14 * 30 * DAY - 14 * DAY);
      expect(lowest).toBeLessThan(NOW - RETENTION);
    }
  });

  it('walks deposit lists back to 2018-01-01 when there is no since', async () => {
    const { fn, calls } = makeFetch((c) => emptyFor(c.body.method));
    await drain(hist(fn), {});
    const deps = calls.filter(
      (c) => c.body.method === 'private/get-deposit-history',
    );
    expect(deps[deps.length - 1].body.params.start_ts).toBe(
      Date.UTC(2018, 0, 1),
    );
    expect(deps.length).toBeGreaterThan(20);
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

  // A fake server over a dataset: honours start_time (inclusive) / end_time
  // (exclusive) / limit, and returns rows newest-first or oldest-first.
  const serve =
    (
      method: string,
      rows: any[],
      timeKey: string,
      limit: number,
      order: 'asc' | 'desc',
    ) =>
    (c: Call) => {
      if (c.body.method !== method) return emptyFor(c.body.method);
      const { start_time: s, end_time: e } = c.body.params;
      const hit = rows
        .filter((r) => r[timeKey] >= s && r[timeKey] < e)
        .sort((a, b) =>
          order === 'asc' ? a[timeKey] - b[timeKey] : b[timeKey] - a[timeKey],
        )
        .slice(0, limit);
      return ok({ data: hit });
    };
  const tradeRows = (n: number, at: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({
      trade_id: String(1000 + i),
      create_time: at(i),
    }));

  it.each(['desc', 'asc'] as const)(
    'loses no rows when a window is full and the API returns rows %s',
    async (order) => {
      // 250 distinct rows in the first day plus a boundary row exactly at the window start
      const rows = tradeRows(250, (i) => NOW - 1000 - i * 5000);
      const { fn } = makeFetch(
        serve('private/get-trades', rows, 'create_time', 100, order),
      );
      const { records } = await drain(hist(fn), {
        since: new Date(NOW - 2 * DAY),
      });
      const ids = new Set(
        records
          .filter((r) => r.type === 'trade')
          .map((r) => r.exchangeRecordId),
      );
      expect(ids.size).toBe(250);
    },
  );

  it('queues both unseen sub-ranges in a resumable cursor after a full page', async () => {
    const rows = tradeRows(100, (i) => NOW - 1000 - i * 10); // oldest = NOW-1990
    const { fn, calls } = makeFetch((c, n) =>
      n === 1 ? ok({ data: rows }) : emptyFor(c.body.method),
    );
    const a = hist(fn);
    const first = await a.fetchHistory(creds, {});
    expect(first.records).toHaveLength(100);
    expect(JSON.parse(first.nextCursor!)).toEqual({
      stream: 'trades',
      windowEnd: NOW - DAY,
      pending: [
        [NOW - DAY, NOW - 1989], // older than the page, ties at the oldest ms included
        [NOW - 1000, NOW], // newer than the page, ties at the newest ms included
      ],
    });
    await a.fetchHistory(creds, { cursor: first.nextCursor });
    expect(calls[1].body.params).toMatchObject({
      start_time: NOW - DAY,
      end_time: NOW - 1989,
    });
    expect(calls[2].body.params).toMatchObject({
      start_time: NOW - 1000,
      end_time: NOW,
    });
  });

  it('terminates when 100+ rows share one millisecond (rows past the limit at that ms are unreachable)', async () => {
    // Documented limitation: the API has no cursor inside one millisecond.
    const rows = tradeRows(150, () => NOW - 5000);
    const { fn, calls } = makeFetch(
      serve('private/get-trades', rows, 'create_time', 100, 'desc'),
    );
    const { records, calls: n } = await drain(hist(fn), {
      since: new Date(NOW - 2 * DAY),
    });
    const trades = records.filter((r) => r.type === 'trade');
    expect(trades.length).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThan(40);
    expect(
      calls.filter((c) => c.body.method === 'private/get-trades').length,
    ).toBeLessThan(40);
  });

  it('rejects pending ranges that are malformed or on a list stream', async () => {
    const a = hist(makeFetch((c) => emptyFor(c.body.method)).fn);
    for (const bad of [
      '{"stream":"trades","windowEnd":5,"pending":"x"}',
      '{"stream":"trades","windowEnd":5,"pending":[[3,2]]}',
      '{"stream":"trades","windowEnd":5,"pending":[[1]]}',
      '{"stream":"deposits","windowEnd":5,"pending":[[1,2]]}',
    ]) {
      await expect(
        a.fetchHistory(creds, { cursor: bad }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    }
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
      ['trade', 'order:19848525:sFILLED'],
      ['trade', 'order:19848527:sCANCELED'],
    ]);
    expect((r.records[1].payload as any).status).toBe('CANCELED');
    expect((r.records[1].payload as any)._source).toBe('order-history');
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
      'dep:2220:s1',
      'dep:2219:s1',
      'dep:2218:s1',
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

  it('maps withdrawals; after the last list window the walk moves to rewards', async () => {
    const { fn } = makeFetch((c) =>
      c.body.method === 'private/get-withdrawal-history'
        ? { body: fixture('withdrawal-history.json') }
        : emptyFor(c.body.method),
    );
    const a = hist(fn);
    const r = await a.fetchHistory(creds, {
      cursor: cur('withdrawals', Date.UTC(2018, 0, 1) + DAY),
    });
    expect(r.records.map((x) => [x.type, x.exchangeRecordId])).toEqual([
      ['withdrawal', 'wd:3301:s5'],
    ]);
    expect((r.records[0].payload as any).amount).toBe('250.00000000');
    expect((r.records[0].payload as any).fee).toBe('0.02000000');
    expect(JSON.parse(r.nextCursor!)).toEqual({
      stream: 'rewards',
      windowEnd: NOW,
    });
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
          status: 1,
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

  it('gives each deposit/withdrawal/order status transition its own record id', async () => {
    const dep = (status: number) =>
      `{"code":0,"result":{"deposit_list":[{"id":"77","currency":"BTC","amount":0.5,"fee":0,"create_time":1693000000000,"status":${status}}]}}`;
    let status = 0;
    const a = hist(makeFetch(() => ({ body: dep(status) })).fn);
    const c = { cursor: cur('deposits', NOW) };
    const pending = await a.fetchHistory(creds, c);
    status = 1;
    const arrived = await a.fetchHistory(creds, c);
    expect(pending.records[0].exchangeRecordId).toBe('dep:77:s0');
    expect(arrived.records[0].exchangeRecordId).toBe('dep:77:s1');

    const ord = (s: string) =>
      ok({
        data: [{ order_id: '5', status: s, create_time: 1693000000000 }],
      });
    let st = 'ACTIVE';
    const o = hist(makeFetch(() => ord(st)).fn);
    const oc = { cursor: cur('orders', NOW) };
    const before = await o.fetchHistory(creds, oc);
    st = 'FILLED';
    const after = await o.fetchHistory(creds, oc);
    expect([
      before.records[0].exchangeRecordId,
      after.records[0].exchangeRecordId,
    ]).toEqual(['order:5:sACTIVE', 'order:5:sFILLED']);
  });

  it('treats a missing or null fee as 0 (not unparsed)', async () => {
    const raw = `{"code":0,"result":{"withdrawal_list":[
      {"id":"1","currency":"CRO","amount":5,"create_time":1693000000000,"status":5},
      {"id":"2","currency":"CRO","amount":6,"fee":null,"create_time":1693000000000,"status":5}]}}`;
    const a = hist(makeFetch(() => ({ body: raw })).fn);
    const r = await a.fetchHistory(creds, { cursor: cur('withdrawals', NOW) });
    expect(r.records.map((x) => x.type)).toEqual(['withdrawal', 'withdrawal']);
    expect(r.records.map((x) => (x.payload as any).fee)).toEqual(['0', '0']);
  });

  describe('staking rewards stream', () => {
    // Docs: https://exchange-developer.crypto.com/exchange/v1/docs/api/rest/private-staking-get-reward-history.md
    // (limit max 500, start_time >= end_time - 180d). The fixture is docs-derived.
    it('maps reward rows with stable ids and ends the whole walk with no cursor', async () => {
      const a = hist(
        makeFetch((c) =>
          c.body.method === 'private/staking/get-reward-history'
            ? { body: fixture('rewards-page.json') }
            : emptyFor(c.body.method),
        ).fn,
      );
      const r = await a.fetchHistory(creds, {
        cursor: cur('rewards', NOW - 170 * DAY),
      });
      expect(r.records.map((x) => [x.type, x.exchangeRecordId])).toEqual([
        ['reward', 'reward:SOL.staked:1693000100000:0.00012345'],
        ['reward', 'reward:CRO.staked:1692990000000:1.5'],
      ]);
      expect(r.records[0].occurredAt).toEqual(new Date(1693000100000));
      expect((r.records[0].payload as any).normalizedAsset).toBe('SOL');
      // window start hit the 180-day floor, last stream: no more cursor
      expect(r.nextCursor).toBeUndefined();
    });

    it('requests 30-day windows with limit 500 and pages order-independently', async () => {
      const rows = Array.from({ length: 700 }, (_, i) => ({
        staking_inst_name: 'SOL.staked',
        reward_inst_name: 'SOL',
        reward_quantity: '1',
        event_timestamp_ms: NOW - 1000 - i * 1000,
      }));
      const { fn, calls } = makeFetch(
        serve(
          'private/staking/get-reward-history',
          rows,
          'event_timestamp_ms',
          500,
          'asc',
        ),
      );
      const { records } = await drain(hist(fn), {});
      const rewards = records.filter((r) => r.type === 'reward');
      expect(new Set(rewards.map((r) => r.exchangeRecordId)).size).toBe(700);
      const first = calls.find(
        (c) => c.body.method === 'private/staking/get-reward-history',
      )!;
      expect(first.body.params).toEqual({
        start_time: NOW - 30 * DAY,
        end_time: NOW,
        limit: 500,
      });
    });

    it('keeps unknown reward shapes as unparsed and rejects an unknown container', async () => {
      const a = hist(
        makeFetch(() =>
          ok({
            data: [{ reward_quantity: 'abc' }, { staking_inst_name: 'X' }],
          }),
        ).fn,
      );
      const r = await a.fetchHistory(creds, { cursor: cur('rewards', NOW) });
      expect(r.records.map((x) => x.type)).toEqual(['unparsed', 'unparsed']);
      const b = hist(makeFetch(() => ok({ weird: 1 })).fn);
      await expect(
        b.fetchHistory(creds, { cursor: cur('rewards', NOW) }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });

    it('treats a rejected (bad request) reward call as an unavailable optional stream', async () => {
      const a = hist(
        makeFetch(() => ({ body: '{"code":40001,"message":"BAD_REQUEST"}' }))
          .fn,
      );
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const r = await a.fetchHistory(creds, { cursor: cur('rewards', NOW) });
        expect(r).toEqual({ records: [] });
        // a second skip for the same key must not warn again
        await a.fetchHistory(creds, { cursor: cur('rewards', NOW) });
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toMatch(/rewards/);
        expect(msg).toMatch(/40001/);
        expect(msg).not.toContain('TEST_KEY');
        expect(msg).not.toContain('TEST_SECRET');
        // a different key warns once for itself
        await a.fetchHistory(
          { apiKey: 'OTHER_KEY', apiSecret: 'OTHER_SECRET' },
          { cursor: cur('rewards', NOW) },
        );
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('pacing across fetchHistory calls', () => {
    it('keeps get-trades >= 1.1 s apart per key even across back-to-back calls', async () => {
      let t = NOW;
      const sent: number[] = [];
      const fn = jest.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        if (body.method === 'private/get-trades') sent.push(t);
        // call A: the third trades request (t0 + 2.2 s) returns a row
        const rows =
          body.method === 'private/get-trades' && sent.length === 3
            ? [{ trade_id: '1', create_time: NOW - 5 }]
            : [];
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, result: { data: rows } }),
        } as any;
      }) as unknown as typeof fetch;
      const a = new CryptoComAdapter(
        fn,
        30_000,
        () => t,
        undefined,
        async (ms) => {
          t += ms;
        },
      );
      const first = await a.fetchHistory(creds, {});
      expect(first.records).toHaveLength(1);
      expect(sent).toEqual([NOW, NOW + 1100, NOW + 2200]);
      // call B starts immediately (the sync service may grant the page at once)
      await a.fetchHistory(creds, { cursor: first.nextCursor });
      expect(sent[3] - sent[2]).toBeGreaterThanOrEqual(1100);
    });

    it('paces per api key independently', async () => {
      let t = NOW;
      const sleptFor: number[] = [];
      const fn = jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, result: { data: [] } }),
      })) as unknown as typeof fetch;
      const a = new CryptoComAdapter(
        fn,
        30_000,
        () => t,
        undefined,
        async (ms) => {
          sleptFor.push(ms);
          t += ms;
        },
      );
      await a.fetchHistory(creds, {
        cursor: cur('trades', NOW),
      });
      sleptFor.length = 0;
      t = NOW;
      await a.fetchHistory(
        { apiKey: 'OTHER_KEY', apiSecret: 'OTHER_SECRET' },
        { cursor: cur('trades', NOW) },
      );
      // the other key's first trades request is not delayed by this key's history
      expect(sleptFor[0]).toBe(1100); // its own 2nd request, not the 1st
      expect(sleptFor.length).toBe(7);
    });
  });

  describe('error mapping and ids', () => {
    const callWith = (status: number, body: string) => {
      const fn = (async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      })) as unknown as typeof fetch;
      return hist(fn).fetchHistory(creds, {});
    };

    it('maps HTTP 401 to an auth error whatever the code or body', async () => {
      await expect(
        callWith(401, '{"code":40001,"message":"x"}'),
      ).rejects.toBeInstanceOf(ExchangeAuthError);
      await expect(callWith(401, '{"foo":1}')).rejects.toBeInstanceOf(
        ExchangeAuthError,
      );
      await expect(callWith(401, 'not json')).rejects.toBeInstanceOf(
        ExchangeAuthError,
      );
    });

    it('maps documented codes: 40104 auth, 50001 retryable, 42901 rate limit', async () => {
      await expect(
        callWith(401, '{"code":40104,"message":"x"}'),
      ).rejects.toBeInstanceOf(ExchangeAuthError);
      const internal: any = await callWith(
        500,
        '{"code":50001,"message":"x"}',
      ).catch((e) => e);
      expect(internal).toBeInstanceOf(ExchangeNetworkError);
      expect(internal.retryable).toBe(true);
      const internal200: any = await callWith(
        200,
        '{"code":50001,"message":"x"}',
      ).catch((e) => e);
      expect(internal200.retryable).toBe(true);
      await expect(
        callWith(429, '{"code":42901,"message":"x"}'),
      ).rejects.toBeInstanceOf(ExchangeRateLimitError);
    });

    it('drains the response body on HTTP 429', async () => {
      const text = jest.fn(async () => '{"code":42901}');
      const fn = (async () => ({
        ok: false,
        status: 429,
        text,
      })) as unknown as typeof fetch;
      await expect(hist(fn).fetchHistory(creds, {})).rejects.toBeInstanceOf(
        ExchangeRateLimitError,
      );
      expect(text).toHaveBeenCalledTimes(1);
    });

    it('never calls private/get-accounts (not an allowed method)', async () => {
      const a = hist(makeFetch(() => ok({})).fn);
      await expect(
        (a as any).call(creds, 'private/get-accounts', {}),
      ).rejects.toThrow(/non-read/);
    });

    it('caps composed record ids for very long exchange ids', async () => {
      const long = 'X'.repeat(100);
      const a = hist(
        makeFetch(() =>
          ok({
            data: [
              {
                order_id: long,
                status: long,
                create_time: 1693000000000,
              },
            ],
          }),
        ).fn,
      );
      const r = await a.fetchHistory(creds, { cursor: cur('orders', NOW) });
      expect(r.records[0].type).toBe('trade');
      expect(r.records[0].exchangeRecordId.length).toBeLessThan(191);
      // stable: the same long id maps to the same record id
      const again = await a.fetchHistory(creds, {
        cursor: cur('orders', NOW),
      });
      expect(again.records[0].exchangeRecordId).toBe(
        r.records[0].exchangeRecordId,
      );
    });

    it('retries the rewards stream on every sync (a skip is not remembered)', async () => {
      const { fn, calls } = makeFetch((c) =>
        c.body.method === 'private/staking/get-reward-history'
          ? { body: '{"code":40001,"message":"BAD_REQUEST"}' }
          : emptyFor(c.body.method),
      );
      const a = hist(fn);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        await drain(a, { since: new Date(NOW - 2 * DAY) });
        await drain(a, { since: new Date(NOW - 1 * DAY) });
        const rewardCalls = calls.filter(
          (c) => c.body.method === 'private/staking/get-reward-history',
        );
        expect(rewardCalls).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
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
