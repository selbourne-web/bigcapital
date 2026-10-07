import { CryptoExchangeId } from '../../CryptoExchanges.constants';
import { redactSecrets } from '../../utils/redact';
import {
  Credentials,
  ExchangeAdapter,
  HistoryCoverage,
  KeyInspection,
  RawBalance,
  RawRecordInput,
} from '../ExchangeAdapter';
import { normalizeAsset } from '../assets';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';
import { isDecimal, isZero, sanitizeText } from '../shared';
import { cryptoComSign } from './cryptocom.signing';

const DEFAULT_BASE_URL = 'https://api.crypto.com/exchange/v1';

/**
 * Read-only methods. The adapter must never reach a state-changing method
 * (create-order, create-withdrawal, ...), so anything else is refused.
 */
const READ_METHODS = new Set([
  'private/user-balance',
  'private/get-accounts',
  'private/get-trades',
  'private/get-order-history',
  'private/get-transactions',
  'private/get-deposit-history',
  'private/get-withdrawal-history',
  'private/get-deposit-address', // inspectKey probe only; addresses are discarded
]);

const WITHDRAWAL_WARNING =
  'This Crypto.com key appears to have withdrawal permission enabled. Crypto.com does not expose key permissions, so please confirm the key is read-only (Can Read only).';

type Json = Record<string, any>;

/** Exact decimal arithmetic on non-negative decimal strings. */
function scaled(a: string, b: string) {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  return {
    scale,
    x: BigInt(ai + af.padEnd(scale, '0')),
    y: BigInt(bi + bf.padEnd(scale, '0')),
  };
}

function format(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** a - b, clamped at 0. */
function subDecimal(a: string, b: string): string {
  const { scale, x, y } = scaled(a, b);
  return x > y ? format(x - y, scale) : '0';
}

function addDecimal(a: string, b: string): string {
  const { scale, x, y } = scaled(a, b);
  return format(x + y, scale);
}

export class CryptoComAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'crypto_com';
  readonly historyCoverage: HistoryCoverage = {
    level: 'partial',
    note: 'Crypto.com Exchange API history is limited to the last 6 months.',
  };
  /** 3 private calls per 100 ms; trades/order history 1 req/s, so history pages cost 10. */
  readonly rateLimit = { capacity: 3, refillPerSec: 10, historyPageCost: 10 };

  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly requestTimeoutMs: number = 30_000,
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = DEFAULT_BASE_URL, // overridable for tests only
  ) {}

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    // Cheap auth check first so bad key/clock/IP errors are reported once, clearly.
    await this.call(creds, 'private/user-balance', {});
    const unverifiable = (warnings: string[]): KeyInspection => ({
      readOnly: 'unverifiable',
      permissions: ['read'],
      warnings,
    });
    try {
      // Heuristic: vendor docs say this needs the withdrawal setting. The returned
      // addresses are discarded and never stored or logged.
      await this.call(creds, 'private/get-deposit-address', {
        currency: 'BTC',
      });
      return unverifiable([WITHDRAWAL_WARNING]);
    } catch (err) {
      if (err instanceof ExchangeAuthError) throw err;
      return unverifiable([]);
    }
  }

  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    const creds = this.trim(c);
    const body = await this.call(creds, 'private/user-balance', {});
    const data = body.result?.data;
    if (!Array.isArray(data)) {
      throw this.schemaError('user-balance result.data is not an array', body);
    }
    const out = new Map<string, { free: string; locked: string }>();
    for (const account of data) {
      const positions = account?.position_balances;
      if (!Array.isArray(positions)) {
        throw this.schemaError('user-balance has no position_balances', body);
      }
      for (const p of positions) {
        if (
          !p ||
          typeof p.instrument_name !== 'string' ||
          !isDecimal(p.quantity) ||
          !isDecimal(p.reserved_qty)
        ) {
          throw this.schemaError('user-balance position has bad shape', body);
        }
        if (isZero(p.quantity) && isZero(p.reserved_qty)) continue;
        const asset = normalizeAsset('crypto_com', p.instrument_name);
        const free = subDecimal(p.quantity, p.reserved_qty);
        const locked = addDecimal(p.reserved_qty, '0');
        const prev = out.get(asset);
        if (prev) {
          prev.free = addDecimal(prev.free, free);
          prev.locked = addDecimal(prev.locked, locked);
        } else {
          out.set(asset, { free, locked });
        }
      }
    }
    return [...out.entries()].map(([asset, v]) => ({ asset, ...v }));
  }

  /** Implemented in Task 3 (windowed trades/orders/transactions/deposits/withdrawals). */
  async fetchHistory(
    _c: Credentials,
    _q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    return { records: [] };
  }

  private trim(c: Credentials): Credentials {
    return { apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
  }

  /** Serialized so ids/nonces reach the exchange in order. */
  private call(
    creds: Credentials,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Json> {
    const run = this.queue.then(() => this.send(creds, method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    creds: Credentials,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Json> {
    if (!READ_METHODS.has(method)) {
      throw new Error(`Refusing to call non-read Crypto.com method ${method}`);
    }
    const id = ++this.nextId;
    const nonce = this.now();
    const sig = cryptoComSign({
      method,
      id,
      apiKey: creds.apiKey,
      params,
      nonce,
      secret: creds.apiSecret,
    });
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Crypto.com request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          method,
          api_key: creds.apiKey,
          params,
          nonce,
          sig,
        }),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Crypto.com request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }

    if (res.status === 429) throw new ExchangeRateLimitError();
    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();
    if (res.status >= 500) {
      throw new ExchangeNetworkError(`Crypto.com returned HTTP ${res.status}`);
    }
    // Parsed from text (never via res.json) so numeric strings stay exact.
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.status === 401) throw this.mapCode(40101);
      throw new ExchangeSchemaError(
        'Crypto.com response was not valid JSON',
        this.sanitize(text, creds),
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.code !== 'number'
    ) {
      throw this.schemaError('Crypto.com response has no numeric code', parsed);
    }
    if (parsed.code !== 0) throw this.mapCode(parsed.code);
    if (!res.ok) {
      throw new ExchangeNetworkError(`Crypto.com returned HTTP ${res.status}`);
    }
    return parsed;
  }

  /** Codes: https://exchange-developer.crypto.com/exchange/v1/docs/api/rest-common-api-reference */
  private mapCode(code: number) {
    switch (code) {
      case 40101:
        return new ExchangeAuthError(
          'Crypto.com: key or signature incorrect (40101)',
          'Crypto.com rejected the API key or signature. Check the key and secret.',
        );
      case 40102:
        return new ExchangeAuthError(
          'Crypto.com: nonce differs by more than 60 seconds (40102)',
          'Crypto.com rejected the request because the server clock is out of sync (more than 60 seconds). Check the server time and try again.',
        );
      case 40103:
        return new ExchangeAuthError(
          'Crypto.com: IP address not allow-listed (40103)',
          'This API key is IP-restricted and this server is not on its allow-list. Add the server IP in Crypto.com or remove the restriction.',
        );
      case 42901:
        return new ExchangeRateLimitError(
          'Crypto.com: too many requests (42901)',
        );
      default:
        return new ExchangeNetworkError(
          `Crypto.com error code ${code}`,
          'The exchange reported an error. Check the connection and try again.',
          false,
        );
    }
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [creds.apiKey, creds.apiSecret]);
  }
}
