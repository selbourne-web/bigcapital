import { createHash } from 'crypto';
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
import { addDecimal, isDecimal, isZero, sanitizeText } from '../shared';
import { cryptoComAppSign } from './cryptocomapp.signing';

const DEFAULT_BASE_URL = 'https://wapi.crypto.com';
const USER_AGENT = 'Bigcapital-CryptoSync/1.0';

/** Read-only endpoints; anything else is refused (GET only in this adapter). */
const READ_PATHS = new Set([
  '/v1/api-keys/current',
  '/v1/crypto-account',
  '/v1/fiat-account',
]);

/** Resource keywords that make a `:write` scope money-moving. */
const DANGEROUS_RESOURCE =
  /withdraw|transfer|trade|trading|purchase|sale|exchange|convert|order|payment|send/;

/**
 * Classify App API key scopes (`<resource>:<read|write>`). Fail closed:
 * unknown suffix or an empty list is not read-only; a money-moving write is not
 * read-only; any other write (e.g. `fiat.deposit:write`) is `'unverifiable'`.
 * Precedence: false beats 'unverifiable' beats true.
 */
export function classifyScopes(scopes: string[]): {
  readOnly: boolean | 'unverifiable';
  permissions: string[];
  writeScopes: string[];
} {
  const permissions = scopes.map((s) => String(s).trim().toLowerCase());
  const writeScopes: string[] = [];
  let unknown = false;
  let dangerous = false;
  let unverifiable = false;
  for (const scope of permissions) {
    const i = scope.lastIndexOf(':');
    const suffix = i >= 0 ? scope.slice(i + 1) : '';
    const resource = i >= 0 ? scope.slice(0, i) : scope;
    if (suffix === 'read') continue;
    writeScopes.push(scope);
    if (suffix === 'write') {
      if (DANGEROUS_RESOURCE.test(resource)) dangerous = true;
      else unverifiable = true;
    } else {
      unknown = true;
    }
  }
  const readOnly: boolean | 'unverifiable' =
    permissions.length === 0 || unknown || dangerous
      ? false
      : unverifiable
        ? 'unverifiable'
        : true;
  return { readOnly, permissions, writeScopes };
}

type Json = Record<string, any>;

export class CryptoComAppAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'crypto_com_app';
  readonly historyCoverage: HistoryCoverage = { level: 'full' };
  /** Capacity must be >= historyPageCost (RateLimiter.acquire throws otherwise). */
  readonly rateLimit = { capacity: 5, refillPerSec: 0.5, historyPageCost: 2 };

  /**
   * Per-api-key serialization lanes (keyed by sha256 of the key). The adapter is a
   * process-wide singleton shared by tenants, so there is no instance-wide queue.
   * Lanes are deleted when idle; timestamps are monotonic per key.
   */
  private readonly lanes = new Map<
    string,
    { tail: Promise<unknown>; pending: number; lastTs: number }
  >();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly requestTimeoutMs: number = 30_000,
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = DEFAULT_BASE_URL, // overridable for tests only
  ) {}

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    const body = await this.get(creds, '/v1/api-keys/current');
    const key = body.api_key;
    if (!key || typeof key !== 'object') {
      throw this.schemaError('api-keys/current has no api_key', body);
    }
    if (
      !Array.isArray(key.scopes) ||
      !key.scopes.every((s: unknown) => typeof s === 'string')
    ) {
      throw this.schemaError('api-keys/current scopes is not a string[]', body);
    }
    if (key.status !== 'active' || (key.revoked_at ?? null) !== null) {
      throw new ExchangeAuthError(
        'Crypto.com App key is revoked or inactive',
        'This Crypto.com App key is revoked or inactive. Create a new read-only API key.',
      );
    }
    let expiresAt: Date | undefined;
    if (key.expires_at !== undefined && key.expires_at !== null) {
      expiresAt =
        typeof key.expires_at === 'string'
          ? new Date(key.expires_at)
          : new Date(NaN);
      if (isNaN(expiresAt.getTime())) {
        throw this.schemaError('api-keys/current expires_at is invalid', body);
      }
      if (expiresAt.getTime() <= this.now()) {
        throw new ExchangeAuthError(
          'Crypto.com App key expired',
          'This Crypto.com App API key has expired. Create a new read-only API key.',
        );
      }
    }
    const { readOnly, permissions, writeScopes } = classifyScopes(key.scopes);
    return { readOnly, permissions, writeScopes, expiresAt };
  }

  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    const creds = this.trim(c);
    const crypto = await this.get(creds, '/v1/crypto-account');
    const fiat = await this.get(creds, '/v1/fiat-account');
    const wallets = crypto.account?.wallets;
    if (!Array.isArray(wallets)) {
      throw this.schemaError('crypto-account has no wallets array', crypto);
    }
    const fiatBalances = fiat.account?.balances;
    if (!Array.isArray(fiatBalances)) {
      throw this.schemaError('fiat-account has no balances array', fiat);
    }
    const out = new Map<string, { free: string; locked: string }>();
    const add = (asset: string, free: string, locked: string) => {
      const prev = out.get(asset);
      if (prev) {
        prev.free = addDecimal(prev.free, free);
        prev.locked = addDecimal(prev.locked, locked);
      } else {
        out.set(asset, {
          free: addDecimal(free, '0'),
          locked: addDecimal(locked, '0'),
        });
      }
    };
    for (const w of wallets) {
      const total = w?.balance?.amount;
      if (
        !w ||
        typeof w.currency !== 'string' ||
        w.currency.trim() === '' ||
        !isDecimal(total)
      ) {
        throw this.schemaError('crypto-account wallet has bad shape', crypto);
      }
      if (isZero(total)) continue; // most of the ~2000 listed wallets are empty
      const free = w.available?.amount;
      const locked = w.locked?.amount;
      if (!isDecimal(free) || !isDecimal(locked)) {
        throw this.schemaError('crypto-account wallet has bad amounts', crypto);
      }
      if (isZero(free) && isZero(locked)) continue;
      add(normalizeAsset('crypto_com_app', w.currency), free, locked);
    }
    for (const b of fiatBalances) {
      if (
        !b ||
        typeof b.currency !== 'string' ||
        b.currency.trim() === '' ||
        !isDecimal(b.amount)
      ) {
        throw this.schemaError('fiat-account balance has bad shape', fiat);
      }
      if (isZero(b.amount)) continue;
      add(normalizeAsset('crypto_com_app', b.currency), b.amount, '0');
    }
    return [...out.entries()].map(([asset, v]) => ({ asset, ...v }));
  }

  async fetchHistory(
    _c: Credentials,
    _q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    // TODO(Task 5): App transactions history. Stub so the registry works.
    return { records: [] };
  }

  private trim(c: Credentials): Credentials {
    return { apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
  }

  /** Serialized per api key so timestamps reach the exchange in order. */
  private get(creds: Credentials, path: string): Promise<Json> {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, lastTs: 0 };
      this.lanes.set(key, lane);
    }
    const l = lane;
    l.pending++;
    const run = l.tail.then(() =>
      this.send(creds, path, () => {
        l.lastTs = Math.max(this.now(), l.lastTs + 1);
        return l.lastTs;
      }),
    );
    l.tail = run.catch(() => undefined);
    const done = () => {
      if (--l.pending === 0 && this.lanes.get(key) === l)
        this.lanes.delete(key);
    };
    run.then(done, done);
    return run;
  }

  private async send(
    creds: Credentials,
    path: string,
    nextTimestamp: () => number,
  ): Promise<Json> {
    if (!READ_PATHS.has(path)) {
      throw new Error(`Refusing to call non-read Crypto.com App path ${path}`);
    }
    const timestamp = nextTimestamp();
    const signature = cryptoComAppSign({
      timestamp,
      method: 'GET',
      path,
      secret: creds.apiSecret,
    });
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Crypto.com App request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          'Cdc-Api-Key': creds.apiKey,
          'Cdc-Api-Timestamp': String(timestamp),
          'Cdc-Api-Signature': signature,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Crypto.com App request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }
    if (res.status === 429) {
      throw new ExchangeRateLimitError(
        'Crypto.com App rate limit exceeded',
        undefined,
        60_000,
      );
    }
    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();
    if (res.status === 401) {
      throw new ExchangeAuthError(
        'Crypto.com App: key or signature rejected (401)',
        'Crypto.com rejected the API key or signature. Check the key and secret, and that the server clock is accurate.',
      );
    }
    if (res.status === 403) {
      throw new ExchangeAuthError(
        'Crypto.com App: access forbidden (403)',
        'Crypto.com denied access. The key may be IP-restricted (add this server) or lack the required read scope.',
      );
    }
    if (res.status >= 500) {
      throw new ExchangeNetworkError(
        `Crypto.com App returned HTTP ${res.status}`,
      );
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ExchangeSchemaError(
        'Crypto.com App response was not valid JSON',
        this.sanitize(text, creds),
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw this.schemaError(
        'Crypto.com App response is not an object',
        parsed,
      );
    }
    if (!res.ok || parsed.ok === false) {
      throw new ExchangeNetworkError(
        `Crypto.com App returned HTTP ${res.status}`,
        'The exchange reported an error. Check the connection and try again.',
        false,
      );
    }
    return parsed;
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [creds.apiKey, creds.apiSecret]);
  }
}
