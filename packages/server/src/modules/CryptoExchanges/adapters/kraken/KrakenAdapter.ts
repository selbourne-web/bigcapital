import {
  CryptoExchangeId,
  CryptoRecordType,
} from '../../CryptoExchanges.constants';
import { redactSecrets } from '../../utils/redact';
import {
  Credentials,
  ExchangeAdapter,
  KeyInspection,
  RawBalance,
  RawRecordInput,
} from '../ExchangeAdapter';
import { KRAKEN_STAKING_SUFFIX, normalizeAsset } from '../assets';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
} from '../errors';
import { addDecimal, isDecimal, isZero, sanitizeText } from '../shared';
import { signKraken } from './kraken.signing';

const HOST = 'https://api.kraken.com';

/**
 * Query-only endpoints. This adapter must never reach a state-changing endpoint
 * (AddOrder, Withdraw, WalletTransfer, ...), so anything else is refused.
 */
const READ_ENDPOINTS = new Set([
  '/0/private/Balance',
  '/0/private/TradesHistory',
  '/0/private/Ledgers',
  '/0/private/GetApiKeyInfo',
]);

/** GetApiKeyInfo permission strings that cannot move money or change orders. */
const READ_PERMISSIONS = new Set([
  'query-funds',
  'query-open-trades',
  'query-closed-trades',
  'query-ledger',
  'export-data',
]);

type Phase = 'trades' | 'ledger';

type Json = Record<string, any>;

export class KrakenAdapter implements ExchangeAdapter {
  readonly id: CryptoExchangeId = 'kraken';
  /** Starter tier: counter max 15, decays 0.33/s. Ledger/trade history calls cost 2. */
  readonly rateLimit = {
    capacity: 15,
    refillPerSec: 0.33,
    historyPageCost: 2, // history calls cost 2 on the call counter
  };

  /** Shared so several adapter instances in one process never reuse a nonce. */
  private static lastNonce = BigInt(0);
  /** Serializes this instance's calls so nonces reach Kraken in increasing order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    options: { requestTimeoutMs?: number } = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private readonly requestTimeoutMs: number;

  async inspectKey(c: Credentials): Promise<KeyInspection> {
    const creds = this.trim(c);
    const { result } = await this.call(creds, '/0/private/GetApiKeyInfo', {});
    const perms = result?.permissions;
    if (
      !Array.isArray(perms) ||
      !perms.every((p: unknown) => typeof p === 'string')
    ) {
      return { readOnly: 'unverifiable', permissions: [] };
    }
    return {
      readOnly: perms.every((p: string) => READ_PERMISSIONS.has(p)),
      permissions: perms,
    };
  }

  async fetchBalances(c: Credentials): Promise<RawBalance[]> {
    const creds = this.trim(c);
    const body = await this.call(creds, '/0/private/Balance', {});
    const result = body.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw this.schemaError('Balance result is not an object', body);
    }
    const byAsset = new Map<string, { free: string; locked: string }>();
    for (const [rawAsset, amount] of Object.entries(result)) {
      if (!isDecimal(amount)) {
        throw this.schemaError(
          `Balance amount for ${rawAsset} is not a decimal`,
          body,
        );
      }
      const asset = normalizeAsset('kraken', rawAsset);
      const entry = byAsset.get(asset) ?? { free: '0', locked: '0' };
      // Staked / earn balances (.S .M .F .B .P) are not freely spendable.
      const field = KRAKEN_STAKING_SUFFIX.test(rawAsset.toUpperCase())
        ? 'locked'
        : 'free';
      entry[field] = addDecimal(entry[field], amount);
      byAsset.set(asset, entry);
    }
    return [...byAsset.entries()]
      .filter(([, v]) => !isZero(v.free) || !isZero(v.locked))
      .map(([asset, v]) => ({ asset, free: v.free, locked: v.locked }));
  }

  /**
   * Cursor is `<phase>:<offset>`: trades are paged first, then ledgers.
   * Uses `ofs` paging (marked deprecated in the docs but still the documented
   * way to page TradesHistory/Ledgers); duplicates are absorbed by the stable
   * exchangeRecordId.
   */
  async fetchHistory(
    c: Credentials,
    q: { since?: Date; cursor?: string },
  ): Promise<{ records: RawRecordInput[]; nextCursor?: string }> {
    const creds = this.trim(c);
    const { phase, ofs } = this.parseCursor(q.cursor);
    const params: Record<string, string> = { ofs: String(ofs) };
    if (q.since) {
      // `start` is exclusive; step back one second and let ids dedupe the overlap.
      params.start = String(Math.floor(q.since.getTime() / 1000) - 1);
    }

    const path =
      phase === 'trades' ? '/0/private/TradesHistory' : '/0/private/Ledgers';
    const body = await this.call(creds, path, params);
    const result: Json = body.result ?? {};
    const rows: Json | undefined =
      phase === 'trades' ? result.trades : result.ledger;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
      throw this.schemaError(`${path} result is missing its entries`, body);
    }

    const entries = Object.entries(rows) as [string, Json][];
    const records: RawRecordInput[] = [];
    for (const [id, row] of entries) {
      if (!row || typeof row !== 'object' || typeof row.time !== 'number') {
        throw this.schemaError(`${path} entry ${id} has no numeric time`, body);
      }
      if (phase === 'trades') {
        records.push(this.tradeRecord(id, row));
      } else {
        records.push(...this.ledgerRecords(id, row, body));
      }
    }

    const nextOfs = ofs + entries.length;
    const count = typeof result.count === 'number' ? result.count : undefined;
    const hasMore =
      entries.length > 0 &&
      (count !== undefined ? nextOfs < count : entries.length >= 50);
    let nextCursor: string | undefined;
    if (hasMore) {
      nextCursor = `${phase}:${nextOfs}`;
    } else if (phase === 'trades') {
      nextCursor = 'ledger:0';
    }
    return { records, nextCursor };
  }

  private tradeRecord(id: string, row: Json): RawRecordInput {
    return {
      type: 'trade',
      exchangeRecordId: id,
      occurredAt: new Date(Math.round(row.time * 1000)),
      payload: { id, ...row },
    };
  }

  private ledgerRecords(
    id: string,
    row: Json,
    body: unknown,
  ): RawRecordInput[] {
    if (typeof row.type !== 'string' || typeof row.asset !== 'string') {
      throw this.schemaError(`Ledger entry ${id} has no type/asset`, body);
    }
    const type = this.ledgerType(row.type);
    // Trade rows duplicate TradesHistory; other types (transfer, spend, ...) have
    // no CryptoRecordType and are not recorded.
    if (!type) return [];
    const occurredAt = new Date(Math.round(row.time * 1000));
    const normalizedAsset = normalizeAsset('kraken', row.asset);
    const out: RawRecordInput[] = [
      {
        type,
        exchangeRecordId: id,
        occurredAt,
        payload: { id, ...row, normalizedAsset },
      },
    ];
    if (
      (type === 'deposit' || type === 'withdrawal') &&
      isDecimal(row.fee) &&
      !isZero(row.fee)
    ) {
      out.push({
        type: 'fee',
        exchangeRecordId: `${id}:fee`,
        occurredAt,
        payload: {
          ledgerId: id,
          refid: row.refid,
          sourceType: row.type,
          asset: row.asset,
          normalizedAsset,
          fee: row.fee,
        },
      });
    }
    return out;
  }

  private ledgerType(krakenType: string): CryptoRecordType | undefined {
    switch (krakenType) {
      case 'deposit':
        return 'deposit';
      case 'withdrawal':
        return 'withdrawal';
      case 'staking':
      case 'reward':
      case 'dividend':
        return 'reward';
      default:
        return undefined;
    }
  }

  private parseCursor(cursor?: string): { phase: Phase; ofs: number } {
    if (!cursor) return { phase: 'trades', ofs: 0 };
    const m = /^(trades|ledger):(\d{1,9})$/.exec(cursor);
    if (!m) {
      throw new ExchangeSchemaError('Invalid Kraken history cursor', cursor);
    }
    return { phase: m[1] as Phase, ofs: Number(m[2]) };
  }

  private trim(c: Credentials): Credentials {
    return {
      apiKey: c.apiKey.trim(),
      apiSecret: c.apiSecret.trim(),
      passphrase: c.passphrase?.trim(),
    };
  }

  private nextNonce(): string {
    const candidate = BigInt(this.now());
    const next =
      candidate > KrakenAdapter.lastNonce
        ? candidate
        : KrakenAdapter.lastNonce + BigInt(1);
    KrakenAdapter.lastNonce = next;
    return next.toString();
  }

  /** Serialized, signed POST to a whitelisted private endpoint; returns the parsed body (`{ error, result }`). */
  private call(
    creds: Credentials,
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    const run = this.queue.then(() => this.send(creds, path, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    creds: Credentials,
    path: string,
    params: Record<string, string>,
  ): Promise<any> {
    if (!READ_ENDPOINTS.has(path)) {
      throw new Error(`Refusing to call non-read Kraken endpoint ${path}`);
    }
    const nonce = this.nextNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    // One deadline covers connect, headers and body so a hung socket cannot wedge the queue.
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const timedOut = () =>
      new ExchangeNetworkError(
        `Kraken request timed out after ${this.requestTimeoutMs}ms`,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(`${HOST}${path}`, {
        method: 'POST',
        headers: {
          'API-Key': creds.apiKey,
          'API-Sign': signKraken(path, nonce, body, creds.apiSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new ExchangeNetworkError(
        `Kraken request failed: ${this.sanitize((err as Error)?.message, creds)}`,
      );
    }

    if (res.status === 429) {
      throw new ExchangeRateLimitError();
    }
    const text = await res.text().catch(() => '');
    if (signal.aborted) throw timedOut();
    if (res.status >= 500) {
      throw new ExchangeNetworkError(`Kraken returned HTTP ${res.status}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ExchangeSchemaError(
        'Kraken response was not valid JSON',
        this.sanitize(text, creds),
      );
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.error)) {
      throw this.schemaError('Kraken response has no error array', parsed);
    }

    const errors: string[] = parsed.error.filter(
      (e: unknown): e is string => typeof e === 'string' && e.startsWith('E'),
    );
    if (errors.length) {
      throw this.mapApiError(errors, creds);
    }
    if (!res.ok) {
      throw new ExchangeNetworkError(`Kraken returned HTTP ${res.status}`);
    }
    if (parsed.result === undefined) {
      throw this.schemaError('Kraken response has no result', parsed);
    }
    return parsed;
  }

  private mapApiError(errors: string[], creds: Credentials) {
    const text = this.sanitize(errors.join('; '), creds);
    const has = (re: RegExp) => errors.some((e) => re.test(e));
    if (has(/^EAPI:Rate limit|^EService:Throttled/)) {
      return new ExchangeRateLimitError(`Kraken: ${text}`);
    }
    if (has(/^EAPI:Invalid (key|signature)|^EGeneral:Permission denied/)) {
      return new ExchangeAuthError(`Kraken: ${text}`);
    }
    if (has(/^EAPI:Invalid nonce|^EService:(Unavailable|Busy)/)) {
      return new ExchangeNetworkError(`Kraken: ${text}`);
    }
    return new ExchangeNetworkError(
      `Kraken error: ${text}`,
      'The exchange reported an error. Check the connection and try again.',
      false,
    );
  }

  private schemaError(message: string, raw: unknown) {
    return new ExchangeSchemaError(message, redactSecrets(raw));
  }

  /** Strip credentials from text and bound its length. */
  private sanitize(text: unknown, creds: Credentials): string {
    return sanitizeText(text, [
      creds.apiKey,
      creds.apiSecret,
      creds.passphrase,
    ]);
  }
}
