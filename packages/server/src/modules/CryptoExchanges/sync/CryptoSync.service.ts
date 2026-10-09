import { createHash, randomBytes } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { raw } from 'objection';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoRawRecord } from '../models/CryptoRawRecord';
import { CryptoBalanceSnapshot } from '../models/CryptoBalanceSnapshot';
import { CryptoSyncRun } from '../models/CryptoSyncRun';
import { CryptoVault } from '../vault/CryptoVault.service';
import { AdapterRegistry } from '../adapters/AdapterRegistry';
import {
  Credentials,
  ExchangeAdapter,
  RawBalance,
  RawRecordInput,
} from '../adapters/ExchangeAdapter';
import { normalizeAsset } from '../adapters/assets';
import { decimalEquals } from '../adapters/shared';
import {
  ExchangeAuthError,
  ExchangeError,
  ExchangeNetworkError,
  ExchangeSchemaError,
  KeyHasExtraPermissionsError,
} from '../adapters/errors';
import {
  CryptoSyncKind,
  cryptoSyncLockKey,
} from '../CryptoExchanges.constants';
import { redactSecrets } from '../utils/redact';
import { computePayloadHash } from '../utils/payloadHash';
import { RateLimiter } from './RateLimiter.service';
import {
  MAX_KNOWN_ASSETS,
  extractAssetsFromPayload,
} from './extractKnownAssets';

/** Candidate rows examined per compaction call, and rows per DELETE statement. */
const SNAPSHOT_COMPACT_MAX_ROWS = 20000;
const SNAPSHOT_DELETE_CHUNK = 2000;

export const CRYPTO_SYNC_OPTIONS = 'CRYPTO_SYNC_OPTIONS';

export interface CryptoSyncOptions {
  /** History pages processed per `syncConnection` call. Default 40. */
  maxPagesPerRun?: number;
  /** Wait between looks for the in-flight run when the lock is taken. Default 100 ms. */
  lockPollMs?: number;
  /** Stop a slice (partial, cursor saved) once it has run this long. Default 7 min. */
  sliceBudgetMs?: number;
  now?: () => Date;
}

/** Result of `syncConnection`. `continuation` is not persisted. */
export type CryptoSyncResult = CryptoSyncRun & {
  /**
   * True only when more history remains (a cursor was saved), this slice made
   * progress and it was not blocked by a schema error. Queue layers re-enqueue
   * a follow-up slice only when this is true.
   */
  continuation: boolean;
};

/** Lost the sync lock (expired or taken over): abort, another worker may be running. */
class SyncLockLostError extends ExchangeNetworkError {
  constructor() {
    super(
      'Crypto sync lock lost',
      'The sync lost its lock and will retry shortly.',
    );
  }
}

const LOCK_TTL_MS = 10 * 60_000;
/** Deletes the lock only if it still holds our token. */
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Clock-skew overlap; adapters add their own, larger, overlap where needed. */
const SINCE_OVERLAP_MS = 10 * 60_000;
const INSERT_CHUNK = 200;
const KNOWN_ASSET_SCAN_PAGE = 1000;
const KNOWN_ASSET_SCAN_PAGES = 10;
const MAX_UNPARSED_BYTES = 64 * 1024;
const LOCK_POLL_ATTEMPTS = 50;
const SLICE_BUDGET_MS = 7 * 60_000;
/** Extends the lock TTL only if it still holds our token. */
const EXTEND_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const SCHEMA_DRIFT = 'SCHEMA_DRIFT';
const BLOCKED_RUNS_BEFORE_ERROR = 3;
const MAX_ERROR_DETAIL = 300;
const SCHEMA_ERROR_MESSAGE = 'Exchange response format not recognised';

type RunError = {
  name: string;
  message: string;
  retryable: boolean;
  at: string;
  code?: string;
  /**
   * Sanitized adapter message (ExchangeError only), for operators. Truncated; stored in the
   * run's errors JSON but NOT exposed by the sync-runs API (allow-list serializer).
   */
  detail?: string;
  /** Cursor the schema error occurred at (SCHEMA_DRIFT only). */
  cursor?: string | null;
};
type RunState = {
  fetched: number;
  inserted: number;
  pages: number;
  errors: RunError[];
  schemaIssue: boolean;
  /** A schema error (balances or history) means the window cannot be marked complete. */
  blocked: boolean;
  /** Cursor at which history was blocked (null = start). */
  blockedCursor?: string | null;
};

@Injectable()
export class CryptoSyncService {
  private readonly logger = new Logger(CryptoSyncService.name);
  private readonly maxPagesPerRun: number;
  private readonly lockPollMs: number;
  private readonly sliceBudgetMs: number;
  private readonly now: () => Date;

  constructor(
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
    @Inject(CryptoRawRecord.name)
    private readonly rawRecordModel: TenantModelProxy<typeof CryptoRawRecord>,
    @Inject(CryptoBalanceSnapshot.name)
    private readonly snapshotModel: TenantModelProxy<
      typeof CryptoBalanceSnapshot
    >,
    @Inject(CryptoSyncRun.name)
    private readonly syncRunModel: TenantModelProxy<typeof CryptoSyncRun>,
    private readonly vault: CryptoVault,
    private readonly adapters: AdapterRegistry,
    private readonly rateLimiter: RateLimiter,
    private readonly redisService: RedisService,
    @Optional()
    @Inject(CRYPTO_SYNC_OPTIONS)
    options?: CryptoSyncOptions,
  ) {
    this.maxPagesPerRun = options?.maxPagesPerRun ?? 40;
    this.lockPollMs = options?.lockPollMs ?? 100;
    this.sliceBudgetMs = options?.sliceBudgetMs ?? SLICE_BUDGET_MS;
    this.now = options?.now ?? (() => new Date());
  }

  /**
   * Runs one bounded sync slice for a connection. Concurrent calls for the same
   * connection return the run already in flight. Retryable failures (rate limit,
   * network, unknown) are recorded on the run and re-thrown for the queue's backoff;
   * auth / extra-permission failures set the connection status to `error` and are
   * returned as a failed run (never retried).
   */
  async syncConnection(
    connectionId: number,
    kind: CryptoSyncKind,
    organizationId: string,
  ): Promise<CryptoSyncResult> {
    const connection = await this.connectionModel()
      .query()
      .findById(connectionId);
    if (!connection) {
      throw new Error(`Crypto connection ${connectionId} not found`);
    }
    if (
      connection.status === 'paused' ||
      (connection.status === 'error' && kind !== 'manual')
    ) {
      throw new ExchangeError(
        `Crypto connection ${connectionId} is ${connection.status}`,
        `This connection is ${connection.status}; syncing is not running.`,
        false,
      );
    }

    const attemptedAt = this.now();
    const redis = this.redisService.getOrThrow();
    const key = cryptoSyncLockKey(organizationId, connectionId);
    const token = randomBytes(16).toString('hex');
    const locked = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (locked !== 'OK') {
      return this.awaitInFlightRun(connectionId, attemptedAt);
    }
    const extendLock = async () => {
      const ok = await redis
        .eval(EXTEND_LOCK_LUA, 1, key, token, LOCK_TTL_MS)
        .catch(() => 0);
      if (Number(ok) !== 1) throw new SyncLockLostError();
    };
    try {
      return await this.runLocked(connection, kind, extendLock);
    } finally {
      await redis.eval(RELEASE_LOCK_LUA, 1, key, token).catch(() => undefined);
    }
  }

  /** Assets this connection currently holds (latest snapshot non-zero), sorted. */
  async heldAssets(connectionId: number): Promise<string[]> {
    const rows = await this.latestSnapshotRows(connectionId);
    return rows
      .filter((r) => isPositive(r.free) || isPositive(r.locked))
      .map((r) => r.asset)
      .sort();
  }

  /**
   * The lock is held elsewhere: return its run. A holder may finish between our
   * failed SET NX and this poll, so a run that finished since we tried also counts
   * (1 s slack: DATETIME columns truncate to whole seconds). `running` rows older
   * than the lock TTL belong to a crashed worker and are ignored.
   */
  private async awaitInFlightRun(
    connectionId: number,
    attemptedAt: Date,
  ): Promise<CryptoSyncResult> {
    for (let i = 0; i < LOCK_POLL_ATTEMPTS; i++) {
      const staleBefore = new Date(this.now().getTime() - LOCK_TTL_MS);
      const running = await this.syncRunModel()
        .query()
        .where({ connectionId, status: 'running' })
        .where('startedAt', '>=', staleBefore)
        .orderBy('id', 'desc')
        .first();
      if (running) return Object.assign(running, { continuation: false });
      const latest = await this.syncRunModel()
        .query()
        .where({ connectionId })
        .whereNot('status', 'running')
        .where('finishedAt', '>=', new Date(attemptedAt.getTime() - 1000))
        .orderBy('id', 'desc')
        .first();
      if (latest) return Object.assign(latest, { continuation: false });
      await new Promise((resolve) => setTimeout(resolve, this.lockPollMs));
    }
    throw new Error(
      `A sync for crypto connection ${connectionId} is already starting`,
    );
  }

  private async runLocked(
    connection: CryptoConnection,
    kind: CryptoSyncKind,
    extendLock: () => Promise<void>,
  ): Promise<CryptoSyncResult> {
    const startedAt = this.now();
    // Initial mode lasts until the adapter reports no further cursor, however many
    // slices that takes; `kind` only labels the run.
    const initialMode = !connection.initialSyncCompletedAt;
    const since =
      !initialMode && connection.lastSeenAt
        ? new Date(new Date(connection.lastSeenAt).getTime() - SINCE_OVERLAP_MS)
        : undefined;

    // A 'running' row we do not hold the lock for belongs to a crashed worker.
    await this.syncRunModel()
      .query()
      .where({ connectionId: connection.id, status: 'running' })
      .patch({
        status: 'failed',
        finishedAt: startedAt,
        errors: JSON.stringify([
          this.runError(
            'Interrupted',
            'Sync was interrupted.',
            true,
            startedAt,
          ),
        ]),
      });

    const run = await this.syncRunModel()
      .query()
      .insertAndFetch({
        connectionId: connection.id,
        kind,
        status: 'running',
        rangeFrom: since ?? null,
        fetchedCount: 0,
        insertedCount: 0,
        startedAt,
      });

    if (initialMode && !connection.lastSeenAt) {
      // Anchor for the first incremental window: nothing before this is missed.
      await this.patchConnection(connection.id, { lastSeenAt: startedAt });
      connection.lastSeenAt = startedAt;
    }

    const state: RunState = {
      fetched: 0,
      inserted: 0,
      pages: 0,
      errors: [],
      schemaIssue: false,
      blocked: false,
    };
    let credentials: Credentials | undefined;
    let remainingCursor: string | undefined;
    try {
      credentials = this.decryptCredentials(connection);
      const adapter = this.adapters.get(connection.exchange);

      await extendLock();
      await this.syncBalances(adapter, credentials, connection, state);
      remainingCursor = await this.syncHistory(
        adapter,
        credentials,
        connection,
        state,
        since,
        initialMode,
        startedAt,
        extendLock,
      );
    } catch (error) {
      return this.failRun(run, connection, state, error, credentials);
    }

    // Slice finished without a thrown error.
    const complete = !remainingCursor && !state.blocked;
    if (complete) {
      await this.patchConnection(connection.id, {
        syncCursor: null,
        ...(initialMode
          ? { initialSyncCompletedAt: startedAt }
          : { lastSeenAt: startedAt }),
      });
    }
    const finishedAt = this.now();
    await this.patchConnection(connection.id, {
      lastSyncAt: finishedAt,
      lastError: state.schemaIssue
        ? (state.errors[state.errors.length - 1]?.message ?? null)
        : null,
    });
    if (state.blocked) {
      await this.flipStatusAfterRepeatedDrift(connection, state);
    }
    const finished = await this.finishRun(
      run,
      state,
      complete ? 'succeeded' : 'partial',
      finishedAt,
    );
    if (!state.blocked) await this.compactQuietly(connection.id);
    return Object.assign(finished, {
      continuation:
        remainingCursor !== undefined &&
        !state.blocked &&
        (state.pages > 0 || state.fetched > 0),
    });
  }

  /**
   * A permanent schema change would otherwise retry forever. After three blocked
   * runs in a row at the same cursor the connection goes to `error` (the one
   * non-auth case that does).
   */
  private async flipStatusAfterRepeatedDrift(
    connection: CryptoConnection,
    state: RunState,
  ): Promise<void> {
    // The current run is still `running` in the table; count it as blocked.
    const previous = await this.syncRunModel()
      .query()
      .where({ connectionId: connection.id })
      .whereNot('status', 'running')
      .orderBy('id', 'desc')
      .limit(BLOCKED_RUNS_BEFORE_ERROR - 1);
    const cursor = state.blockedCursor ?? null;
    const sameBlock = (r: CryptoSyncRun) => {
      const errors = r.errors ? (JSON.parse(r.errors) as RunError[]) : [];
      return errors.some(
        (e) => e.code === SCHEMA_DRIFT && (e.cursor ?? null) === cursor,
      );
    };
    if (
      previous.length === BLOCKED_RUNS_BEFORE_ERROR - 1 &&
      previous.every(sameBlock)
    ) {
      await this.patchConnection(connection.id, {
        status: 'error',
        lastError: SCHEMA_ERROR_MESSAGE,
      });
    }
  }

  private async syncBalances(
    adapter: ExchangeAdapter,
    credentials: Credentials,
    connection: CryptoConnection,
    state: RunState,
  ): Promise<void> {
    await this.rateLimiter.acquire(adapter.id, 1);
    let balances: RawBalance[];
    try {
      balances = await adapter.fetchBalances(credentials);
    } catch (error) {
      if (error instanceof ExchangeSchemaError) {
        await this.storeUnparsed(
          connection.id,
          error,
          credentials,
          state,
          connection.syncCursor ?? null,
        );
        state.blocked = true;
        state.blockedCursor ??= connection.syncCursor ?? null;
        return;
      }
      throw error;
    }
    await this.writeSnapshot(connection.id, balances, this.now());
  }

  /** Returns the cursor still pending when the page budget ran out, if any. */
  private async syncHistory(
    adapter: ExchangeAdapter,
    credentials: Credentials,
    connection: CryptoConnection,
    state: RunState,
    since: Date | undefined,
    initialMode: boolean,
    startedAt: Date,
    extendLock: () => Promise<void>,
  ): Promise<string | undefined> {
    const knownAssets = initialMode
      ? undefined
      : await this.knownAssets(connection);
    let cursor = connection.syncCursor ?? undefined;
    const pageCost = adapter.rateLimit.historyPageCost ?? 1;

    for (let page = 0; page < this.maxPagesPerRun; page++) {
      if (
        page > 0 &&
        this.now().getTime() - startedAt.getTime() >= this.sliceBudgetMs
      ) {
        return cursor; // out of time: partial, cursor already saved
      }
      await extendLock();
      await this.rateLimiter.acquire(adapter.id, pageCost);
      let result: { records: RawRecordInput[]; nextCursor?: string };
      try {
        result = await adapter.fetchHistory(credentials, {
          since,
          cursor,
          ...(knownAssets ? { knownAssets } : {}),
        });
      } catch (error) {
        if (error instanceof ExchangeSchemaError) {
          await this.storeUnparsed(
            connection.id,
            error,
            credentials,
            state,
            cursor ?? null,
          );
          state.blocked = true;
          state.blockedCursor = cursor ?? null;
          return cursor;
        }
        throw error;
      }
      state.fetched += result.records.length;
      state.inserted += await this.insertRecords(connection.id, result.records);
      state.pages += 1;
      cursor = result.nextCursor || undefined;
      await this.patchConnection(connection.id, { syncCursor: cursor ?? null });
      if (!cursor) return undefined;
    }
    return cursor;
  }

  // ---------------------------------------------------------------- errors

  private async failRun(
    run: CryptoSyncRun,
    connection: CryptoConnection,
    state: RunState,
    error: unknown,
    credentials: Credentials | undefined,
  ): Promise<CryptoSyncResult> {
    const finishedAt = this.now();
    if (error instanceof SyncLockLostError) {
      // Another worker may own the connection now: do not touch its state.
      state.errors.push(
        this.runError(error.name, error.userMessage, true, finishedAt),
      );
      this.logger.warn(
        `Crypto sync for connection ${connection.id} lost its lock`,
      );
      await this.finishRun(run, state, 'failed', finishedAt);
      throw error;
    }
    const authFailure =
      error instanceof ExchangeAuthError ||
      error instanceof KeyHasExtraPermissionsError;
    const message =
      error instanceof ExchangeError
        ? error.userMessage
        : `Unexpected error during sync (${
            error instanceof Error ? error.name : 'unknown'
          }).`;
    // Only adapter errors (which sanitize their own messages) contribute detail; any other
    // error is logged by class name only.
    const detail =
      error instanceof ExchangeError
        ? scrub(error.message, credentials).slice(0, MAX_ERROR_DETAIL)
        : undefined;
    state.errors.push(
      this.runError(
        error instanceof Error ? error.name : 'Error',
        message,
        !authFailure,
        finishedAt,
        detail ? { detail } : {},
      ),
    );
    this.logger.warn(
      `Crypto sync for connection ${connection.id} failed: ${message}${
        detail ? ` [${(error as ExchangeError).name}: ${detail}]` : ''
      }`,
    );

    if (authFailure) {
      // Only credential problems pause syncing; the queue must not retry.
      await this.patchConnection(connection.id, {
        status: 'error',
        lastError: message,
      });
      return Object.assign(
        await this.finishRun(run, state, 'failed', finishedAt),
        { continuation: false },
      );
    }

    await this.patchConnection(connection.id, { lastError: message });
    await this.finishRun(
      run,
      state,
      state.pages > 0 ? 'partial' : 'failed',
      finishedAt,
    );
    throw this.sanitizedError(error, credentials);
  }

  private sanitizedError(error: unknown, credentials?: Credentials): unknown {
    if (error instanceof ExchangeError) return error;
    const source = error instanceof Error ? error : new Error(String(error));
    const safe = new Error(scrub(source.message, credentials));
    safe.name = source.name;
    safe.stack = scrub(source.stack ?? '', credentials);
    return safe;
  }

  private runError(
    name: string,
    message: string,
    retryable: boolean,
    at: Date,
    extra: Pick<RunError, 'code' | 'cursor' | 'detail'> = {},
  ): RunError {
    return { name, message, retryable, at: at.toISOString(), ...extra };
  }

  private async finishRun(
    run: CryptoSyncRun,
    state: RunState,
    status: 'succeeded' | 'partial' | 'failed',
    finishedAt: Date,
  ): Promise<CryptoSyncRun> {
    await this.syncRunModel()
      .query()
      .findById(run.id)
      .patch({
        status,
        rangeTo: finishedAt,
        fetchedCount: state.fetched,
        insertedCount: state.inserted,
        errors: state.errors.length ? JSON.stringify(state.errors) : null,
        finishedAt,
      });
    return this.syncRunModel().query().findById(run.id);
  }

  /** Stores a schema-drift body as an `unparsed` raw record; the run becomes partial. */
  private async storeUnparsed(
    connectionId: number,
    error: ExchangeSchemaError,
    credentials: Credentials,
    state: RunState,
    cursor: string | null,
  ): Promise<void> {
    let json = scrub(
      JSON.stringify(redactSecrets(error.rawBody ?? null)) ?? 'null',
      credentials,
    );
    let body: unknown;
    if (Buffer.byteLength(json) > MAX_UNPARSED_BYTES) {
      body = json.slice(0, MAX_UNPARSED_BYTES);
    } else {
      body = JSON.parse(json);
    }
    json = JSON.stringify(body);
    const at = this.now();
    await this.insertRecords(connectionId, [
      {
        type: 'unparsed',
        exchangeRecordId: createHash('sha256').update(json).digest('hex'),
        occurredAt: at,
        payload: { parseError: true, body },
      },
    ]);
    state.schemaIssue = true;
    state.errors.push(
      this.runError(error.name, error.userMessage, false, at, {
        code: SCHEMA_DRIFT,
        cursor,
      }),
    );
  }

  // ----------------------------------------------------------- persistence

  private async patchConnection(
    id: number,
    patch: Partial<CryptoConnection>,
  ): Promise<void> {
    await this.connectionModel().query().findById(id).patch(patch);
  }

  private decryptCredentials(connection: CryptoConnection): Credentials {
    const v = connection.keyVersion;
    return {
      apiKey: this.vault.decrypt(connection.apiKeyEncrypted, v),
      apiSecret: this.vault.decrypt(connection.apiSecretEncrypted, v),
      ...(connection.passphraseEncrypted
        ? { passphrase: this.vault.decrypt(connection.passphraseEncrypted, v) }
        : {}),
    };
  }

  /**
   * Inserts the records that are new and returns how many were. Existing rows are
   * detected first (the lock makes this exact); a duplicate-key race falls back to
   * row-by-row inserts that ignore the duplicate.
   */
  private async insertRecords(
    connectionId: number,
    records: RawRecordInput[],
  ): Promise<number> {
    const unique = new Map<string, RawRecordInput>();
    for (const r of records) {
      unique.set(`${r.type}\u0000${r.exchangeRecordId}`, r);
    }
    const all = [...unique.values()];
    let inserted = 0;
    for (let i = 0; i < all.length; i += INSERT_CHUNK) {
      const chunk = all.slice(i, i + INSERT_CHUNK);
      const existing = await this.rawRecordModel()
        .query()
        .select('recordType', 'exchangeRecordId')
        .where('connectionId', connectionId)
        .whereIn(
          'exchangeRecordId',
          chunk.map((r) => r.exchangeRecordId),
        );
      const have = new Set(
        existing.map((e) => `${e.recordType}\u0000${e.exchangeRecordId}`),
      );
      const rows = chunk
        .filter((r) => !have.has(`${r.type}\u0000${r.exchangeRecordId}`))
        .map((r) => ({
          connectionId,
          recordType: r.type,
          exchangeRecordId: r.exchangeRecordId,
          occurredAt: r.occurredAt,
          // Written through knex, which does not serialize JSON columns for us.
          payload: JSON.stringify(r.payload),
          payloadHash: computePayloadHash(r.payload),
        }));
      if (!rows.length) continue;
      try {
        await this.insertRows(this.rawRecordModel(), rows);
        inserted += rows.length;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        for (const row of rows) {
          try {
            await this.insertRows(this.rawRecordModel(), [row]);
            inserted += 1;
          } catch (rowError) {
            if (!isDuplicateKey(rowError)) throw rowError;
          }
        }
      }
    }
    return inserted;
  }

  /**
   * Multi-row insert. Objection's `insert([...])` only supports batches on Postgres
   * and SQL Server, so MySQL goes through the model's bound knex, whose column-name
   * mapper converts the camelCase keys.
   */
  private async insertRows(
    model: typeof CryptoRawRecord | typeof CryptoBalanceSnapshot,
    rows: object[],
  ): Promise<void> {
    await model.knex()(model.tableName).insert(rows);
  }

  // -------------------------------------------------------------- balances

  /** Latest snapshot row per asset for the connection. */
  private async latestSnapshotRows(
    connectionId: number,
  ): Promise<CryptoBalanceSnapshot[]> {
    return this.snapshotModel()
      .query()
      .whereIn(
        'id',
        this.snapshotModel()
          .query()
          .select(raw('max(id)'))
          .where('connectionId', connectionId)
          .groupBy('asset'),
      );
  }

  /**
   * Writes balance changes only (write-on-change). A non-zero balance gets a row
   * when it has no previous row or its free or locked amount differs numerically
   * from the latest stored row. An asset whose latest stored row was non-zero and
   * that is now zero or absent gets a single zero row so dashboards clear it.
   * Readers only use the latest row per (connection, asset), so unchanged
   * balances need no new row. Note that a row's `capturedAt` is therefore the
   * time the balance last CHANGED, not the time of the last sync.
   */
  private async writeSnapshot(
    connectionId: number,
    balances: RawBalance[],
    capturedAt: Date,
  ): Promise<void> {
    const previous = await this.latestSnapshotRows(connectionId);
    const latest = new Map(previous.map((p) => [p.asset, p]));
    const rows: Array<Partial<CryptoBalanceSnapshot>> = [];
    const written = new Set<string>();
    for (const b of balances) {
      if (isPositive(b.free) || isPositive(b.locked)) {
        written.add(b.asset);
        const last = latest.get(b.asset);
        if (
          last &&
          decimalEquals(last.free, b.free) &&
          decimalEquals(last.locked, b.locked)
        ) {
          continue;
        }
        rows.push({
          connectionId,
          asset: b.asset,
          free: b.free,
          locked: b.locked,
          capturedAt,
        });
      }
    }
    for (const p of previous) {
      if (
        (isPositive(p.free) || isPositive(p.locked)) &&
        !written.has(p.asset)
      ) {
        rows.push({
          connectionId,
          asset: p.asset,
          free: '0',
          locked: '0',
          capturedAt,
        });
      }
    }
    if (rows.length) {
      await this.insertRows(this.snapshotModel(), rows);
    }
  }

  /**
   * Lossless compaction of one connection's snapshot history. Deletes a row iff
   *   (a) it is NOT the highest id of its (connection_id, asset) pair, AND
   *   (b) the row immediately before it in that pair (by id) has exactly the same
   *       free AND locked values.
   * So the latest row of every pair is never deleted, and any row that starts a
   * new value (differs from its predecessor) is never deleted: the value history
   * (every change point) is preserved. Idempotent. Bounded: at most
   * SNAPSHOT_COMPACT_MAX_ROWS candidates per call, deleted in id chunks.
   * Returns the number of rows deleted.
   */
  async compactSnapshots(connectionId: number): Promise<number> {
    const knex = this.snapshotModel().knex();
    const table = this.snapshotModel().tableName;
    const [result] = await knex.raw(
      `SELECT id FROM (
         SELECT id, free, locked,
                LAG(free) OVER w AS prev_free,
                LAG(locked) OVER w AS prev_locked,
                MAX(id) OVER (PARTITION BY asset) AS max_id
           FROM ?? WHERE connection_id = ?
         WINDOW w AS (PARTITION BY asset ORDER BY id)
       ) s
       WHERE id < max_id AND prev_free = free AND prev_locked = locked
       ORDER BY id
       LIMIT ?`,
      [table, connectionId, SNAPSHOT_COMPACT_MAX_ROWS],
    );
    const ids: number[] = (result as Array<{ id: number }>).map((r) => r.id);
    let deleted = 0;
    for (let i = 0; i < ids.length; i += SNAPSHOT_DELETE_CHUNK) {
      const chunk = ids.slice(i, i + SNAPSHOT_DELETE_CHUNK);
      deleted += await knex(table)
        .where('connection_id', connectionId)
        .whereIn('id', chunk)
        .delete();
    }
    return deleted;
  }

  /** Best effort: a compaction failure must never fail or flip a sync. */
  private async compactQuietly(connectionId: number): Promise<void> {
    try {
      await this.compactSnapshots(connectionId);
    } catch (error) {
      this.logger.warn(
        `Snapshot compaction failed for connection ${connectionId}: ${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
    }
  }

  /**
   * Assets the adapter may use to discover history it would not find from current
   * balances: every asset ever snapshotted plus the asset / coin / commissionAsset
   * fields of the most recent stored raw records. Bounded by
   * KNOWN_ASSET_SCAN_PAGES * KNOWN_ASSET_SCAN_PAGE rows and MAX_KNOWN_ASSETS symbols.
   */
  private async knownAssets(connection: CryptoConnection): Promise<string[]> {
    const found = new Set<string>();
    const snapshotAssets = await this.snapshotModel()
      .query()
      .distinct('asset')
      .where('connectionId', connection.id)
      .limit(MAX_KNOWN_ASSETS);
    for (const row of snapshotAssets) found.add(row.asset.toUpperCase());

    let beforeId: number | undefined;
    for (let page = 0; page < KNOWN_ASSET_SCAN_PAGES; page++) {
      const rows = await this.rawRecordModel()
        .query()
        .select('id', 'payload')
        .where('connectionId', connection.id)
        .whereNot('recordType', 'unparsed')
        .modify((q) => {
          if (beforeId !== undefined) q.where('id', '<', beforeId);
        })
        .orderBy('id', 'desc')
        .limit(KNOWN_ASSET_SCAN_PAGE);
      for (const row of rows) extractAssetsFromPayload(row.payload, found);
      if (
        rows.length < KNOWN_ASSET_SCAN_PAGE ||
        found.size >= MAX_KNOWN_ASSETS
      ) {
        break;
      }
      beforeId = rows[rows.length - 1].id;
    }

    return [
      ...new Set([...found].map((a) => normalizeAsset(connection.exchange, a))),
    ]
      .sort()
      .slice(0, MAX_KNOWN_ASSETS);
  }
}

function isPositive(value: string | number | undefined | null): boolean {
  return Number(value) > 0;
}

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: string; nativeError?: { code?: string } };
  return e?.code === 'ER_DUP_ENTRY' || e?.nativeError?.code === 'ER_DUP_ENTRY';
}

/** Replaces every occurrence of a credential value (raw or JSON-escaped). */
function scrub(text: string, credentials?: Credentials): string {
  if (!credentials) return text;
  let out = text;
  for (const secret of [
    credentials.apiKey,
    credentials.apiSecret,
    credentials.passphrase,
  ]) {
    if (!secret) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const variant of new Set([secret, escaped])) {
      out = out.split(variant).join('[REDACTED]');
    }
  }
  return out;
}
