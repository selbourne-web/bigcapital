# Crypto Exchange Connectors (Piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Kraken and Binance by read-only API key, sync balances and full raw history per connection, map each connection to a Chart-of-Accounts asset account, and show live-valued per-exchange balances on the dashboard.

**Architecture:** Three NestJS modules under `packages/server/src/modules/`: tenant-scoped `CryptoExchanges` (connections, vault, adapters, BullMQ sync, REST), global `CryptoPrices` (public ticker feeds, cache, failover), and `CryptoLive` (authenticated Socket.IO namespace `/crypto`). Patterned on `BankingPlaid`. Webapp adds query hooks, a price store fed by the socket, a connections preferences page and a dashboard widget.

**Tech Stack:** NestJS 10, objection/knex (tenant migrations), BullMQ via `@nestjs/bullmq`, ioredis via `@liaoliaots/nestjs-redis`, socket.io, Node built-in `crypto` and global `WebSocket`/`fetch` (Node 22), jest; webapp React + Blueprint + visx + `@tanstack/react-query` + `socket.io-client`.

**Spec:** `docs/superpowers/specs/2026-10-04-crypto-connectors-design.md`

## Global Constraints

- Read-only API keys only; a key with trade, withdraw or transfer rights is rejected and nothing is stored.
- Secrets: AES-256-GCM with dedicated `CRYPTO_ENCRYPTION_KEY` (32 raw bytes, base64), required at boot, stored with a key version; API never returns secrets (key hint = last 4 chars only); never logged.
- No new npm dependencies (Node `crypto`, global `fetch`, global `WebSocket`, existing socket.io/bullmq/jose).
- Raw records are append-only; unique (connection_id, record_type, exchange_record_id).
- Incremental sync every 5 minutes by default, with an overlap window; auth failure sets status `error` and is never retried.
- Price precedence Kraken > Binance > Crypto.com; failover after 30 s of silence; each price carries `source` and `asOf`; ticks throttled to about 1/s per asset; USD quote.
- Balances never travel over a socket; `/crypto` handshake validates the same JWT (HS384, `JWT_ISSUER`, `JWT_AUDIENCE`) and organization id as REST; CORS restricted to the app origin (not `*`); a tenant joins only its own room.
- Each connection maps to exactly one asset account (valued in base currency BBD); mapping nullable until set; the same account cannot be mapped to two connections.
- Existing `modules/Socket/Socket.gateway.ts` is not reused or modified.
- Chart code follows bklit-ui conventions on the existing visx kit (`src/components/Charts/`); note the adaptation (no Tailwind, Node 22 + Blueprint/SCSS) in the task log.
- Environment: `nvm use 22`; installs via `npx -y pnpm@9.15.9`; run eslint on changed webapp files before committing; run ONE heavy WSL job at a time (jest, tsc, dev servers are not run concurrently).
- Commits: only with the owner's OK; the pre-commit hook runs `git add -A`, so split commits with `git stash push -- <files>`. The owner's `.claude/` docs dir stays uncommitted unless asked.

## Review Focus

- A pasted key or secret with surrounding whitespace/newlines, or a Kraken key with extra rights (see Task 3 note on permission introspection) must be trimmed and still rejected correctly (Tasks 3, 7).
- Two syncs of the same connection racing (manual "Sync now" during a scheduled run) must not reuse a nonce or double-write (Task 6).
- Deleting the mapped Chart-of-Accounts account while a connection points at it must be blocked with a clear message, not orphan the connection (Tasks 2, 7).
- Exchange-specific asset symbols (Kraken `XBT`, `XXBT`, `ZUSD`, staked `.S` suffixes) must normalize so prices and balances match (Task 3).
- A socket whose JWT expires mid-session, or that asks for another organization's room, must be disconnected without leaking data (Task 11).

---

### Task 1: Config, vault and secret redaction

**Files:**
- Create: `packages/server/src/common/config/crypto.ts`, `packages/server/src/modules/CryptoExchanges/vault/CryptoVault.service.ts`, `.../vault/CryptoVault.service.spec.ts`, `packages/server/src/modules/CryptoExchanges/utils/redact.ts`, `.../utils/redact.spec.ts`
- Modify: `packages/server/src/common/config/index.ts` (register `crypto`), `.env.example` (document `CRYPTO_ENCRYPTION_KEY`, `CRYPTO_SYNC_INTERVAL_MS`, `CRYPTO_ALLOWED_ORIGIN`)

**Interfaces:**
- Produces: `CryptoVault.encrypt(plain: string): { value: string; keyVersion: number }`, `decrypt(value: string, keyVersion: number): string`; `redactSecrets<T>(input: T): T` (deep copy replacing values of keys matching `/key|secret|passphrase|signature|token|authorization/i` with `'[REDACTED]'`); config namespace `crypto` = `{ encryptionKeys: Record<number,string>, currentKeyVersion: number, syncIntervalMs: number, allowedOrigin: string }`.

- [ ] **Step 1: Write failing tests** `CryptoVault.service.spec.ts`: round-trips a secret; two encryptions of the same input differ; decrypt with wrong key version throws; construction throws when `CRYPTO_ENCRYPTION_KEY` is empty or not 32 bytes. `redact.spec.ts`: nested object with `apiSecret`, `Authorization`, `passphrase` is redacted, non-secret fields untouched, input not mutated.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/vault src/modules/CryptoExchanges/utils` in `packages/server`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the vault by reusing the AES-256-GCM scheme of `Auth/mfa/mfa-secret-crypto.ts` (import `encryptSecret`/`decryptSecret`; key version 1 from `CRYPTO_ENCRYPTION_KEY`); `redactSecrets` as a recursive walker; config via `registerAs('crypto', ...)` like `microsoft-sso.ts`, fail-fast message mirroring the MFA key error.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): crypto vault and secret redaction`.

### Task 2: Tenant schema, models and permission subject

**Files:**
- Create: `packages/server/src/database/tenant/migrations/20261004000000_create_crypto_exchange_tables.ts`, `packages/server/src/modules/CryptoExchanges/models/{CryptoConnection,CryptoRawRecord,CryptoBalanceSnapshot,CryptoSyncRun}.ts`, `.../CryptoExchanges.constants.ts`
- Modify: `packages/server/src/modules/Roles/Roles.types.ts` (add `CryptoExchange = 'CryptoExchange'` to `AbilitySubject`), `packages/server/src/modules/Roles/AbilitySchema.ts` (add the subject with View/Create/Edit/Delete like `TaxRate`)

**Interfaces:**
- Produces: tables exactly per spec section 4 (`crypto_connections`, `crypto_raw_records`, `crypto_balance_snapshots`, `crypto_sync_runs`); `crypto_connections.account_id` nullable FK to `accounts.id` with **ON DELETE RESTRICT**, unique index on `account_id`; unique index (connection_id, record_type, exchange_record_id) on raw records; models extend `TenantBaseModel` with `tableName`; enums `CryptoExchangeId = 'kraken'|'binance'|'crypto_com'|'pionex'|'nexo'`, `CryptoConnectionStatus = 'active'|'paused'|'error'`, `CryptoRecordType = 'trade'|'deposit'|'withdrawal'|'fee'|'reward'`.

- [ ] **Step 1: Write failing test** `CryptoSchema.spec.ts` (integration, runs the migration on a scratch tenant DB the way existing migration/e2e tests do; if none exist, assert via knex `schema` introspection against the dev tenant DB behind `describe.skip` unless `TEST_TENANT_DB` set): second insert with identical (connection_id, record_type, exchange_record_id) violates the unique index; deleting a mapped account is rejected by the FK; two connections with the same `account_id` are rejected.
- [ ] **Step 2: Run** the spec. Expected: FAIL (tables missing).
- [ ] **Step 3: Implement** migration (CJS `exports.up/down` style as in `20261001000000_add_tax_rate_to_expenses.ts`; payload column `json`; `payload_hash` char(64); money/quantity columns `decimal(36,18)`), models, enum additions.
- [ ] **Step 4: Run** the spec and `npx tsc --noEmit -p packages/server`. Expected: PASS, 0 errors. Apply to the dev tenant DB only on owner OK.
- [ ] **Step 5: Commit** `feat(server): crypto exchange tenant schema and models`.

### Task 3: Adapter contract and Kraken adapter

**Files:**
- Create: `packages/server/src/modules/CryptoExchanges/adapters/ExchangeAdapter.ts`, `.../adapters/errors.ts`, `.../adapters/assets.ts`, `.../adapters/kraken/{KrakenAdapter.ts,kraken.signing.ts,KrakenAdapter.spec.ts,kraken.signing.spec.ts}`, `.../adapters/kraken/__fixtures__/*.json`

**Interfaces:**
- Produces:
  - `interface ExchangeAdapter { readonly id: CryptoExchangeId; readonly rateLimit: { capacity: number; refillPerSec: number }; inspectKey(c: Credentials): Promise<KeyInspection>; fetchBalances(c: Credentials): Promise<RawBalance[]>; fetchHistory(c: Credentials, q: { since?: Date; cursor?: string }): Promise<{ records: RawRecordInput[]; nextCursor?: string }> }`
  - `type Credentials = { apiKey: string; apiSecret: string; passphrase?: string }` (all adapters `trim()` inputs first)
  - `type KeyInspection = { readOnly: boolean | 'unverifiable'; permissions: string[] }`
  - `type RawBalance = { asset: string; free: string; locked: string }` (decimal strings; asset already normalized); `type RawRecordInput = { type: CryptoRecordType; exchangeRecordId: string; occurredAt: Date; payload: unknown }`
  - Error classes in `errors.ts`: `ExchangeAuthError`, `ExchangeRateLimitError`, `ExchangeNetworkError`, `ExchangeSchemaError`, `KeyHasExtraPermissionsError` (each with `userMessage`, `retryable`).
  - `normalizeAsset(exchange: CryptoExchangeId, raw: string): string` in `assets.ts` (Kraken `XBT/XXBT -> BTC`, `ZUSD -> USD`, `XETH -> ETH`, strips `.S`/`.M` staking suffixes into the base asset).
  - `signKraken(path: string, nonce: string, body: string, secretB64: string): string`.

- [ ] **Step 1: Research (required, before coding):** read Kraken's current official REST docs for private endpoints (Balance, TradesHistory, Ledgers) and for any API-key permission introspection. Record findings in the task log. If Kraken exposes no permission introspection, `inspectKey` returns `{ readOnly: 'unverifiable', permissions: [] }` and the adapter must never call a state-changing endpoint; Task 7 then requires an explicit "I confirm this key is read-only" attestation. Do not guess endpoint shapes; copy fixture shapes from the docs' examples.
- [ ] **Step 2: Write failing tests:** `kraken.signing.spec.ts` asserts `signKraken` equals the signature in Kraken's published example (inputs and expected output copied from the docs); `KrakenAdapter.spec.ts` (injected `fetch` returning fixtures) asserts: keys with whitespace are trimmed; `fetchBalances` returns normalized assets (`XXBT` -> `BTC`) and drops zero balances; `fetchHistory` maps trades and ledger entries (deposit, withdrawal, fee, staking reward) to `RawRecordInput` with stable `exchangeRecordId`, returns `nextCursor` until exhausted; HTTP 429 -> `ExchangeRateLimitError`; `EAPI:Invalid key` -> `ExchangeAuthError`; unexpected shape -> `ExchangeSchemaError` that still carries the raw body for storage; nonce strictly increases across calls.
- [ ] **Step 3: Run** `npx jest src/modules/CryptoExchanges/adapters`. Expected: FAIL.
- [ ] **Step 4: Implement** adapter with injected `fetch` (default global), monotonic nonce generator, host fixed in the class (`https://api.kraken.com`), request bodies and responses passed through `redactSecrets` before any logging.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): exchange adapter contract and Kraken adapter`.

### Task 4: Binance adapter

**Files:**
- Create: `.../adapters/binance/{BinanceAdapter.ts,binance.signing.ts,BinanceAdapter.spec.ts,binance.signing.spec.ts}`, `.../adapters/binance/__fixtures__/*.json`

**Interfaces:**
- Consumes: Task 3 `ExchangeAdapter`, `Credentials`, errors, `normalizeAsset`.
- Produces: `class BinanceAdapter implements ExchangeAdapter`; `signBinance(queryString: string, secret: string): string` (HMAC-SHA256 hex).

- [ ] **Step 1: Research (required):** read Binance's current official docs for signed requests, `GET /sapi/v1/account/apiRestrictions` (permission flags), account balances, trade history (symbol-scoped), deposit and withdrawal history (time-window limits), dust/earn endpoints. Record findings in the task log; copy fixtures from the docs' examples.
- [ ] **Step 2: Write failing tests:** `binance.signing.spec.ts` asserts the HMAC against the docs' published example; `BinanceAdapter.spec.ts` asserts: `inspectKey` returns `readOnly:false` and lists permissions when withdrawals or trading are enabled, `readOnly:true` otherwise; balances parse `free`/`locked` and drop zero rows; history iterates the symbols that have balances or prior trades and the docs' maximum time window per request, producing `deposit`/`withdrawal`/`trade`/`fee` records with stable ids; `timestamp` and `recvWindow` are included; 429/418 -> `ExchangeRateLimitError`; -2015/-2014 -> `ExchangeAuthError`.
- [ ] **Step 3: Run** `npx jest src/modules/CryptoExchanges/adapters/binance`. Expected: FAIL.
- [ ] **Step 4: Implement** with host fixed (`https://api.binance.com`), injected `fetch`, API key sent only in the `X-MBX-APIKEY` header.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): Binance adapter`.

### Task 5: Rate limiter and adapter registry

**Files:**
- Create: `.../sync/RateLimiter.service.ts`, `.../sync/RateLimiter.service.spec.ts`, `.../adapters/AdapterRegistry.ts`, `.../adapters/AdapterRegistry.spec.ts`

**Interfaces:**
- Produces: `RateLimiter.acquire(exchange: CryptoExchangeId, cost = 1): Promise<void>` (Redis token bucket via `RedisService`, shared across tenants, waits or throws `ExchangeRateLimitError` after a max wait of 30 s); `AdapterRegistry.get(exchange: CryptoExchangeId): ExchangeAdapter` (throws for unsupported ids).

- [ ] **Step 1: Write failing tests:** with a fake Redis (ioredis-mock if already in the repo, else an in-memory stub implementing the two commands used) the bucket allows `capacity` immediate acquires then delays by `1/refillPerSec`; two concurrent callers never exceed capacity; registry returns Kraken and Binance and throws `Unsupported exchange: nexo` for the others.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/sync/RateLimiter src/modules/CryptoExchanges/adapters/AdapterRegistry`. Expected: FAIL.
- [ ] **Step 3: Implement** bucket with one Lua script (atomic refill and take); registry as an `@Injectable` map.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): crypto rate limiter and adapter registry`.

### Task 6: Sync service

**Files:**
- Create: `.../sync/CryptoSync.service.ts`, `.../sync/CryptoSync.service.spec.ts`

**Interfaces:**
- Consumes: `AdapterRegistry`, `RateLimiter`, `CryptoVault`, tenant models (Task 2), errors (Task 3).
- Produces: `CryptoSyncService.syncConnection(connectionId: number, kind: 'initial'|'incremental'|'manual'): Promise<CryptoSyncRun>`. Behavior: takes a per-connection Redis lock (`crypto:sync:lock:<id>`, TTL 10 min) so concurrent calls return the in-flight run instead of starting another; decrypts credentials only inside the call; creates a `crypto_sync_runs` row; writes balance snapshot; pages history from the saved cursor (initial) or from `last_seen - overlap` (incremental, overlap 10 min); inserts raw records with `INSERT ... ON CONFLICT/IGNORE` so re-syncs are idempotent; on `ExchangeAuthError` sets status `error`, stores sanitized `last_error`, does not retry; on `ExchangeSchemaError` still stores the raw body as a record flagged `payload.parseError = true`; returns counts. Also exposes `heldAssets(): Promise<string[]>` used by Task 8.

- [ ] **Step 1: Write failing tests** with a stub adapter and in-memory/test-DB models: (a) second sync with overlapping records inserts 0 new rows; (b) initial sync interrupted after page 2 resumes from the saved cursor, not page 1; (c) auth error -> status `error`, run row `failed`, no second attempt; (d) schema error stores the raw record and the run is `partial`; (e) two simultaneous `syncConnection` calls produce one adapter call sequence and one run; (f) credentials never appear in `last_error` or run errors (assert redaction); (g) zero balances produce no snapshot rows, and an asset that drops to zero writes one zero row so the dashboard clears it.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/sync/CryptoSync`. Expected: FAIL.
- [ ] **Step 3: Implement** `CryptoSyncService` as an `@Injectable` using `TenantModelProxy` injection (`@Inject(CryptoConnection.name)`), as `PlaidItemService` does.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): crypto sync service`.

### Task 7: Connection commands

**Files:**
- Create: `.../commands/{CreateCryptoConnection,UpdateCryptoConnection,RotateCryptoCredentials,DeleteCryptoConnection}.service.ts` and `.spec.ts` for each, `.../dtos/{CreateCryptoConnection,UpdateCryptoConnection,RotateCredentials}.dto.ts`, `.../CryptoExchanges.events.ts`

**Interfaces:**
- Consumes: vault, `AdapterRegistry`, `CreateAccountService` (`modules/Accounts/CreateAccount.service.ts`), `UnitOfWork`, `AuditLogService.record`.
- Produces: `CreateCryptoConnectionService.execute(dto: CreateCryptoConnectionDto): Promise<CryptoConnectionView>` where the DTO has `exchange`, `label`, `apiKey`, `apiSecret`, `passphrase?`, `accountId?`, `createAccount?`, `attestReadOnly?` (exactly one of `accountId`/`createAccount`/neither; validated with class-validator); `CryptoConnectionView` (never contains secrets; has `keyHint`, `status`, `accountId`, `lastSyncAt`); events `crypto.connection.created|paused|resumed|deleted|credentials-rotated` consumed by Task 8 and audit.

- [ ] **Step 1: Write failing tests:** key with `readOnly:false` -> `KeyHasExtraPermissionsError`, nothing stored; `readOnly:'unverifiable'` without `attestReadOnly` -> rejected, with it -> accepted; key/secret with whitespace trimmed; `accountId` pointing at a non-asset, already-mapped or other-currency account -> rejected; `createAccount:true` creates an asset account named after the label via `CreateAccountService` in the same transaction, and a failure after creation rolls back the account too; both `accountId` and `createAccount` -> validation error; update can set/change `accountId`; rotate re-runs `inspectKey` and keeps the old credentials on failure; delete keeps raw records unless `deleteData: true`; every command writes an audit row with no secret in metadata; deleting the mapped account via the Accounts module surfaces a friendly "mapped to crypto connection <label>" error (catch FK violation in `DeleteAccount.service.ts` or its validator).
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/commands`. Expected: FAIL.
- [ ] **Step 3: Implement** the four services and the small guard in `modules/Accounts` so account deletion with a mapping is blocked with a `ServiceError`.
- [ ] **Step 4: Run** the same command plus `npx jest src/modules/Accounts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): crypto connection commands with account mapping`.

### Task 8: Queue, scheduler, processor and held-assets set

**Files:**
- Create: `.../sync/{CryptoSync.processor.ts,CryptoSync.scheduler.ts,CryptoSync.processor.spec.ts,CryptoSync.scheduler.spec.ts}`, `.../CryptoExchanges.types.ts`

**Interfaces:**
- Produces: queue names `crypto-sync-kraken`, `crypto-sync-binance` (constants in `CryptoExchanges.constants.ts`); job payload `{ connectionId: number; organizationId: string; kind: 'initial'|'incremental'|'manual' }`; `CryptoSyncScheduler.schedule(connection)`, `.unschedule(connectionId)` (BullMQ repeatable job `jobId: crypto-sync:<id>`, every `crypto.syncIntervalMs`, default 300000) invoked by the Task 7 events; processor sets `clsService.organizationId` and the active system user like `SetupPlaidItemTenantService`, runs `syncConnection`, then adds the connection's assets to Redis set `crypto:held-assets` (refresh TTL 24 h) and calls `CryptoLiveEmitter.connectionSynced(organizationId, connectionId, status)`.
- `interface CryptoLiveEmitter { connectionSynced(organizationId: string, connectionId: number, status: string): void }` (implemented in Task 11; a no-op provider is used until then).

- [ ] **Step 1: Write failing tests:** creating a connection enqueues one `initial` job and registers a repeatable `incremental` with the configured interval; pausing or deleting removes the repeatable; the processor sets tenant context before calling the sync service, does not retry on `ExchangeAuthError` (job completes as failed-final), retries with exponential backoff on `ExchangeRateLimitError`/network errors (`attempts: 5`, `backoff: { type: 'exponential', delay: 30000 }`); after a successful run the held-assets set contains the asset symbols and the emitter is called with ids/status only.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/sync`. Expected: FAIL.
- [ ] **Step 3: Implement** following `BankingPlaid.module.ts` / `PlaidFetchTransactionsJob.ts` (`BullModule.registerQueue`, `BullBoardModule.forFeature`, `@Processor`, `WorkerHost`, `@UseCls`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): crypto sync queues and scheduler`.

### Task 9: REST controller and module wiring

**Files:**
- Create: `.../CryptoExchanges.controller.ts`, `.../CryptoExchanges.controller.spec.ts`, `.../CryptoExchanges.module.ts`, `.../queries/{GetCryptoConnections,GetCryptoBalances,GetCryptoSyncRuns}.service.ts`
- Modify: `packages/server/src/modules/App/App.module.ts` (import `CryptoExchangesModule`)

**Interfaces:**
- Produces REST under `/api/crypto` exactly per spec section 7, each handler `@RequirePermission(RoleAction.<View|Create|Edit|Delete>, AbilitySubject.CryptoExchange)`; `GET /balances` returns `{ connections: [{ connectionId, accountId, balances: [{ asset, free, locked }] , capturedAt }] }` from the latest snapshot per (connection, asset); `POST /connections/:id/sync` rate-limited to 1 per 60 s per connection (429 with `Retry-After`).

- [ ] **Step 1: Write failing tests** (Nest testing module with the services mocked): each route requires the permission; responses never contain `apiKey`/`apiSecret`/ciphertext fields (assert on serialized JSON); manual sync twice within 60 s -> second is 429; `GET /balances` returns the latest snapshot per asset; unmapped connection is returned with `accountId: null`.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoExchanges/CryptoExchanges.controller`. Expected: FAIL.
- [ ] **Step 3: Implement** controller with Swagger decorators like `BankingPlaid.controller.ts`; module imports `TenancyModule`, `AccountsModule`, `AuditLogs` module, the BullMQ queues; `RegisterTenancyModel` for the four models.
- [ ] **Step 4: Run** the same command, then `npx tsc --noEmit -p packages/server` and boot check (`pnpm --filter @bigcapital/server dev` shows the routes registered, no DI errors). Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat(server): crypto exchanges REST API`.

### Task 10: Price service

**Files:**
- Create: `packages/server/src/modules/CryptoPrices/{CryptoPrices.module.ts,PriceCache.service.ts,PriceSelector.ts,PriceSelector.spec.ts,PriceFeedManager.service.ts,PriceFeedManager.spec.ts,feeds/{PriceFeed.ts,KrakenTickerFeed.ts,BinanceTickerFeed.ts,CryptoComTickerFeed.ts,feeds.spec.ts,__fixtures__/*.json}}`

**Interfaces:**
- Produces: `interface PriceFeed { readonly source: 'kraken'|'binance'|'crypto_com'; start(onTick: (t: SourceTick) => void): void; subscribe(assets: string[]): void; stop(): void }`; `type SourceTick = { asset: string; usd: number; change24hPct?: number; source: PriceFeed['source']; asOf: number }`; `selectPrice(ticks: Partial<Record<Source, SourceTick>>, now: number): PriceQuote | undefined` (precedence Kraken > Binance > Crypto.com, skips a source silent > 30 000 ms, returns `{ asset, usd, source, asOf, stale: boolean }`, `stale` true when every source is silent but a last value exists); `PriceCache.get(asset)`, `.set(quote)`, `.all()` (memory plus Redis mirror); `PriceFeedManager` reconciles subscriptions every 60 s against Redis set `crypto:held-assets` and reconnects feeds with jittered exponential backoff; `PriceFeedManager.onQuote(cb: (q: PriceQuote) => void)`.

- [ ] **Step 1: Research (required):** confirm current public WebSocket ticker endpoints and message formats for Kraken, Binance and Crypto.com from official docs; copy sample messages into fixtures.
- [ ] **Step 2: Write failing tests:** `PriceSelector.spec.ts`: Kraken wins when fresh; Binance used when Kraken is 31 s old; Crypto.com used when both older; all silent -> last value with `stale: true`; unknown asset -> undefined. `feeds.spec.ts`: each feed parses its fixture into a `SourceTick` with normalized asset (`XBT` -> `BTC`) and USD price, ignores heartbeat/subscription-ack messages, ignores malformed JSON without throwing. `PriceFeedManager.spec.ts` (fake feeds and timers): only held assets are subscribed; removing an asset unsubscribes; a feed that closes is restarted after a jittered delay; quotes are emitted through `onQuote`.
- [ ] **Step 3: Run** `npx jest src/modules/CryptoPrices`. Expected: FAIL.
- [ ] **Step 4: Implement** feeds with the injectable `webSocketFactory = (url) => new WebSocket(url)` (global Node 22 `WebSocket`; no `ws` dependency).
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): crypto price feeds and failover`.

### Task 11: Live gateway

**Files:**
- Create: `packages/server/src/modules/CryptoLive/{CryptoLive.module.ts,CryptoLive.gateway.ts,CryptoLiveAuth.service.ts,PriceThrottle.ts,CryptoLive.gateway.spec.ts,PriceThrottle.spec.ts}`
- Modify: `CryptoExchanges.module.ts` (provide the real `CryptoLiveEmitter`)

**Interfaces:**
- Produces: `@WebSocketGateway({ namespace: '/crypto', path: '/socket', cors: { origin: config.crypto.allowedOrigin } })`; `CryptoLiveAuth.authenticate(token: string, organizationId: string): Promise<{ userId: number; tenantId: number }>` (verifies HS384 JWT with issuer/audience as `JwtStrategy` does, then checks the user belongs to that organization using the same system models the REST tenancy guard uses; throws otherwise); handshake carries `auth: { token, organizationId }`; on success the socket joins `prices` and `tenant:<tenantId>`; the server disconnects the socket at the token's `exp`; `createPriceThrottle(emit: (ticks: PriceQuote[]) => void, intervalMs = 1000)` coalesces to the latest quote per asset per interval; events `prices:tick` (array of quotes) and `crypto:connection-synced` `{ connectionId, status }`. No event ever carries balances.

- [ ] **Step 1: Write failing tests:** missing/invalid/expired token -> connection refused; valid token with an organization the user does not belong to -> refused; a client cannot join any `tenant:<other>` room even by emitting a join event; socket is disconnected at JWT expiry; throttle emits at most one tick per asset per interval carrying the latest value; `connectionSynced` reaches only the owning tenant's room; payloads contain no `free`/`locked`/`balance` fields.
- [ ] **Step 2: Run** `npx jest src/modules/CryptoLive`. Expected: FAIL.
- [ ] **Step 3: Implement** gateway subscribing to `PriceFeedManager.onQuote`; CORS origin from config, never `*`.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit -p packages/server`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat(server): authenticated crypto live gateway`.

### Task 12: Webapp data layer

**Files:**
- Create: `packages/webapp/src/hooks/query/crypto.ts`, `packages/webapp/src/containers/Crypto/priceStore.ts`, `packages/webapp/src/containers/Crypto/useCryptoLive.ts`, `packages/webapp/src/containers/Crypto/valuation.ts`, `packages/webapp/src/containers/Crypto/valuation.test.ts` (use the existing test runner if one exists; webapp has none, so add pure-function tests under server-style jest only if a runner is already configured, else verify through the preview route in Task 14 and say so in the task log)
- Modify: `packages/webapp/src/hooks/query/index.tsx` (export crypto hooks), `packages/webapp/src/components/Dashboard/DashboardSockets.tsx` untouched (the new socket lives in `useCryptoLive`)

**Interfaces:**
- Produces: raw-fetch hooks in the `expense-autofill.ts` style (token + organization id headers, manual snake_case mapping): `useCryptoConnections()`, `useCryptoBalances()`, `useCryptoSyncRuns(connectionId)`, `useCreateCryptoConnection()`, `useUpdateCryptoConnection()`, `useRotateCryptoCredentials()`, `useDeleteCryptoConnection()`, `useSyncCryptoConnection()`; `priceStore` with `subscribe/getSnapshot` for `useSyncExternalStore` (`usePrice(asset): PriceQuote | undefined`); `useCryptoLive(): void` connecting `io('/crypto', { path: '/socket', auth: { token, organizationId } })`, feeding `priceStore` and invalidating the connections/balances queries on `crypto:connection-synced`; `valueHoldings(balances, prices, usdToBase): { perConnection: Array<{connectionId:number; value:number; stale:boolean}>; total:number; rows: HoldingRow[] }` where `usdToBase` comes from the existing exchange-rates hook (BBD per USD from the organization's base-currency rate, falling back to the fixed 2.0 peg only when base currency is `BBD` and the rate call fails).

- [ ] **Step 1: Write failing tests (valuation):** value = quantity x USD price x `usdToBase`; assets without a price contribute 0 and are listed as `unpriced`; stale quotes mark the row stale; zero balances are omitted.
- [ ] **Step 2: Run** the test command used (see Files note). Expected: FAIL.
- [ ] **Step 3: Implement** hooks, store, socket hook and `valueHoldings`.
- [ ] **Step 4: Run** tests, `npx tsc --noEmit -p packages/webapp`, and eslint on the changed files. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `feat(webapp): crypto data layer and live price store`.

### Task 13: Connections preferences page

**Files:**
- Create: `packages/webapp/src/containers/Preferences/CryptoConnections/{CryptoConnections.tsx,AddConnectionDialog.tsx,AccountPicker.tsx,ConnectionRow.tsx,CryptoConnections.module.scss}`
- Modify: `packages/webapp/src/routes/preferences.tsx`, `packages/webapp/src/constants/preferencesMenu.tsx`

**Interfaces:**
- Consumes: Task 12 hooks; the existing accounts query hook for asset accounts.
- Produces: page at `/preferences/crypto-connections`, gated by the `CryptoExchange` View ability; Add dialog fields exchange, label, API key, API secret, optional passphrase, account picker (existing asset accounts, not already mapped, or "Create account for me"), the read-only attestation checkbox (shown only when the server replies `readOnly: 'unverifiable'`), per-exchange "how to create a read-only key" help text; secrets are `type=password` inputs cleared after submit and never stored in component state beyond the form; rows show status badge, last sync, key hint, "Account not mapped" badge, Sync now / Pause / Rotate / Delete actions; error statuses show "Reconnect".

- [ ] **Step 1: Implement** page and dialog following `Preferences/Security/Security.tsx` and `Security.module.scss` conventions (Blueprint components, existing tokens `--color-primary`, pill/28px-radius card language from `DESIGN.md`).
- [ ] **Step 2: Verify:** `npx tsc --noEmit -p packages/webapp`; eslint on changed files; Vite compiles the SCSS (curl the module with `?direct` and grep `[sass]`).
- [ ] **Step 3: Browser check via headless Edge + Playwright over CDP** (method in progress memory): mock `/api/crypto/*` routes with fixtures; assert the dialog rejects the form until label/key/secret are filled, shows the attestation checkbox only for the unverifiable response, shows the mapped/unmapped badge, and that no secret value appears in the DOM after submit. Save screenshots to the scratchpad.
- [ ] **Step 4: Commit** `feat(webapp): crypto connections preferences page`.

### Task 14: Dashboard Crypto widget and preview

**Files:**
- Create: `packages/webapp/src/containers/Homepage/dashboard/CryptoWidget.tsx`, `.../cryptoSampleData.ts`
- Modify: `.../Widgets.tsx` or `DashboardHome.tsx` (mount the widget in the grid, permission-gated), `.../DashboardPreview.tsx` (`?sample=crypto`), `.../Dashboard.scss`, `packages/webapp/DESIGN.md` (add the Crypto widget and the bklit-adaptation note)

**Interfaces:**
- Consumes: `valueHoldings`, `usePrice`, `useCryptoLive`, `WidgetCard`, `DonutChart`, `AreaLineChart` kit, `useCryptoConnections`/`useCryptoBalances`.
- Produces: `CryptoWidget` (live total with a count-up that respects `prefers-reduced-motion`, per-exchange donut, holdings table with asset/quantity/price/value/24h change, status strip with "Reconnect" and "Stale prices" badges, empty state "Connect an exchange" linking to `/preferences/crypto-connections`); price ticks update only the price store.

- [ ] **Step 1: Implement** widget and sample data (three connections, one in `error`, one stale feed, one unmapped).
- [ ] **Step 2: Verify:** tsc and eslint clean; preview route `http://localhost:4000/__preview/dashboard?sample=crypto` renders.
- [ ] **Step 3: Browser check (Playwright over CDP):** simulate socket ticks and assert the total changes without a query refetch; stale and error badges render; reduced-motion disables the count-up; the empty state renders for `?sample=empty`; no horizontal overflow at the widget's two breakpoints; screenshots to the scratchpad.
- [ ] **Step 4: Commit** `feat(webapp): crypto dashboard widget`.

### Task 15: Security review, docs and catalog

**Files:**
- Create: `.claude/docs/task-log/2026-10-04-crypto-connectors.md` (owner's docs dir; do not commit unless asked)
- Modify: `.claude/docs/project-state.md`, `docs/templates/` entry for the adapter + vault pattern (only after verification)

- [ ] **Step 1: Scans before merge:** run OWASP ZAP baseline against a staging/dev instance (documented ZAP setup on the server) focusing on `/api/crypto/*` and the `/crypto` socket origin policy; run the Cloudflare security-audit skill and Alibaba open-code-review on the changed modules; per CLAUDE.md, inspect each tool's source before first use. Record date, scan type, findings, severity, remediation or accepted risk. Do not call the feature security-ready on scan completion alone.
- [ ] **Step 2: Secret hygiene checks:** grep logs from a full sync run (fixture-backed) for the test key and secret strings: zero hits; confirm `GET /api/crypto/connections` JSON contains no secret fields; confirm the module refuses to boot without `CRYPTO_ENCRYPTION_KEY`.
- [ ] **Step 3: Full validation:** `npx jest` for the touched server modules, `npx tsc --noEmit` for server and webapp, eslint on changed webapp files, then one live pass with the owner's read-only Kraken and Binance keys placed in `.env` by the owner (never pasted in chat): add connection, initial sync, dashboard values, pause/resume, rotate. State plainly in the log anything not live-verified.
- [ ] **Step 4: Docs:** update `project-state.md` and the task log (date, objective, files, decisions including the Kraken permission-introspection finding, dependencies none, tests, security checks, limits, next step = piece 2 spec); add the template entry (purpose, dependencies, usage, limits, security notes, compatibility, review date).
- [ ] **Step 5: Update progress memory**; ask the owner before committing docs.
