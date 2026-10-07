import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { extractAssetsFromPayload } from '../../sync/extractKnownAssets';
import { MAX_PIONEX_MARKETS, PionexAdapter } from './PionexAdapter';
import { ExchangeRateLimitError, ExchangeSchemaError } from '../errors';

// Fixtures fills-page.json / orders-page.json are SPEC-DERIVED (openapi.yaml @
// 6389067ce33f1aed661317b61202e89c9cd98f54), not probed live (bot-only account).
// The mock server below behaves as the OFFICIAL spec describes: fills returns the
// latest 100 rows in [startTime, endTime] sorted by time descending; allOrders
// returns the latest `limit` (1..200, default 50) rows in the window.

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const FLOOR = Date.UTC(2018, 0, 1);
const T0 = FLOOR + 1000 * DAY; // all synthetic history sits after the 2018 floor
const creds = { apiKey: 'TEST_KEY', apiSecret: 'TEST_SECRET' };

type Sym = {
  symbol: string;
  base: string;
  quote?: string;
  enable?: boolean;
  type?: string;
};
type Sent = { path: string; query: URLSearchParams; at: number };

type Fill = { id: number; ts: number } & Record<string, any>;
const fill = (id: number, ts: number, symbol = 'BTC_USDT'): Fill => ({
  id,
  orderId: 5000 + id,
  symbol,
  side: 'BUY',
  role: 'TAKER',
  price: '30000',
  size: '0.001',
  fee: '0.00000100',
  feeCoin: 'BTC',
  timestamp: ts,
  ts,
});
const order = (
  orderId: number,
  createTime: number,
  status = 'CLOSED',
  symbol = 'BTC_USDT',
  updateTime = createTime,
) => ({
  orderId,
  symbol,
  type: 'LIMIT',
  side: 'BUY',
  price: '30000',
  size: '0.001',
  amount: '',
  filledSize: '0.001',
  filledAmount: '30',
  fee: '0.000001',
  feeCoin: 'BTC',
  status,
  IOC: false,
  clientOrderId: 'TEST_CLIENT',
  source: 'API',
  createTime,
  updateTime,
});

class Server {
  symbols: Sym[] = [
    { symbol: 'BTC_USDT', base: 'BTC' },
    { symbol: 'ETH_USDT', base: 'ETH' },
  ];
  balanceCoins: string[] = ['BTC'];
  fills: Record<string, any[]> = {};
  orders: Record<string, any[]> = {};
  rejected = new Map<string, string>(); // "<path>|<symbol>" or symbol -> code
  exclusiveEnd = false;
  /** Which order time the allOrders window and ordering use (unspecified by the docs). */
  windowMode: 'create' | 'update' = 'create';
  raw: Record<string, string> = {}; // path -> raw body override
  status: Record<string, number> = {};
  sent: Sent[] = [];
  clock: () => number = () => NOW;

  respond = (url: any) => {
    const u = new URL(String(url));
    this.sent.push({
      path: u.pathname,
      query: u.searchParams,
      at: this.clock(),
    });
    const q = u.searchParams;
    const p = u.pathname;
    const env = (data: unknown) => ({
      status: this.status[p] ?? 200,
      body:
        this.raw[p] ?? JSON.stringify({ result: true, data, timestamp: NOW }),
    });
    if (this.status[p] === 429) return { status: 429, body: '{}' };
    if (p === '/api/v1/account/balances') {
      return env({
        balances: this.balanceCoins.map((coin) => ({
          coin,
          free: '1',
          frozen: '0',
        })),
      });
    }
    if (p === '/api/v1/common/symbols') {
      return env({
        symbols: this.symbols.map((s) => ({
          symbol: s.symbol,
          type: s.type ?? 'SPOT',
          baseCurrency: s.base,
          quoteCurrency: s.quote ?? 'USDT',
          enable: s.enable ?? true,
        })),
      });
    }
    const symbol = q.get('symbol') ?? '';
    const code =
      this.rejected.get(`${p}|${symbol}`) ?? this.rejected.get(symbol);
    if (code) {
      return {
        status: 200,
        body: JSON.stringify({ result: false, code, message: 'TEST_KEY' }),
      };
    }
    const start = Number(q.get('startTime'));
    const end = Number(q.get('endTime'));
    const inWin = (t: number) =>
      t >= start && (this.exclusiveEnd ? t < end : t <= end);
    if (p === '/api/v1/trade/fills') {
      const rows = (this.fills[symbol] ?? [])
        .filter((r) => inWin(r.ts ?? r.timestamp))
        .sort((a, b) => (b.ts ?? b.timestamp) - (a.ts ?? a.timestamp))
        .slice(0, 100)
        .map(({ ts: _ts, ...r }) => r);
      return env({ fills: rows });
    }
    if (p === '/api/v1/trade/allOrders') {
      const limit = Number(q.get('limit') ?? 50);
      const f = this.windowMode === 'create' ? 'createTime' : 'updateTime';
      const rows = (this.orders[symbol] ?? [])
        .filter((r) => inWin(r[f]))
        .sort((a, b) => b[f] - a[f])
        .slice(0, limit);
      return env({ orders: rows });
    }
    return env({});
  };

  fetch = (async (url: any) => {
    const r = this.respond(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
    } as any;
  }) as unknown as typeof fetch;

  paths = () => this.sent.map((s) => s.path);
  of = (p: string) => this.sent.filter((s) => s.path === p);
}

const make = (srv: Server, now: () => number = () => NOW) =>
  new PionexAdapter(srv.fetch, 30_000, now, async () => undefined);

/** Runs fetchHistory to completion; every call must respect the request budget. */
async function drain(
  a: PionexAdapter,
  srv: Server,
  q: { since?: Date; knownAssets?: string[] } = { knownAssets: ['BTC'] },
  maxCalls = 200,
) {
  const records: any[] = [];
  let cursor: string | undefined;
  let calls = 0;
  do {
    const before = srv.sent.length;
    const r = await a.fetchHistory(creds, { ...q, cursor });
    expect(srv.sent.length - before).toBeLessThanOrEqual(8);
    records.push(...r.records);
    cursor = r.nextCursor;
    calls++;
  } while (cursor && calls < maxCalls);
  expect(cursor).toBeUndefined();
  return { records, calls };
}
const ids = (rs: any[]) => rs.map((r) => r.exchangeRecordId);

describe('PionexAdapter.fetchHistory', () => {
  describe('market enumeration', () => {
    it('walks enabled SPOT markets of known assets only (disabled, non-spot and coin-without-market skipped)', async () => {
      const srv = new Server();
      srv.symbols = [
        { symbol: 'BTC_USDT', base: 'BTC' },
        { symbol: 'BTC_ETH', base: 'BTC', quote: 'ETH' },
        { symbol: 'ETH_USDT', base: 'ETH', enable: false },
        { symbol: 'SOL_USDT', base: 'SOL' }, // not known
        { symbol: 'DOGE.PERP_USDT', base: 'DOGE', type: 'PERP' },
        { symbol: 'xDOGE_USDT', base: 'DOGE' }, // verbatim symbol, base DOGE
        { symbol: 'BAD SYMBOL', base: 'BTC' }, // unsafe, skipped
      ];
      const a = make(srv);
      const { records } = await drain(a, srv, {
        knownAssets: ['btc', 'ETH', 'DOGE', 'NOMARKET'],
      });
      expect(records).toEqual([]);
      const syms = [
        ...new Set(
          srv.of('/api/v1/trade/fills').map((s) => s.query.get('symbol')),
        ),
      ];
      // USDT quote first, then other quotes; symbol used verbatim
      expect(syms).toEqual(['BTC_USDT', 'xDOGE_USDT', 'BTC_ETH']);
      expect(srv.of('/api/v1/account/balances')).toHaveLength(0);
      expect(srv.of('/api/v1/common/symbols')).toHaveLength(1);
    });

    it('uses current non-zero balances once when the caller has no known assets', async () => {
      const srv = new Server();
      srv.balanceCoins = ['BTC'];
      const a = make(srv);
      await drain(a, srv, {});
      expect(srv.of('/api/v1/account/balances')).toHaveLength(1);
      expect(srv.of('/api/v1/common/symbols')).toHaveLength(1);
      expect([
        ...new Set(
          srv.of('/api/v1/trade/fills').map((s) => s.query.get('symbol')),
        ),
      ]).toEqual(['BTC_USDT']);
    });

    it('returns no records and no cursor when no asset has a market', async () => {
      const srv = new Server();
      const a = make(srv);
      expect(
        await a.fetchHistory(creds, { knownAssets: ['NOMARKET'] }),
      ).toEqual({
        records: [],
      });
      expect(srv.of('/api/v1/trade/fills')).toHaveLength(0);
      const empty = new Server();
      empty.balanceCoins = [];
      expect(await make(empty).fetchHistory(creds, {})).toEqual({
        records: [],
      });
      expect(empty.of('/api/v1/common/symbols')).toHaveLength(0);
    });

    it('covers up to the cap, continues across calls through the cursor and warns once about the markets it cannot cover', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const srv = new Server();
      srv.symbols = Array.from({ length: 350 }, (_, i) => ({
        symbol: `C${String(i).padStart(3, '0')}_USDT`,
        base: `C${String(i).padStart(3, '0')}`,
      }));
      const known = srv.symbols.map((s) => s.base);
      const a = make(srv);
      const first = await a.fetchHistory(creds, { knownAssets: known });
      expect(first.nextCursor).toBeDefined();
      expect(first.nextCursor!.length).toBeLessThan(16_384);
      const { calls } = await drain(a, srv, { knownAssets: known });
      expect(calls).toBeGreaterThan(5);
      const walked = new Set(
        srv.of('/api/v1/trade/fills').map((s) => s.query.get('symbol')),
      );
      expect(MAX_PIONEX_MARKETS).toBe(300);
      expect(walked.size).toBe(MAX_PIONEX_MARKETS);
      // discovery happened once per run (two runs here)
      expect(srv.of('/api/v1/common/symbols')).toHaveLength(2);
      const msgs = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('not covered'));
      expect(msgs).toEqual([
        'Pionex history: 50 of 350 markets are not covered (limit 300 per run)',
      ]);
      warn.mockRestore();
    }, 120_000);

    it('a full-size cursor (300 symbols of 40 characters) fits and validates', async () => {
      const srv = new Server();
      const symbols = Array.from(
        { length: MAX_PIONEX_MARKETS },
        (_, i) => `${'A'.repeat(33)}${String(i).padStart(3, '0')}_US`,
      );
      expect(symbols.every((x) => x.length <= 40)).toBe(true);
      const cursor = JSON.stringify({
        phase: 'fills',
        symbolIndex: 0,
        endTime: NOW,
        start: FLOOR,
        symbols,
      });
      expect(cursor.length).toBeLessThan(16_384);
      const r = await make(srv).fetchHistory(creds, { cursor });
      expect(r.nextCursor!.length).toBeLessThan(16_384);
    });

    it('includes a coin only seen in stored fill payloads (knownAssets extractor)', async () => {
      const first = new Server();
      first.symbols = [
        { symbol: 'SOL_USDT', base: 'SOL' },
        { symbol: 'BTC_USDT', base: 'BTC' },
      ];
      first.fills['SOL_USDT'] = [fill(1, T0 + 1000, 'SOL_USDT')];
      const { records } = await drain(make(first), first, {
        knownAssets: ['SOL'],
      });
      expect(ids(records)).toEqual(['fill:1']);
      const found = new Set<string>();
      for (const r of records) extractAssetsFromPayload(r.payload, found);
      expect([...found].sort()).toEqual(['BTC', 'SOL']);
      // a later sync, with SOL no longer held, still walks SOL_USDT
      const next = new Server();
      next.symbols = first.symbols;
      await drain(make(next), next, { knownAssets: [...found] });
      expect(
        new Set(
          next.of('/api/v1/trade/fills').map((s) => s.query.get('symbol')),
        ),
      ).toEqual(new Set(['SOL_USDT', 'BTC_USDT']));
    });
  });

  describe('fills walk', () => {
    const walk = async (rows: Fill[], exclusiveEnd = false) => {
      const srv = new Server();
      srv.fills['BTC_USDT'] = rows;
      srv.exclusiveEnd = exclusiveEnd;
      const { records } = await drain(make(srv), srv);
      return { srv, records };
    };

    it('maps a fill (exact strings, big integer ids exact, payload marker)', async () => {
      const srv = new Server();
      srv.raw['/api/v1/trade/fills'] = fixture('fills-page.json');
      const { records } = await drain(make(srv), srv);
      const fills = records.filter((r) =>
        r.exchangeRecordId.startsWith('fill:'),
      );
      expect(ids(fills)).toEqual([
        'fill:9007199254740993',
        'fill:9007199254740992',
      ]);
      expect(fills[0]).toMatchObject({
        type: 'trade',
        occurredAt: new Date(1700000002000),
        payload: {
          _source: 'fills',
          price: '30500.10',
          size: '0.00200000',
          fee: '0.12200040',
          orderId: '770000000000002',
        },
      });
    });

    it('keeps a JSON-number amount exact', async () => {
      const srv = new Server();
      srv.raw['/api/v1/trade/fills'] =
        '{"result":true,"data":{"fills":[{"id":7,"orderId":8,"symbol":"BTC_USDT","side":"BUY","role":"MAKER","price":0.1000000000000000055,"size":1.10,"fee":0,"feeCoin":"USDT","timestamp":1700000000000}]}}';
      const { records } = await drain(make(srv), srv);
      expect(records[0].payload).toMatchObject({
        price: '0.1000000000000000055',
        size: '1.10',
        fee: '0',
      });
    });

    it('exactly 100 rows: re-requests once and loses nothing', async () => {
      const rows = Array.from({ length: 100 }, (_, i) =>
        fill(i + 1, T0 + 1000 + i * 10),
      );
      const { srv, records } = await walk(rows);
      expect(new Set(ids(records)).size).toBe(100);
      expect(records).toHaveLength(100);
      expect(srv.of('/api/v1/trade/fills')).toHaveLength(2);
    });

    it('250 rows across timestamps: none lost, none duplicated (inclusive and exclusive endTime)', async () => {
      const rows = Array.from({ length: 250 }, (_, i) =>
        fill(i + 1, T0 + 1000 + i * 10),
      );
      for (const exclusive of [false, true]) {
        const { records } = await walk(rows, exclusive);
        expect(records).toHaveLength(250);
        expect(new Set(ids(records)).size).toBe(250);
      }
    });

    it('250 rows with timestamp ties that do not exceed a page: none lost', async () => {
      // five rows share each millisecond
      const rows = Array.from({ length: 250 }, (_, i) =>
        fill(i + 1, T0 + 1000 + Math.floor(i / 5) * 10),
      );
      const { records } = await walk(rows);
      expect(new Set(ids(records)).size).toBe(250);
    });

    it('does not rely on response order', async () => {
      const srv = new Server();
      const rows = Array.from({ length: 250 }, (_, i) =>
        fill(i + 1, T0 + 1000 + i * 10),
      );
      srv.fills['BTC_USDT'] = rows;
      const base = srv.respond;
      srv.respond = (url: any) => {
        const r = base(url);
        if (new URL(String(url)).pathname !== '/api/v1/trade/fills') return r;
        const j = JSON.parse(r.body);
        j.data.fills.reverse(); // ascending
        return { ...r, body: JSON.stringify(j) };
      };
      const { records } = await drain(make(srv), srv);
      expect(new Set(ids(records)).size).toBe(250);
    });

    it('a full page of identical timestamps terminates', async () => {
      const rows = Array.from({ length: 100 }, (_, i) =>
        fill(i + 1, T0 + 5000),
      );
      const { srv, records } = await walk(rows);
      expect(records).toHaveLength(100);
      // inclusive mock: page 1 full, then the same page again twice (endTime
      // oldest+1, then oldest), then an empty page at oldest-1: terminates
      expect(srv.of('/api/v1/trade/fills')).toHaveLength(4);
    });

    it('a window with no rows costs one request per phase and covers every market', async () => {
      const srv = new Server();
      const a = make(srv);
      const r = await a.fetchHistory(creds, { knownAssets: ['BTC', 'ETH'] });
      expect(r).toEqual({ records: [] });
      expect(srv.paths()).toEqual([
        '/api/v1/common/symbols',
        '/api/v1/trade/fills',
        '/api/v1/trade/allOrders',
        '/api/v1/trade/fills',
        '/api/v1/trade/allOrders',
      ]);
    });
    it('a same-millisecond group straddling the 100th row loses nothing (inclusive and exclusive endTime)', async () => {
      // 80 newest unique rows, 30 rows at ONE ms (the 100th row is inside the
      // group), then 40 older rows
      const rows = [
        ...Array.from({ length: 80 }, (_, i) => fill(i + 1, T0 + 10_000 + i)),
        ...Array.from({ length: 30 }, (_, i) => fill(100 + i, T0 + 5_000)),
        ...Array.from({ length: 40 }, (_, i) => fill(200 + i, T0 + 1_000 + i)),
      ];
      for (const exclusive of [false, true]) {
        const { records } = await walk(rows, exclusive);
        expect(new Set(ids(records)).size).toBe(150);
      }
    });

    it('warns once per key when a full page makes no progress', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const rows = Array.from({ length: 100 }, (_, i) =>
        fill(i + 1, T0 + 5000),
      );
      const srv = new Server();
      srv.fills['BTC_USDT'] = rows;
      const a = make(srv);
      await drain(a, srv);
      await drain(a, srv);
      const msgs = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('no progress'));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).not.toContain('TEST_KEY');
      warn.mockRestore();
    });
  });

  describe('orders', () => {
    it('maps orders with the status in the id and keeps both statuses of one order', async () => {
      const srv = new Server();
      srv.raw['/api/v1/trade/allOrders'] = fixture('orders-page.json');
      const { records } = await drain(make(srv), srv);
      expect(ids(records)).toEqual([
        'order:770000000000003:sCLOSED',
        'order:770000000000004:sOPEN',
      ]);
      expect(records[0]).toMatchObject({
        type: 'trade',
        occurredAt: new Date(1700000001600),
        payload: {
          _source: 'order-history',
          amount: '100',
          filledAmount: '99.99',
        },
      });

      const first = new Server();
      first.orders['BTC_USDT'] = [order(42, T0 + 1000, 'OPEN')];
      const second = new Server();
      second.orders['BTC_USDT'] = [
        order(42, T0 + 1000, 'CLOSED', 'BTC_USDT', T0 + 2000),
      ];
      const one = await drain(make(first), first);
      const two = await drain(make(second), second);
      expect(ids(one.records)).toEqual(['order:42:sOPEN']);
      expect(ids(two.records)).toEqual(['order:42:sCLOSED']);
    });

    it('pages allOrders with limit=200 without losing rows', async () => {
      const srv = new Server();
      srv.orders['BTC_USDT'] = Array.from({ length: 450 }, (_, i) =>
        order(i + 1, T0 + 1000 + i * 10),
      );
      const { records } = await drain(make(srv), srv);
      expect(new Set(ids(records)).size).toBe(450);
      const reqs = srv.of('/api/v1/trade/allOrders');
      expect(reqs.length).toBeGreaterThanOrEqual(3);
      expect(reqs.every((r) => r.query.get('limit') === '200')).toBe(true);
    });

    it.each([
      ['create', false],
      ['create', true],
      ['update', false],
      ['update', true],
    ] as const)(
      'pages allOrders without loss when the API windows by %s time (exclusive endTime: %s)',
      async (mode, exclusive) => {
        const srv = new Server();
        srv.windowMode = mode;
        srv.exclusiveEnd = exclusive;
        // updateTime >= createTime, with a different order for each time
        srv.orders['BTC_USDT'] = Array.from({ length: 450 }, (_, i) =>
          order(
            i + 1,
            T0 + 1000 + i * 10,
            'CLOSED',
            'BTC_USDT',
            T0 + 1000 + i * 10 + ((i * 7) % 13) * 1000,
          ),
        );
        const { records } = await drain(make(srv), srv);
        expect(new Set(ids(records)).size).toBe(450);
      },
    );

    it.each(['create', 'update'] as const)(
      'an order group sharing one %s millisecond across the page edge loses nothing (exclusive endTime)',
      async (mode) => {
        const srv = new Server();
        srv.windowMode = mode;
        srv.exclusiveEnd = true;
        srv.orders['BTC_USDT'] = [
          ...Array.from({ length: 150 }, (_, i) =>
            order(
              i + 1,
              T0 + 10_000 + i,
              'CLOSED',
              'BTC_USDT',
              T0 + 10_000 + i,
            ),
          ),
          ...Array.from({ length: 80 }, (_, i) =>
            order(500 + i, T0 + 5_000, 'CLOSED', 'BTC_USDT', T0 + 5_000),
          ),
          ...Array.from({ length: 20 }, (_, i) =>
            order(
              900 + i,
              T0 + 1_000 + i,
              'CLOSED',
              'BTC_USDT',
              T0 + 1_000 + i,
            ),
          ),
        ];
        const { records } = await drain(make(srv), srv);
        expect(new Set(ids(records)).size).toBe(250);
      },
    );

    it('terminates quickly when updateTime is far after createTime under createTime windows', async () => {
      for (const exclusive of [false, true]) {
        const srv = new Server();
        srv.windowMode = 'create';
        srv.exclusiveEnd = exclusive;
        srv.orders['BTC_USDT'] = Array.from({ length: 250 }, (_, i) =>
          order(i + 1, T0 + 1000 + i * 10, 'CLOSED', 'BTC_USDT', NOW - 5),
        );
        const { records } = await drain(make(srv), srv);
        expect(new Set(ids(records)).size).toBe(250);
        expect(srv.of('/api/v1/trade/allOrders').length).toBeLessThan(10);
      }
    });

    it('long ids are shortened with a hash and stay under 191 characters', async () => {
      const srv = new Server();
      srv.raw['/api/v1/trade/allOrders'] = JSON.stringify({
        result: true,
        data: {
          orders: [{ ...order(1, T0 + 1000), orderId: 'x'.repeat(500) }],
        },
      });
      const { records } = await drain(make(srv), srv);
      expect(records[0].exchangeRecordId.length).toBeLessThan(191);
      expect(records[0].exchangeRecordId).toMatch(
        /^order:x{40}~[0-9a-f]{16}:sCLOSED$/,
      );
    });
  });

  describe('cursor', () => {
    it('round-trips: resuming from nextCursor yields the same records as one drain', async () => {
      const mk = () => {
        const srv = new Server();
        srv.fills['BTC_USDT'] = Array.from({ length: 700 }, (_, i) =>
          fill(i + 1, T0 + 1000 + i * 10),
        );
        return srv;
      };
      const srv = mk();
      const first = await make(srv).fetchHistory(creds, {
        knownAssets: ['BTC'],
      });
      expect(srv.sent.length).toBe(8);
      const cur = JSON.parse(first.nextCursor!);
      expect(Object.keys(cur).sort()).toEqual([
        'endTime',
        'phase',
        'start',
        'symbolIndex',
        'symbols',
      ]);
      expect(cur).toMatchObject({
        phase: 'fills',
        symbolIndex: 0,
        symbols: ['BTC_USDT'],
      });
      const rest = await drain(make(srv), srv, { knownAssets: ['BTC'] });
      const fresh = mk();
      const all = await drain(make(fresh), fresh);
      const union = new Set([...ids(first.records), ...ids(rest.records)]);
      expect(union.size).toBe(700);
      // resuming re-reads at most the boundary row; ids dedupe at insert
      expect(new Set(ids(all.records))).toEqual(union);
    });

    it('rejects malformed or oversize cursors with ExchangeSchemaError and makes no request', async () => {
      const srv = new Server();
      const a = make(srv);
      const good = {
        phase: 'fills',
        symbolIndex: 0,
        endTime: NOW,
        start: FLOOR,
        symbols: ['BTC_USDT'],
      };
      const bad = [
        'not json',
        '[]',
        'null',
        JSON.stringify({ ...good, phase: 'deposits' }),
        JSON.stringify({ ...good, symbolIndex: 1 }),
        JSON.stringify({ ...good, symbolIndex: -1 }),
        JSON.stringify({ ...good, endTime: 'x' }),
        JSON.stringify({ ...good, endTime: 0 }),
        JSON.stringify({ ...good, start: 1 }),
        JSON.stringify({ ...good, symbols: [] }),
        JSON.stringify({ ...good, symbols: ['A&B=1'] }),
        JSON.stringify({ ...good, symbols: [5] }),
        JSON.stringify({
          ...good,
          symbols: Array.from(
            { length: MAX_PIONEX_MARKETS + 1 },
            (_, i) => `A${i}_USDT`,
          ),
        }),
        JSON.stringify({ ...good, symbols: ['A'.repeat(41)] }),
        JSON.stringify({ ...good, pad: 'x'.repeat(17000) }),
      ];
      for (const cursor of bad) {
        await expect(
          a.fetchHistory(creds, { cursor, knownAssets: ['BTC'] }),
        ).rejects.toBeInstanceOf(ExchangeSchemaError);
      }
      expect(srv.sent).toHaveLength(0);
      // the good one works
      await expect(
        a.fetchHistory(creds, { cursor: JSON.stringify(good) }),
      ).resolves.toEqual({ records: [] });
    });
  });

  describe('lower bound', () => {
    it('starts one day before since, floored at 2018-01-01', async () => {
      const since = new Date(NOW - 10 * DAY);
      const srv = new Server();
      await make(srv).fetchHistory(creds, { since, knownAssets: ['BTC'] });
      for (const s of [...srv.of('/api/v1/trade/fills')]) {
        expect(s.query.get('startTime')).toBe(String(since.getTime() - DAY));
        expect(s.query.get('endTime')).toBe(String(NOW));
      }
      const none = new Server();
      await make(none).fetchHistory(creds, { knownAssets: ['BTC'] });
      expect(none.of('/api/v1/trade/fills')[0].query.get('startTime')).toBe(
        String(FLOOR),
      );
      const old = new Server();
      await make(old).fetchHistory(creds, {
        since: new Date(Date.UTC(2010, 0, 1)),
        knownAssets: ['BTC'],
      });
      expect(old.of('/api/v1/trade/fills')[0].query.get('startTime')).toBe(
        String(FLOOR),
      );
    });

    it('stops walking at the lower bound', async () => {
      const srv = new Server();
      const since = new Date(NOW - 2 * DAY);
      srv.fills['BTC_USDT'] = [
        fill(1, NOW - 100),
        fill(2, since.getTime() - DAY - 1), // older than the bound: never requested
      ];
      const { records } = await drain(make(srv), srv, {
        since,
        knownAssets: ['BTC'],
      });
      expect(ids(records)).toEqual(['fill:1']);
    });
  });

  describe('requests', () => {
    it('only allow-listed read paths with exactly the documented parameters', async () => {
      const srv = new Server();
      srv.fills['BTC_USDT'] = Array.from({ length: 150 }, (_, i) =>
        fill(i + 1, T0 + 1000 + i),
      );
      srv.orders['BTC_USDT'] = [order(1, T0 + 1000)];
      await drain(make(srv), srv, {});
      const allowed = new Set([
        '/api/v1/account/balances',
        '/api/v1/common/symbols',
        '/api/v1/trade/fills',
        '/api/v1/trade/allOrders',
      ]);
      expect(srv.sent.every((s) => allowed.has(s.path))).toBe(true);
      const keys = (p: string) =>
        srv.of(p).map((s) => [...s.query.keys()].sort().join(','));
      expect(new Set(keys('/api/v1/trade/fills'))).toEqual(
        new Set(['endTime,startTime,symbol,timestamp']),
      );
      expect(new Set(keys('/api/v1/trade/allOrders'))).toEqual(
        new Set(['endTime,limit,startTime,symbol,timestamp']),
      );
      expect(new Set(keys('/api/v1/common/symbols'))).toEqual(
        new Set(['timestamp']),
      );
    });
  });

  describe('rejected markets', () => {
    it.each(['TRADE_INVALID_SYMBOL', 'TRADE_PARAMETER_ERROR'])(
      'skips a market the API rejects (%s) without failing the sync or tripping the cool-down',
      async (code) => {
        const srv = new Server();
        srv.symbols = [
          { symbol: 'BTC_USDT', base: 'BTC' },
          { symbol: 'ETH_USDT', base: 'ETH' },
        ];
        srv.rejected.set('BTC_USDT', code);
        srv.fills['ETH_USDT'] = [fill(9, T0 + 2000, 'ETH_USDT')];
        const a = make(srv);
        const { records } = await drain(a, srv, {
          knownAssets: ['BTC', 'ETH'],
        });
        expect(ids(records)).toEqual(['fill:9']);
        // BTC_USDT was dropped after its first rejected request (no orders request)
        expect(
          srv.of('/api/v1/trade/allOrders').map((s) => s.query.get('symbol')),
        ).toEqual(['ETH_USDT']);
        // not rate limited: the very next call goes straight through
        const before = srv.sent.length;
        await expect(
          a.fetchHistory(creds, { knownAssets: ['ETH'] }),
        ).resolves.toBeDefined();
        expect(srv.sent.length).toBeGreaterThan(before);
      },
    );

    it('warns once per key and symbol about a skipped market (symbol and code only)', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const srv = new Server();
      srv.rejected.set('BTC_USDT', 'TRADE_INVALID_SYMBOL');
      const a = make(srv);
      await drain(a, srv);
      await drain(a, srv);
      const msgs = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('skipped'));
      expect(msgs).toEqual([
        'Pionex history: market BTC_USDT skipped (TRADE_INVALID_SYMBOL)',
      ]);
      warn.mockRestore();
    });

    it('skips a market rejected only in the orders phase and keeps its fills', async () => {
      const srv = new Server();
      srv.fills['BTC_USDT'] = [fill(1, T0 + 2000)];
      srv.rejected.set(
        '/api/v1/trade/allOrders|BTC_USDT',
        'TRADE_INVALID_SYMBOL',
      );
      const { records } = await drain(make(srv), srv);
      expect(ids(records)).toEqual(['fill:1']);
    });

    it('other errors still fail the call', async () => {
      const srv = new Server();
      srv.rejected.set('BTC_USDT', 'INVALID_APIKEY');
      await expect(
        make(srv).fetchHistory(creds, { knownAssets: ['BTC'] }),
      ).rejects.toMatchObject({ name: 'ExchangeAuthError' });
    });
  });

  describe('unknown shapes', () => {
    it('keeps odd rows as unparsed with a content-hash id and never throws', async () => {
      const srv = new Server();
      const good = fill(1, T0 + 2000);
      srv.raw['/api/v1/trade/fills'] = JSON.stringify({
        result: true,
        data: {
          fills: [
            { ...good, ts: undefined },
            { ...fill(2, T0 + 1900), role: 'WEIRD' },
            { ...fill(3, T0 + 1800), price: 'abc' },
            { symbol: 'BTC_USDT' },
            'junk',
            null,
          ],
        },
      });
      srv.raw['/api/v1/trade/allOrders'] = JSON.stringify({
        result: true,
        data: {
          orders: [
            order(10, T0 + 1000, 'CLOSED'),
            order(11, T0 + 1000, 'PARTIALLY_FILLED'),
            { orderId: 12 },
          ],
        },
      });
      const a = make(srv);
      const { records } = await drain(a, srv);
      const unparsed = records.filter((r) => r.type === 'unparsed');
      expect(unparsed.length).toBe(7);
      expect(
        unparsed.every((r) =>
          /^unparsed:pionex-(fills|order-history):[0-9a-f]{32}$/.test(
            r.exchangeRecordId,
          ),
        ),
      ).toBe(true);
      expect(ids(records.filter((r) => r.type === 'trade'))).toEqual([
        'fill:1',
        'order:10:sCLOSED',
      ]);
      // deterministic: same rows give the same ids
      const again = await drain(make(srv), srv);
      expect(ids(again.records)).toEqual(ids(records));
    });

    it('throws ExchangeSchemaError when the data array is missing or not an array', async () => {
      const srv = new Server();
      srv.raw['/api/v1/trade/fills'] = '{"result":true,"data":{"fills":"x"}}';
      await expect(
        make(srv).fetchHistory(creds, { knownAssets: ['BTC'] }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
      const s2 = new Server();
      s2.raw['/api/v1/common/symbols'] = '{"result":true,"data":{}}';
      await expect(
        make(s2).fetchHistory(creds, { knownAssets: ['BTC'] }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });
  });

  describe('rate handling', () => {
    it('never sends two weight-5 calls closer than 600 ms for one key across fetchHistory calls', async () => {
      let t = NOW;
      const srv = new Server();
      srv.clock = () => t;
      srv.symbols = [
        { symbol: 'BTC_USDT', base: 'BTC' },
        { symbol: 'ETH_USDT', base: 'ETH' },
        { symbol: 'SOL_USDT', base: 'SOL' },
      ];
      for (const s of ['BTC_USDT', 'ETH_USDT', 'SOL_USDT']) {
        srv.fills[s] = Array.from({ length: 130 }, (_, i) =>
          fill(i + 1, T0 + 1000 + i, s),
        );
        srv.orders[s] = [order(1, T0 + 1000, 'CLOSED', s)];
      }
      const a = new PionexAdapter(
        srv.fetch,
        30_000,
        () => t,
        async (ms) => {
          t += ms;
        },
      );
      const known = ['BTC', 'ETH', 'SOL'];
      let cursor: string | undefined;
      let n = 0;
      do {
        const r = await a.fetchHistory(creds, { knownAssets: known, cursor });
        cursor = r.nextCursor;
        n++;
      } while (cursor && n < 50);
      const heavy = srv.sent.filter((s) =>
        [
          '/api/v1/trade/fills',
          '/api/v1/trade/allOrders',
          '/api/v1/common/symbols',
        ].includes(s.path),
      );
      expect(heavy.length).toBeGreaterThan(6);
      for (let i = 1; i < heavy.length; i++) {
        expect(heavy[i].at - heavy[i - 1].at).toBeGreaterThanOrEqual(600);
      }
      expect(n).toBeGreaterThan(1);
    });

    it('a 429 mid-walk surfaces ExchangeRateLimitError, keeps the cursor usable and enforces the cool-down', async () => {
      let t = NOW;
      const srv = new Server();
      srv.clock = () => t;
      srv.fills['BTC_USDT'] = Array.from({ length: 300 }, (_, i) =>
        fill(i + 1, T0 + 1000 + i),
      );
      const a = new PionexAdapter(
        srv.fetch,
        30_000,
        () => t,
        async (ms) => {
          t += ms;
        },
      );
      const first = await a.fetchHistory(creds, { knownAssets: ['BTC'] });
      const cursor =
        first.nextCursor ??
        JSON.stringify({
          phase: 'fills',
          symbolIndex: 0,
          endTime: NOW,
          start: FLOOR,
          symbols: ['BTC_USDT'],
        });
      const frozen = cursor;
      srv.status['/api/v1/trade/fills'] = 429;
      await expect(
        a.fetchHistory(creds, { cursor, knownAssets: ['BTC'] }),
      ).rejects.toBeInstanceOf(ExchangeRateLimitError);
      const count = srv.sent.length;
      await expect(
        a.fetchHistory(creds, { cursor, knownAssets: ['BTC'] }),
      ).rejects.toMatchObject({ retryAfterMs: expect.any(Number) });
      expect(srv.sent.length).toBe(count); // no request inside the cool-down
      expect(cursor).toBe(frozen);
      // after the ban the same cursor resumes
      t += 61_000;
      delete srv.status['/api/v1/trade/fills'];
      const resumed = await a.fetchHistory(creds, {
        cursor,
        knownAssets: ['BTC'],
      });
      expect(resumed.records.length).toBeGreaterThan(0);
    });
  });
});
