import { createHash } from 'crypto';
import {
  CryptoExchangeId,
  CryptoRecordType,
} from '../../CryptoExchanges.constants';
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
import {
  addDecimal,
  isDecimal,
  isZero,
  sanitizeText,
  subDecimal,
} from '../shared';
import { cryptoComAppSign } from './cryptocomapp.signing';

const DEFAULT_BASE_URL = 'https://wapi.crypto.com';
const USER_AGENT = 'Bigcapital-CryptoSync/1.0';

/** Read-only endpoints; anything else is refused (GET only in this adapter). */
const READ_PATHS = new Set([
  '/v1/api-keys/current',
  '/v1/crypto-account',
  '/v1/fiat-account',
  '/v1/transactions',
]);

/**
 * `:write` scopes known to be harmless (they cannot move funds out of the account).
 * Everything else that is writable is refused: this is a fail-closed allowlist, not
 * a denylist of dangerous names, because new money-moving scopes (swap, staking,
 * card spend, ...) cannot be enumerated in advance.
 */
export const BENIGN_WRITE_RESOURCES = ['fiat.deposit'];

/** Max a per-key timestamp may run ahead of the clock before the lane waits. */
const MAX_TS_DRIFT_MS = 5_000;

/**
 * Classify App API key scopes (`<resource>:<read|write>`). Fail closed:
 * all `:read` is read-only; a `:write` on a BENIGN_WRITE_RESOURCES resource is
 * `'unverifiable'`; any other `:write`, any scope that is neither `:read` nor
 * `:write`, and an empty list are not read-only. Precedence: false beats
 * 'unverifiable' beats true. `writeScopes` lists every non-read scope.
 */
export function classifyScopes(scopes: string[]): {
  readOnly: boolean | 'unverifiable';
  permissions: string[];
  writeScopes: string[];
} {
  const permissions = scopes.map((s) => String(s).trim().toLowerCase());
  const writeScopes: string[] = [];
  let refused = false;
  let unverifiable = false;
  for (const scope of permissions) {
    const i = scope.lastIndexOf(':');
    const suffix = i >= 0 ? scope.slice(i + 1) : '';
    const resource = i >= 0 ? scope.slice(0, i) : scope;
    if (suffix === 'read') continue;
    writeScopes.push(scope);
    if (suffix === 'write' && BENIGN_WRITE_RESOURCES.includes(resource)) {
      unverifiable = true;
    } else {
      refused = true;
    }
  }
  const readOnly: boolean | 'unverifiable' =
    permissions.length === 0 || refused
      ? false
      : unverifiable
        ? 'unverifiable'
        : true;
  return { readOnly, permissions, writeScopes };
}

type Json = Record<string, any>;

/** Decimal text with an optional leading minus (outflow legs are negative); never parsed to float. */
const isSignedDecimal = (v: unknown): v is string =>
  typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

const PAGE_SIZE = 50;
const LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const OLDER_STOP = 3;
type HistoryCursor = {
  last_id: string;
  count: number;
  pagination_key: string;
  sort_by: string;
  order: 'desc';
};

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
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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
      // `balance` is the authoritative total. One odd wallet never fails the sync:
      // unusable, zero or negative (liability) balances are skipped.
      const total = w?.balance?.amount;
      if (
        !w ||
        typeof w.currency !== 'string' ||
        w.currency.trim() === '' ||
        !isDecimal(total) ||
        isZero(total)
      ) {
        continue;
      }
      let free = total;
      let locked = '0';
      const available = w.available?.amount;
      if (isDecimal(available)) {
        free = available;
        // locked is derived from the total, not trusted from `locked`. If
        // available > balance (an exchange-side anomaly) locked clamps to 0 and
        // free keeps the reported available value.
        locked = subDecimal(total, available);
      }
      add(normalizeAsset('crypto_com_app', w.currency), free, locked);
    }
    for (const b of fiatBalances) {
      // Live shape: `amount` is `{ currency, amount }` (decimal string inside).
      // A plain decimal string is also accepted. A malformed entry is skipped,
      // never failing the whole sync; only a wrong top-level shape throws.
      const value =
        typeof b?.amount === 'object' ? b.amount?.amount : b?.amount;
      if (
        !b ||
        typeof b.currency !== 'string' ||
        b.currency.trim() === '' ||
        !isDecimal(value) ||
        isZero(value)
      ) {
        continue;
      }
      add(normalizeAsset('crypto_com_app', b.currency), value, '0');
    }
    return [...out.entries()].map(([asset, v]) => ({ asset, ...v }));
  }

  /**
   * `GET /v1/transactions`, one HTTP page (`count=50`, newest first) per call. Cursor
   * is the opaque JSON of the `meta.pagination.next` params (absent on the first call);
   * `total` is unreliable and ignored. The stream ends when `next` is absent or an
   * item is older than `since` (items are newest first). Items are never dropped or
   * thrown on: anything not matching the mapping or missing required fields is stored
   * as `unparsed`. A response that is not the documented envelope, or a malformed
   * cursor, is an ExchangeSchemaError.
   */
  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string; knownAssets?: string[] },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const creds = this.trim(c);
    const cur = q.cursor !== undefined ? this.parseCursor(q.cursor) : undefined;
    const body = await this.get(
      creds,
      '/v1/transactions',
      cur ?? { count: PAGE_SIZE },
    );
    if (body.ok !== true || !Array.isArray(body.transactions)) {
      throw this.schemaError('transactions response is not the envelope', body);
    }
    // Own lookback: re-fetch the last 7 days so status changes of recent
    // transactions are seen (duplicates are harmless, ids are idempotent).
    const boundMs = q.since ? q.since.getTime() - LOOKBACK_MS : undefined;
    const records: RawRecordInput[] = [];
    let reachedSince = false;
    let olderStreak = 0;
    for (const item of body.transactions) {
      const at = this.itemDate(item);
      if (boundMs !== undefined && at !== undefined && at.getTime() < boundMs) {
        // Back-dated items exist: stop only after OLDER_STOP consecutive older
        // items; older items are never emitted.
        if (++olderStreak >= OLDER_STOP) {
          reachedSince = true;
          break;
        }
        continue;
      }
      olderStreak = 0;
      records.push(this.mapItem(item, at));
    }
    if (reachedSince) return { records };
    const next = body.meta?.pagination?.next;
    if (next === undefined || next === null) return { records };
    const nextCur = this.validateCursor(next);
    if (!nextCur) {
      throw this.schemaError(
        'transactions pagination.next has bad shape',
        body.meta,
      );
    }
    if (cur && cur.last_id === nextCur.last_id) {
      throw this.schemaError('transactions pagination made no progress', next);
    }
    return { records, nextCursor: JSON.stringify(nextCur) };
  }

  private parseCursor(raw: string): HistoryCursor {
    let v: unknown;
    try {
      v =
        typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : null;
    } catch {
      v = null;
    }
    const cur = this.validateCursor(v);
    if (!cur) {
      throw new ExchangeSchemaError(
        'Invalid Crypto.com App history cursor',
        typeof raw === 'string' ? raw.slice(0, 200) : String(raw),
      );
    }
    return cur;
  }

  /** Whitelist exactly the five next-page params, bounded; undefined if malformed. */
  private validateCursor(v: any): HistoryCursor | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    // Live ids look like `<letters>/<digits>`: any bounded, safe-charset string.
    if (
      typeof v.last_id !== 'string' ||
      !/^[A-Za-z0-9_\-/=+.:]{1,128}$/.test(v.last_id)
    )
      return undefined;
    if (!Number.isInteger(v.count) || v.count < 1 || v.count > PAGE_SIZE)
      return undefined;
    if (
      typeof v.pagination_key !== 'string' ||
      v.pagination_key.length > 256 ||
      !/^[ -~]*$/.test(v.pagination_key)
    )
      return undefined;
    if (typeof v.sort_by !== 'string' || !/^[a-z_]{1,32}$/.test(v.sort_by))
      return undefined;
    if (typeof v.order !== 'string' || v.order.toLowerCase() !== 'desc')
      return undefined; // newest first is what `since` relies on
    return {
      last_id: v.last_id,
      count: v.count,
      pagination_key: v.pagination_key,
      sort_by: v.sort_by,
      order: 'desc',
    };
  }

  private itemDate(item: any): Date | undefined {
    const v = item?.created_at;
    if (typeof v !== 'string') return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }

  private mapItem(item: any, at: Date | undefined): RawRecordInput {
    const unparsed = (): RawRecordInput => {
      const hash = createHash('sha256')
        .update(JSON.stringify(item) ?? 'undefined')
        .digest('hex')
        .slice(0, 32);
      return {
        type: 'unparsed',
        exchangeRecordId: `unparsed:app:${hash}`,
        occurredAt: at ?? new Date(this.now()),
        payload: { item: redactSecrets(item), internalTransfer: false },
      };
    };
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return unparsed();
    }
    const amount = item.amount;
    if (
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
      typeof item.status !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,32}$/.test(item.status) ||
      !at ||
      !amount ||
      typeof amount !== 'object' ||
      typeof amount.currency !== 'string' ||
      amount.currency.trim() === '' ||
      !isSignedDecimal(amount.amount)
    ) {
      return unparsed();
    }
    // Principal lock/unlock (negative amounts observed), not income: kept raw,
    // piece 3 decides.
    if (
      (typeof item.kind === 'string' &&
        item.kind.toLowerCase().startsWith('finance.dpos.staking')) ||
      item.source_type === 'dpos_staking'
    ) {
      return unparsed();
    }
    const m = this.classify(item.kind) ?? this.classify(item.nature);
    if (!m) return unparsed();
    return {
      type: m.type,
      // The status is part of the id: a later status change of the same transaction
      // becomes a new immutable raw row.
      exchangeRecordId: `app:${item.id}:s${item.status}`,
      occurredAt: at,
      payload: { item, internalTransfer: m.internalTransfer },
    };
  }

  /** First match wins; applied to `kind`, then to `nature`. */
  private classify(
    v: unknown,
  ): { type: CryptoRecordType; internalTransfer: boolean } | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase();
    if (s === 'crypto_to_exchange_transfer')
      return { type: 'withdrawal', internalTransfer: true };
    if (s === 'exchange_to_crypto_transfer')
      return { type: 'deposit', internalTransfer: true };
    // Reward keywords first: rewards_platform_deposit_credited is an airdrop, not
    // a deposit. Unmapped values (e.g. admin_wallet_credited) become 'unparsed':
    // counted, raw item kept.
    if (['dpos', 'rewards', 'airdrop', 'income'].some((k) => s.includes(k)))
      return { type: 'reward', internalTransfer: false };
    if (s.includes('deposit'))
      return { type: 'deposit', internalTransfer: false };
    if (s.includes('withdraw'))
      return { type: 'withdrawal', internalTransfer: false };
    if (
      s === 'crypto_wallet_swap_credited' ||
      s === 'crypto_wallet_swap_debited'
    )
      return { type: 'trade', internalTransfer: false };
    return undefined;
  }

  private trim(c: Credentials): Credentials {
    return { apiKey: c.apiKey.trim(), apiSecret: c.apiSecret.trim() };
  }

  /**
   * Serialized per api key so timestamps reach the exchange in order. `query` is
   * appended to the URL but NOT signed or allow-listed (only `path` is).
   */
  private get(
    creds: Credentials,
    path: string,
    query?: Record<string, string | number>,
  ): Promise<Json> {
    const key = createHash('sha256').update(creds.apiKey).digest('hex');
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, lastTs: 0 };
      this.lanes.set(key, lane);
    }
    const l = lane;
    l.pending++;
    const run = l.tail.then(() =>
      this.send(creds, path, query, async () => {
        let ts = Math.max(this.now(), l.lastTs + 1);
        if (ts - this.now() > MAX_TS_DRIFT_MS) {
          // Do not drift further ahead of the clock: wait until within range.
          await this.sleep(ts - this.now() - MAX_TS_DRIFT_MS);
          ts = Math.max(this.now(), l.lastTs + 1);
        }
        l.lastTs = ts;
        return ts;
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
    query: Record<string, string | number> | undefined,
    nextTimestamp: () => Promise<number>,
  ): Promise<Json> {
    if (!READ_PATHS.has(path)) {
      throw new Error(`Refusing to call non-read Crypto.com App path ${path}`);
    }
    const qs = query
      ? new URLSearchParams(
          Object.keys(query)
            .sort()
            .map((k) => [k, String(query[k])]),
        ).toString()
      : '';
    const timestamp = await nextTimestamp();
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
      res = await this.fetchImpl(
        `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`,
        {
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
        },
      );
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Crypto.com App request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }
    // Always read (drain) the body so the connection is released.
    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();
    if (res.status === 429) {
      throw new ExchangeRateLimitError(
        'Crypto.com App rate limit exceeded',
        undefined,
        60_000,
      );
    }
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
