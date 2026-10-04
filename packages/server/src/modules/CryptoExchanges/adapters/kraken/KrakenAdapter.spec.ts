import * as fs from 'fs';
import * as path from 'path';
import { KrakenAdapter } from './KrakenAdapter';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');

// Public example secret from the Kraken docs; not a real credential.
const SECRET =
  'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
const creds = { apiKey: '  TESTKEY123  ', apiSecret: `  ${SECRET}\n` };

type Call = { url: string; init: any };

function makeFetch(responder: (call: Call, n: number) => any) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: any, init: any) => {
    const call = { url: String(url), init };
    calls.push(call);
    const r = responder(call, calls.length);
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      text: async () => r.body,
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const ok = (body: string) => ({ body });
const nonceOf = (c: Call) => BigInt(/nonce=(\d+)/.exec(c.init.body)![1]);

describe('KrakenAdapter', () => {
  it('exposes id and rate limit', () => {
    const a = new KrakenAdapter(makeFetch(() => ok('{}')).fn);
    expect(a.id).toBe('kraken');
    expect(a.rateLimit.capacity).toBeGreaterThan(0);
    expect(a.rateLimit.refillPerSec).toBeGreaterThan(0);
  });

  it('trims credentials and sends them only in headers/body, to the fixed host', async () => {
    const { fn, calls } = makeFetch(() => ok(fixture('balance.json')));
    await new KrakenAdapter(fn).fetchBalances(creds);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.kraken.com/0/private/Balance');
    expect(init.method).toBe('POST');
    expect(init.headers['API-Key']).toBe('TESTKEY123');
    expect(init.headers['API-Sign']).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(init.body).toMatch(/^nonce=\d+$/);
    expect(url).not.toContain('TESTKEY123');
  });

  it('fetchBalances normalizes assets, puts staked into locked, drops zeros', async () => {
    const { fn } = makeFetch(() => ok(fixture('balance.json')));
    const balances = await new KrakenAdapter(fn).fetchBalances(creds);
    const by = Object.fromEntries(balances.map((b) => [b.asset, b]));
    expect(by.BTC).toEqual({
      asset: 'BTC',
      free: '1011.19088779',
      locked: '0',
    });
    expect(by.ETH.free).toBe('818.55');
    expect(by.USD.free).toBe('171288.6158');
    expect(by.USDT.free).toBe('500000');
    expect(by.DOT).toEqual({ asset: 'DOT', free: '2.5', locked: '1.5' });
    expect(by.ETH2).toEqual({ asset: 'ETH2', free: '0', locked: '198.39708' });
    expect(by.EUR).toBeUndefined();
    expect(balances.every((b) => b.free !== '0' || b.locked !== '0')).toBe(
      true,
    );
  });

  it('inspectKey reports read-only when only query permissions are present', async () => {
    const { fn, calls } = makeFetch(() => ok(fixture('api-key-info.json')));
    const r = await new KrakenAdapter(fn).inspectKey(creds);
    expect(calls[0].url).toBe('https://api.kraken.com/0/private/GetApiKeyInfo');
    expect(r.readOnly).toBe(true);
    expect(r.permissions).toEqual([
      'query-funds',
      'query-open-trades',
      'query-closed-trades',
      'query-ledger',
    ]);
  });

  it('inspectKey reports not read-only when trading/withdraw permissions exist', async () => {
    const body = JSON.parse(fixture('api-key-info.json'));
    body.result.permissions.push('withdraw-funds', 'modify-trades');
    const { fn } = makeFetch(() => ok(JSON.stringify(body)));
    const r = await new KrakenAdapter(fn).inspectKey(creds);
    expect(r.readOnly).toBe(false);
    expect(r.permissions).toEqual(
      expect.arrayContaining(['withdraw-funds', 'modify-trades']),
    );
  });

  it('inspectKey falls back to unverifiable on a malformed permissions field', async () => {
    const { fn } = makeFetch(() =>
      ok(JSON.stringify({ error: [], result: { permissions: 'nope' } })),
    );
    const r = await new KrakenAdapter(fn).inspectKey(creds);
    expect(r).toEqual({ readOnly: 'unverifiable', permissions: [] });
  });

  describe('fetchHistory', () => {
    it('maps trades and returns a cursor until exhausted', async () => {
      const big = JSON.parse(fixture('trades-history.json'));
      big.result.count = 51; // more pages remain
      const { fn, calls } = makeFetch(() => ok(JSON.stringify(big)));
      const a = new KrakenAdapter(fn);
      const page1 = await a.fetchHistory(creds, {});
      expect(calls[0].url).toBe(
        'https://api.kraken.com/0/private/TradesHistory',
      );
      expect(calls[0].init.body).toContain('ofs=0');
      expect(page1.records).toHaveLength(2);
      expect(page1.records[0]).toMatchObject({
        type: 'trade',
        exchangeRecordId: 'THVRQM-33VKH-UCI7BS',
      });
      expect(page1.records[0].occurredAt).toEqual(new Date(1688667796880));
      expect((page1.records[0].payload as any).pair).toBe('XXBTZUSD');
      expect(page1.nextCursor).toBeDefined();

      await a.fetchHistory(creds, { cursor: page1.nextCursor });
      expect(calls[1].init.body).toContain('ofs=2');
    });

    it('moves from trades to ledgers, then ends with no cursor', async () => {
      const { fn, calls } = makeFetch((c) =>
        ok(
          c.url.endsWith('TradesHistory')
            ? fixture('trades-history.json')
            : fixture('ledgers.json'),
        ),
      );
      const a = new KrakenAdapter(fn);
      const p1 = await a.fetchHistory(creds, {});
      expect(p1.nextCursor).toBeDefined();
      const p2 = await a.fetchHistory(creds, { cursor: p1.nextCursor });
      expect(calls[1].url).toBe('https://api.kraken.com/0/private/Ledgers');
      expect(p2.nextCursor).toBeUndefined();

      const byId = Object.fromEntries(
        p2.records.map((r) => [r.exchangeRecordId, r]),
      );
      expect(byId['LDEP01-AAAAA-BBBBB1'].type).toBe('deposit');
      expect(byId['LWDR01-AAAAA-BBBBB2'].type).toBe('withdrawal');
      expect(byId['LWDR01-AAAAA-BBBBB2:fee'].type).toBe('fee');
      expect(byId['LSTK01-AAAAA-BBBBB3'].type).toBe('reward');
      expect((byId['LSTK01-AAAAA-BBBBB3'].payload as any).normalizedAsset).toBe(
        'DOT',
      );
      // trade ledger rows duplicate TradesHistory; internal transfers have no record type
      expect(byId['L4UESK-KG3EQ-UFO4T5']).toBeUndefined();
      expect(byId['LXFR01-AAAAA-BBBBB4']).toBeUndefined();
      expect(byId['LDEP01-AAAAA-BBBBB1:fee']).toBeUndefined();
    });

    it('passes since as start (seconds) on the first call', async () => {
      const { fn, calls } = makeFetch(() => ok(fixture('trades-history.json')));
      await new KrakenAdapter(fn).fetchHistory(creds, {
        since: new Date(1688667000000),
      });
      expect(calls[0].init.body).toMatch(/start=1688666999/);
    });

    it('rejects a malformed cursor', async () => {
      const { fn } = makeFetch(() => ok('{}'));
      await expect(
        new KrakenAdapter(fn).fetchHistory(creds, { cursor: 'bogus' }),
      ).rejects.toBeInstanceOf(ExchangeSchemaError);
    });
  });

  describe('errors', () => {
    it('HTTP 429 -> ExchangeRateLimitError', async () => {
      const { fn } = makeFetch(() => ({ status: 429, body: '' }));
      await expect(
        new KrakenAdapter(fn).fetchBalances(creds),
      ).rejects.toBeInstanceOf(ExchangeRateLimitError);
    });

    it('EAPI:Rate limit exceeded -> ExchangeRateLimitError', async () => {
      const { fn } = makeFetch(() =>
        ok('{"error":["EAPI:Rate limit exceeded"]}'),
      );
      await expect(
        new KrakenAdapter(fn).fetchBalances(creds),
      ).rejects.toBeInstanceOf(ExchangeRateLimitError);
    });

    it('EAPI:Invalid key -> ExchangeAuthError', async () => {
      const { fn } = makeFetch(() => ok('{"error":["EAPI:Invalid key"]}'));
      const err = await new KrakenAdapter(fn)
        .fetchBalances(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeAuthError);
      expect(err.retryable).toBe(false);
      expect(typeof err.userMessage).toBe('string');
    });

    it('EGeneral:Permission denied -> ExchangeAuthError', async () => {
      const { fn } = makeFetch(() =>
        ok('{"error":["EGeneral:Permission denied"]}'),
      );
      await expect(
        new KrakenAdapter(fn).fetchBalances(creds),
      ).rejects.toBeInstanceOf(ExchangeAuthError);
    });

    it('network failure and 5xx -> ExchangeNetworkError without leaking secrets', async () => {
      const failing = jest.fn(async () => {
        throw new Error(`connect failed key=TESTKEY123 secret=${SECRET}`);
      }) as unknown as typeof fetch;
      const err = await new KrakenAdapter(failing)
        .fetchBalances(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeNetworkError);
      expect(err.retryable).toBe(true);
      const text = `${err.message} ${err.userMessage}`;
      expect(text).not.toContain('TESTKEY123');
      expect(text).not.toContain(SECRET);

      const { fn } = makeFetch(() => ({ status: 503, body: 'down' }));
      await expect(
        new KrakenAdapter(fn).fetchBalances(creds),
      ).rejects.toBeInstanceOf(ExchangeNetworkError);
    });

    it('unexpected shape -> ExchangeSchemaError carrying the redacted raw body', async () => {
      const raw = {
        error: [],
        result: { surprise: true, apiKey: 'TESTKEY123' },
      };
      const { fn } = makeFetch(() => ok(JSON.stringify(raw)));
      const err = await new KrakenAdapter(fn)
        .fetchHistory(creds, {})
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeSchemaError);
      expect((err.rawBody as any).result.surprise).toBe(true);
      expect(JSON.stringify(err.rawBody)).not.toContain('TESTKEY123');
    });

    it('non-JSON body -> ExchangeSchemaError with raw text', async () => {
      const { fn } = makeFetch(() => ok('<html>oops</html>'));
      const err = await new KrakenAdapter(fn)
        .fetchBalances(creds)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ExchangeSchemaError);
      expect(err.rawBody).toBe('<html>oops</html>');
    });
  });

  describe('nonce', () => {
    it('strictly increases across sequential calls even with a frozen clock', async () => {
      const { fn, calls } = makeFetch(() => ok(fixture('balance.json')));
      const a = new KrakenAdapter(fn, () => 1_700_000_000_000);
      for (let i = 0; i < 4; i++) await a.fetchBalances(creds);
      const nonces = calls.map(nonceOf);
      for (let i = 1; i < nonces.length; i++) {
        expect(nonces[i] > nonces[i - 1]).toBe(true);
      }
    });

    it('stays strictly increasing in send order for concurrent calls', async () => {
      const { fn, calls } = makeFetch(() => ok(fixture('balance.json')));
      const a = new KrakenAdapter(fn, () => 1_700_000_000_000);
      await Promise.all([1, 2, 3, 4, 5].map(() => a.fetchBalances(creds)));
      const nonces = calls.map(nonceOf);
      expect(nonces).toHaveLength(5);
      for (let i = 1; i < nonces.length; i++) {
        expect(nonces[i] > nonces[i - 1]).toBe(true);
      }
    });

    it('is shared across adapter instances', async () => {
      const f1 = makeFetch(() => ok(fixture('balance.json')));
      const f2 = makeFetch(() => ok(fixture('balance.json')));
      const clock = () => 1_700_000_000_000;
      await new KrakenAdapter(f1.fn, clock).fetchBalances(creds);
      await new KrakenAdapter(f2.fn, clock).fetchBalances(creds);
      expect(nonceOf(f2.calls[0]) > nonceOf(f1.calls[0])).toBe(true);
    });
  });

  it('only ever calls whitelisted read endpoints', async () => {
    const { fn, calls } = makeFetch((c) =>
      ok(
        c.url.endsWith('GetApiKeyInfo')
          ? fixture('api-key-info.json')
          : c.url.endsWith('Balance')
            ? fixture('balance.json')
            : c.url.endsWith('Ledgers')
              ? fixture('ledgers.json')
              : fixture('trades-history.json'),
      ),
    );
    const a = new KrakenAdapter(fn);
    await a.inspectKey(creds);
    await a.fetchBalances(creds);
    await a.fetchHistory(creds, {});
    await a.fetchHistory(creds, { cursor: 'ledger:0' });
    const paths = new Set(
      calls.map((c) => c.url.replace('https://api.kraken.com', '')),
    );
    expect([...paths].sort()).toEqual([
      '/0/private/Balance',
      '/0/private/GetApiKeyInfo',
      '/0/private/Ledgers',
      '/0/private/TradesHistory',
    ]);
  });
});
