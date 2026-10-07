# Crypto Connectors Piece 2a (Crypto.com Exchange + Crypto.com App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only exchange adapters, Crypto.com Exchange (`crypto_com`) and Crypto.com App (`crypto_com_app`), to the piece 1 connector framework, with the supporting server and webapp changes (attestation details, key expiry, history-coverage notice).

**Architecture:** Both adapters implement the existing `ExchangeAdapter` interface (thin, hand-written, fake-fetch tested) and are registered in `AdapterRegistry`; the sync engine, vault, rate limiter, queues, REST controller and webapp hooks are reused. `KeyInspection` gains optional `expiresAt` and `warnings`, persisted/returned so the UI can show them. Each exchange gets its own BullMQ sync queue like Kraken and Binance.

**Tech Stack:** NestJS 10, objection/knex tenant migrations, BullMQ, jest (always `--runInBand --forceExit`), React + Blueprint webapp (no test runner; verify with tsc, eslint, Vite probes, fixture-driven Playwright-over-CDP checks).

**Spec:** `docs/superpowers/specs/2026-10-06-crypto-connectors-piece2-design.md` (sections 3.1, 3.3, 4; amended 97b0d13e2). Facts: `docs/superpowers/research/2026-10-06-piece2-exchange-api-facts.md` and `2026-10-06-cryptocom-live-probe.md`. Existing adapters to copy conventions from: `packages/server/src/modules/CryptoExchanges/adapters/{kraken,binance}/`.

## Global Constraints

- Read-only only: no adapter code path may call a method that trades, converts, quotes-and-confirms, withdraws, creates, cancels, revokes or sends email. Allowed Exchange methods: `private/user-balance`, `private/get-accounts`, `private/get-trades`, `private/get-order-history`, `private/get-transactions`, `private/get-deposit-history`, `private/get-withdrawal-history`, `private/get-deposit-address` (probe only; returned addresses are discarded, never stored or logged). Allowed App calls: `GET /v1/api-keys/current`, `/v1/crypto-account`, `/v1/fiat-account`, `/v1/transactions`. Never `/v1/portfolio` for balances (overlaps the Exchange connector).
- Money: decimal strings only, no float arithmetic; Exchange deposit/withdrawal list amounts arrive as JSON numbers, convert via `String()` of the parsed number only when it is an integer-safe decimal, otherwise parse from the raw response text; never `toFixed`.
- Secrets never in logs, errors, raw records, queue payloads, fixtures or reports (use `sanitizeText` and the `redact` util; fixtures use obviously fake keys such as `TEST_KEY`/`TEST_SECRET`).
- Rate limits: Exchange `get-trades`/`get-order-history` 1 request/s, other private calls 3 per 100 ms; App HTTP 429 requires a 60 s cool-down. Declare conservative buckets; never retry inside a cool-down.
- Retention: Exchange API history is 6 months (`historyCoverage.level='partial'`); App `/v1/transactions` is effectively full (`'full'`).
- Idempotency by `exchangeRecordId`; every new Redis/queue key or job id is organization-scoped (use the helpers in `CryptoExchanges.constants.ts`).
- New migration only (no edits to existing migrations). Timestamp after `20261006000000`. Applied to dev DB via `node -r tsconfig-paths/register dist/cli.js tenants:migrate:latest` (owner step, noted in the task log).
- Tooling: every shell `source ~/.nvm/nvm.sh && nvm use 22`; jest `--runInBand --forceExit`, one heavy command at a time, check `uptime; free -m` first; never `wsl --shutdown`; LF endings; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; no push; do not stage `.claude/CLAUDE.md` (it is skip-worktree) and do not commit `.claude/docs`.
- Live checks use the owner's read-only keys from the gitignored `.env` (names `CRYPTO_COM_EXCHANGE_API_KEY/_SECRET_KEY`, `CRYPTO_COM_APP_API_KEY/_SECRET_KEY`) only inside throwaway node processes; never print values.

## Review Focus

1. Crypto.com Exchange key can withdraw but the `get-deposit-address` probe errors or is rate limited: inspection must not crash or reject; result stays `unverifiable` (no warning) and the sync still works.
2. App key with an unrecognized scope name (e.g. `loans.apply:read` is fine, `foo:write` is unknown-write): any non-`:read` scope not in the safe-write allow-list is refused; scope strings with odd case or whitespace are normalized, not trusted.
3. App key near or past `expires_at`: expiry is stored and shown; an expired/revoked key surfaces as an auth error that moves the connection to `error` with a "Reconnect" path, not a retry loop.
4. Exchange history windows: empty windows, exactly 100 records in a window (must not stop early), windows crossing the 6-month retention edge, and records identical across overlapping windows (idempotent).
5. App `/v1/transactions` with `meta.pagination.total` wrong/absent, `next` missing mid-data, ids not numeric-ordered, and enums never seen before (`status` other than `done`, new `kind`): all stored raw, none dropped or crashing; unknown shapes become `unparsed` + `SCHEMA_DRIFT` handling exactly like piece 1.

---

### Task 1: Foundation (types, constants, queues, migration, persistence, API/UI contracts)

**Files:**
- Modify: `packages/server/src/modules/CryptoExchanges/CryptoExchanges.constants.ts` (`CryptoExchangeId` add `'crypto_com_app'`; `SUPPORTED_CRYPTO_EXCHANGES` add `'crypto_com'`, `'crypto_com_app'`; `CRYPTO_SYNC_QUEUES` + `CRYPTO_SYNC_QUEUE_NAMES` add `crypto-sync-crypto_com` and `crypto-sync-crypto_com_app`)
- Modify: `adapters/ExchangeAdapter.ts`, `adapters/kraken/KrakenAdapter.ts`, `adapters/binance/BinanceAdapter.ts` (add `historyCoverage`)
- Modify: `adapters/AdapterRegistry.ts` (register new adapters once they exist: Task 1 adds the registration seam, Tasks 2 and 4 add entries)
- Create: `packages/server/src/database/tenant/migrations/20261007000000_add_key_expires_at_to_crypto_connections.ts` (JS-style `exports.up/down` like the existing crypto migrations)
- Modify: `models/CryptoConnection.ts`, `commands/CryptoConnectionView.ts`, `commands/CryptoConnectionValidators.service.ts`, `commands/CreateCryptoConnection.service.ts`, `commands/RotateCryptoCredentials.service.ts`, `queries/GetCryptoConnections.service.ts`
- Modify (tests): `CryptoExchanges.wire.spec.ts`, `CryptoExchanges.swagger.ts`, the existing adapter/registry/validator specs touched by the new interface fields
- Modify (webapp): `packages/webapp/src/hooks/query/crypto.ts` (types + snake_case mapper), `containers/Preferences/CryptoConnections/AddConnectionDialog.tsx` (exchange list, help text, attestation details), `ConnectionRow.tsx` (coverage notice, key expiry)

**Interfaces:**
- Produces (server):
  - `type HistoryCoverage = { level: 'full' | 'partial'; note?: string }`; `ExchangeAdapter.historyCoverage: HistoryCoverage` (required). Kraken: `{level:'full'}`; Binance: `{level:'full'}`.
  - `KeyInspection = { readOnly: boolean | 'unverifiable'; permissions: string[]; expiresAt?: Date; warnings?: string[]; writeScopes?: string[] }`.
  - `verifyCredentials(...)` keeps its existing return type (`Promise<Credentials>`); add `verifyCredentialsDetailed(exchange, input, attestReadOnly?) => Promise<{ credentials: Credentials; inspection: KeyInspection }>` and have `verifyCredentials` delegate to it. Create and Rotate call the detailed variant. The 422 attestation response becomes `{ code: 'ATTESTATION_REQUIRED', permissions: string[], warnings: string[] }` (extra fields only; the `code` is unchanged so the existing webapp handling keeps working).
  - Column `crypto_connections.key_expires_at` (`dateTime`, nullable); model field `keyExpiresAt: Date | null`; `CryptoConnectionView.keyExpiresAt: Date | null`; `CryptoConnectionView.historyCoverage: { level; note? }` added by `GetCryptoConnections` from `registry.get(exchange).historyCoverage`.
  - Create and Rotate persist `inspection.expiresAt ?? null` into `key_expires_at`.
- Produces (webapp): `CryptoConnection` type gains `keyExpiresAt: string | null` and `historyCoverage: {level: 'full'|'partial'; note?: string}`; `CRYPTO_EXCHANGES` entries for `crypto_com` ("Crypto.com Exchange") and `crypto_com_app` ("Crypto.com App") with help text (below).
- Consumes: existing `normalizeAsset`, `sanitizeText`, `AdapterRegistry`, `RateLimiter`, vault.

- [ ] **Step 1: Write failing tests**
  - `CryptoExchanges.constants` spec (or inline in the wire spec): `queueNameFor('crypto_com') === 'crypto-sync-crypto_com'`, `queueNameFor('crypto_com_app') === 'crypto-sync-crypto_com_app'`, `SUPPORTED_CRYPTO_EXCHANGES` contains both, and `CRYPTO_SYNC_QUEUE_NAMES` has 4 entries.
  - Validator spec: with a fake adapter returning `{readOnly:'unverifiable', permissions:['fiat.deposit:write'], warnings:['w1']}` and `attestReadOnly` absent, `verifyCredentials` throws `UnprocessableEntityException` whose response is `{code:'ATTESTATION_REQUIRED', permissions:['fiat.deposit:write'], warnings:['w1']}`; with `attestReadOnly:true` it resolves; with `readOnly:false` it throws `KeyHasExtraPermissionsError`.
  - Create/Rotate service specs: a fake adapter returning `expiresAt: new Date('2027-01-05T00:00:00Z')` leads to the persisted row/patch containing `keyExpiresAt` equal to it; absent leads to `null`.
  - View/query spec: `toConnectionView` includes `keyExpiresAt`; `GetCryptoConnections` adds `historyCoverage` from the registry (fake registry returning `{level:'partial', note:'n'}`).
  - Wire spec: snake_case output includes `key_expires_at` and `history_coverage`.
  - Integration spec addition (DB-gated, scratch DB like piece 1's): the new migration up adds a nullable `key_expires_at`; down drops it.
- [ ] **Step 2: Run the new/changed specs; expect FAIL**
- [ ] **Step 3: Implement** the items under Interfaces. The migration is additive (`alterTable ... dateTime('key_expires_at').nullable()`; `down` drops the column). Webapp help text:
  - `crypto_com`: "In Crypto.com Exchange, open Settings > API Keys and create a key with 'Can Read' only. Leave withdrawals and trading off. Crypto.com cannot confirm a key's permissions, so you will be asked to confirm the key is read-only."
  - `crypto_com_app`: "In the Crypto.com App's API key management, create a key with read-only scopes (balances and history). Keys expire (about 90 days), so Selbourne Financial shows the expiry and asks you to rotate before then."
  - The attestation block lists `permissions` and `warnings` from the 422 body when present (no secrets there). `ConnectionRow` shows "History limited: {note}. Import a CSV for older records." only when `historyCoverage.level === 'partial'` (the CSV action itself arrives in 2c: render the text without the button), and "Key expires {date}" with a warning style within 14 days of expiry or when past.
- [ ] **Step 4: Run the specs (crypto specs touched, then `CryptoExchanges` directory), `tsc --noEmit` for server and webapp, eslint on changed files, Vite probe of the changed webapp files; expect all green**
- [ ] **Step 5: Commit** `feat(server,webapp): crypto connector foundation for Crypto.com adapters`

---

### Task 2: Crypto.com Exchange adapter: signing, inspectKey, fetchBalances

**Files:**
- Create: `adapters/cryptocom/cryptocom.signing.ts`, `adapters/cryptocom/cryptocom.signing.spec.ts`, `adapters/cryptocom/CryptoComAdapter.ts`, `adapters/cryptocom/CryptoComAdapter.spec.ts`, `adapters/cryptocom/__fixtures__/{user-balance.json,deposit-address-ok.json,deposit-address-denied.json}`
- Modify: `adapters/AdapterRegistry.ts` (register `new CryptoComAdapter()`), `adapters/assets.ts` only if a Crypto.com symbol needs normalization (add a test first)

**Interfaces:**
- Produces: `export const cryptoComSign: (a: { method: string; id: number; apiKey: string; params: Record<string, unknown>; nonce: number; secret: string }) => string` returning the lower-case hex HMAC-SHA256 of `method + id + apiKey + paramString(params) + nonce`, where `paramString` concatenates keys in ascending order with values, recursing into objects and arrays with no separators (nulls as empty string per the official docs); `export class CryptoComAdapter implements ExchangeAdapter` with `id: 'crypto_com'`, `rateLimit: { capacity: 3, refillPerSec: 10, historyPageCost: 10 }` (history calls are cost 10 so `get-trades`/`get-order-history` average 1 req/s), `historyCoverage: { level: 'partial', note: 'Crypto.com Exchange API history is limited to the last 6 months.' }`, constructor `(fetchImpl = fetch, requestTimeoutMs = 30_000, now = () => Date.now())`.
- Consumes: Task 1 interface changes; `sanitizeText`, `ExchangeAuthError`, `ExchangeNetworkError`, `ExchangeRateLimitError`, `ExchangeSchemaError`; `normalizeAsset`.

- [ ] **Step 1: Write failing tests**
  - Signing: the official docs' worked example vector (copy the exact example inputs and expected signature from the Exchange docs page "Digital Signature"; the research doc links it); plus nested-params and empty-params cases.
  - `inspectKey`: (a) `get-deposit-address` returns `code:0` leads to `{readOnly:'unverifiable', permissions:['read'], warnings:[<withdrawal warning text>]}`; (b) the denied fixture (a non-zero `code`) leads to `{readOnly:'unverifiable', permissions:['read'], warnings:[]}`; (c) auth failure codes (40101/40102/40103 variants per docs) throw `ExchangeAuthError` with distinct messages for bad signature, clock skew (nonce window), and IP not allow-listed (40103); (d) a network failure throws `ExchangeNetworkError`; (e) the probe's returned addresses never appear in the result, thrown errors or logs; (f) a probe error that is not an auth error (timeout, 5xx, rate limit) does not fail `inspectKey`.
  - `fetchBalances`: `user-balance.json` fixture (fields from the live probe: `data[].position_balances[]` with `instrument_name`, `quantity`, `reserved_qty`) maps non-zero positions to `{asset, free: quantity minus reserved_qty (exact decimal), locked: reserved_qty}`; zero positions skipped; unknown shape throws `ExchangeSchemaError`; the response is parsed from text so numeric strings stay exact.
  - Redaction: a thrown error message and an `ExchangeAuthError.userMessage` never contain `TEST_KEY` or `TEST_SECRET`.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement** the signing helper and adapter following `KrakenAdapter.ts` structure (private `request(method, params, creds)` that builds `{id, method, api_key, params, nonce, sig}`, POSTs JSON to `https://api.crypto.com/exchange/v1/${method}` with `AbortSignal.timeout`, maps HTTP and `code` values to the error classes, redacts via `sanitizeText`). `redirect: 'error'`. Base URL overridable by constructor for tests only. `inspectKey` calls `private/get-deposit-address` with `{currency:'BTC'}` after a cheap auth check via `private/user-balance` (so auth errors are reported once, clearly); permissions are descriptive strings only.
- [ ] **Step 4: Run adapter specs + registry spec; tsc server; eslint; expect green**
- [ ] **Step 5: Commit** `feat(server): Crypto.com Exchange adapter (auth, key inspection, balances)`

---

### Task 3: Crypto.com Exchange adapter: fetchHistory

**Files:**
- Modify: `adapters/cryptocom/CryptoComAdapter.ts`, `adapters/cryptocom/CryptoComAdapter.spec.ts`
- Create: `adapters/cryptocom/__fixtures__/{trades-page.json,order-history-page.json,transactions-page.json,deposit-history.json,withdrawal-history.json}` (shapes from the official docs and the live-probe deposit/withdrawal lists; `trades`/`orders`/`transactions` schemas rest on docs because the probed key had none: mark the fixtures `docs-derived` in a comment)
- Modify: `adapters/AdapterRegistry.ts` only if not already registered

**Interfaces:**
- Produces: `fetchHistory(c, { since?, cursor?, knownAssets? }) => Promise<{ records: RawRecordInput[]; nextCursor?: string }>`. Cursor is an opaque JSON string `{ stream: 'trades'|'orders'|'transactions'|'deposits'|'withdrawals'; windowEnd: number /*ms*/; page?: number }`. Streams run in the fixed order above; each call returns at most one API page and one `nextCursor`; the final stream's final page returns no `nextCursor`. Record mapping: trades are `type:'trade'` with `exchangeRecordId = 'trade:'+trade_id`; order-history rows are `type:'trade'` with `exchangeRecordId = 'order:'+order_id` (all statuses kept raw, the status is in the payload); deposits `'deposit'` (`'dep:'+id`); withdrawals `'withdrawal'` (`'wd:'+id`); transactions-endpoint rows `'fee'` or `'reward'` by their documented type, else `'unparsed'`. `occurredAt` from the record's `create_time`/`update_time` (ms).
- Consumes: Task 2 `request`.

- [ ] **Step 1: Write failing tests**
  - Window walk: with `since` = now minus 14 months, the first call clamps the lower bound to now minus 6 months (the retention limit) and walks windows of 1 day (trades/orders/transactions: `start_time`/`end_time`, `limit: 100`) backwards or forwards consistently; a window returning exactly 100 records re-requests the same window with the documented continuation (use `end_time` of the oldest record) before advancing, never losing records (Review Focus 4); empty windows advance quickly (multiple empty windows per call are allowed up to a bounded page budget, then `nextCursor` is returned).
  - Deposits/withdrawals: page-number pagination (`page`, `page_size: 200`), 90-day default window respected via `start_ts`/`end_ts`; numbers-as-JSON conversions exact (fixture has amount `0.00050000` style and an integer).
  - Idempotency: the same record in two overlapping windows yields the same `exchangeRecordId`.
  - Cursor round trip is stable and rejects malformed cursors with `ExchangeSchemaError` (no crash).
  - Rate limits: history calls are issued with the adapter's declared `historyPageCost` accounting (the sync service charges it; assert the adapter exposes `historyPageCost: 10`).
  - Unknown record shapes are returned as `type:'unparsed'` records, never thrown away.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement** the streams/windows/cursor as specified. Prefer small private methods per stream; do not exceed the declared page budget per call (max 8 windows or 1 data page per call).
- [ ] **Step 4: Run adapter specs; tsc; eslint; expect green**
- [ ] **Step 5: Commit** `feat(server): Crypto.com Exchange history (windows, deposits, withdrawals)`

---

### Task 4: Crypto.com App adapter: signing, inspectKey, fetchBalances

**Files:**
- Create: `adapters/cryptocomapp/cryptocomapp.signing.ts`, `adapters/cryptocomapp/cryptocomapp.signing.spec.ts`, `adapters/cryptocomapp/CryptoComAppAdapter.ts`, `adapters/cryptocomapp/CryptoComAppAdapter.spec.ts`, `adapters/cryptocomapp/__fixtures__/{api-key-current.json,api-key-current-write.json,crypto-account.json,fiat-account.json}` (sanitized to field names/types from the live probe with fake values)
- Modify: `adapters/AdapterRegistry.ts` (register `new CryptoComAppAdapter()`)

**Interfaces:**
- Produces: `export const cryptoComAppSign: (a: { timestamp: number; method: string; path: string; body?: string; secret: string }) => string` returning base64 HMAC-SHA256 of `timestamp + METHOD.toUpperCase() + path + body` (path without query); `export class CryptoComAppAdapter implements ExchangeAdapter` with `id: 'crypto_com_app'`, `rateLimit: { capacity: 5, refillPerSec: 0.5, historyPageCost: 2 }`, `historyCoverage: { level: 'full' }`, constructor like Task 2. Request headers: `Cdc-Api-Key`, `Cdc-Api-Timestamp`, `Cdc-Api-Signature`, `User-Agent`. Base `https://wapi.crypto.com`, `redirect: 'error'`.
- Scope classification (exported pure function, tested): `classifyScopes(scopes: string[]): { readOnly: boolean | 'unverifiable'; permissions: string[]; writeScopes: string[] }`. Normalize each scope (`trim().toLowerCase()`). All end in `:read` leads to `readOnly:true`. A scope ending `:write` whose resource contains any of `withdraw`, `transfer`, `trade`, `trading`, `purchase`, `sale`, `exchange`, `convert`, `order`, `payment`, `send` leads to `readOnly:false`. Any scope not ending in `:read` or `:write` is unknown leading to `readOnly:false` (fail closed). Other `:write` scopes (such as `fiat.deposit:write`) lead to `readOnly:'unverifiable'` with `writeScopes` listed. Mixed: false beats unverifiable beats true.

- [ ] **Step 1: Write failing tests**
  - Signing: a fixed known vector computed independently in the test (documented inputs, expected base64).
  - `classifyScopes`: the probed key's scope list (`balance:read`, `fiat.bank_account:read`, `fiat.deposit:read`, `fiat.deposit:write`, `fiat.limits:read`, `fiat.withdrawal:read`, `market:read`) leads to `'unverifiable'` with `writeScopes:['fiat.deposit:write']`; all-read leads to true; `crypto.withdrawal:write` false; `foo:execute` false; `FIAT.DEPOSIT:WRITE ` (case/space) handled; empty list false (fail closed).
  - `inspectKey`: fixture `api-key-current.json` (fields: `api_key.scopes`, `status`, `expires_at`, `weekly_trading_limit_in_usd`) returns the classification plus `expiresAt` as a `Date`; `status !== 'active'` or `revoked_at` set throws `ExchangeAuthError` ("key revoked or inactive"); an expired `expires_at` in the past throws `ExchangeAuthError` ("key expired").
  - `fetchBalances`: `crypto-account.json` wallets (1955 entries in reality; fixture has 5 incl. zeros) maps non-zero wallets to `{asset: normalizeAsset(currency), free: available, locked}`; `fiat-account.json` `balances[]` (`{currency, amount}`) maps to assets with `locked:'0'`; the two sources are merged by asset with exact decimal addition (`addDecimal`); `native_balance` is ignored; unknown shape throws `ExchangeSchemaError`.
  - 429 throws `ExchangeRateLimitError` with `retryAfterSeconds: 60`; redaction test as in Task 2.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement** following the Kraken/Binance structure.
- [ ] **Step 4: Run adapter + registry specs; tsc; eslint; expect green**
- [ ] **Step 5: Commit** `feat(server): Crypto.com App adapter (auth, scope classification, balances)`

---

### Task 5: Crypto.com App adapter: fetchHistory

**Files:**
- Modify: `adapters/cryptocomapp/CryptoComAppAdapter.ts`, `adapters/cryptocomapp/CryptoComAppAdapter.spec.ts`
- Create: `adapters/cryptocomapp/__fixtures__/{transactions-page1.json,transactions-page2.json,transactions-last.json}` (structure from the live probe: items with `id, nature, kind, source_type, amount{currency,amount}, native_amount, status, created_at, updated_at, fee, meta`; `meta.pagination.next{last_id,count,pagination_key,sort_by,order}` on non-final pages)

**Interfaces:**
- Produces: `fetchHistory(c, { since?, cursor? })`. Cursor is the opaque JSON of the `next` query params `{ last_id, count, pagination_key, sort_by, order }` (absent on the first call). Each call fetches one page (`count=50`, newest first); records older than `since` end pagination (return no `nextCursor`) after emitting those newer than `since`; when `next` is absent the stream ends. Mapping (first match wins, on `kind` then `nature`): contains `deposit` (but not a transfer kind) is `'deposit'`; contains `withdraw` is `'withdrawal'`; `crypto_to_exchange_transfer` is `'withdrawal'` and `exchange_to_crypto_transfer` is `'deposit'`, both with `internalTransfer: true`; `dpos`, `rewards`, `airdrop`, `income` is `'reward'`; `crypto_wallet_swap_credited` / `_debited` is `'trade'` (the pair stays as two raw rows); anything else is stored as `type:'unparsed'`, counted and never dropped. The stored payload is always the wrapper `{ item, internalTransfer: boolean }`. `exchangeRecordId = 'app:'+id` for all.
- Consumes: Task 4 `request`.

- [ ] **Step 1: Write failing tests**
  - Three-page walk: page1 (50 items, `next` present), page2, final page (`next` absent) yields the right `nextCursor` values and ends; `meta.pagination.total` is ignored (fixtures give wrong totals).
  - `since` handling: stops once an item `created_at < since`, emits only newer ones, returns no `nextCursor`.
  - Unknown `kind`, `status:'pending'`, missing `fee`, and an item with no `amount` produce records (`unparsed` where needed), never throw; a response that is not the documented envelope (`ok !== true` or no `transactions` array) throws `ExchangeSchemaError`.
  - Internal-transfer rows carry `internalTransfer: true`; swap rows stay as two separate records with distinct ids.
  - Request spying: query params sent equal `{count:50}` first, then exactly the `next` params; only `GET /v1/transactions` is ever requested.
  - Review Focus 5 cases.
- [ ] **Step 2: Run; expect FAIL**
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run adapter specs; tsc; eslint; expect green**
- [ ] **Step 5: Commit** `feat(server): Crypto.com App history (cursor pagination, internal transfers)`

---

### Task 6: Wiring, price/held-asset handling, end-to-end verification and docs

**Files:**
- Modify: `CryptoExchanges.module.ts` only if queue registration needs adjustment (it iterates `CRYPTO_SYNC_QUEUE_NAMES`; verify the BullBoard registration and processors pick up the two new queues), `sync/CryptoSync.scheduler.ts`/`processor` only if they hard-code exchanges (grep for `kraken`/`binance` literals outside adapters/specs and fix)
- Modify: `CryptoPrices` held-asset normalization only if Crypto.com symbols need mapping (test first)
- Create: `adapters/cryptocom/cryptocom.live.check.md` is NOT created; live results go to the task report
- Modify docs: `.claude/docs/task-log/2026-10-06-crypto-connectors-piece2a.md` (new; owner's docs dir, force-add only if the owner approved committing docs: they did for piece 1; do not push), `.claude/docs/project-state.md` (new exchanges, new migration, env var names), swagger descriptions (`CryptoExchanges.swagger.ts`) listing the new exchange values

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write failing tests**: a wire-level spec (extend `CryptoExchanges.wire.spec.ts`) creating connections for `crypto_com` and `crypto_com_app` with fake adapters: create returns the view with `exchange`, `key_expires_at`, `history_coverage`; an unsupported exchange still returns the 400/422 as before; scheduler registers jobs on the right queue per exchange (`queueNameFor`); a grep-style test asserting no source file outside adapters hard-codes only kraken/binance (use the registry/constants).
- [ ] **Step 2: Run; expect FAIL where wiring is incomplete**
- [ ] **Step 3: Implement** the minimal wiring fixes found; apply the new migration to a scratch DB (name `scratch_crypto_p2a`, drop afterwards) with the DB-gated integration specs and run them.
- [ ] **Step 4: Full validation**: `tsc --noEmit` server and webapp, eslint on all changed files, jest `--runInBand --forceExit` for CryptoExchanges, CryptoPrices, CryptoLive dirs one at a time (DB-gated specs with the scratch DB), fixture browser check of the connections page (Add dialog lists both exchanges with help text; attestation shows scopes/warnings from a mocked 422; row shows "History limited" and key-expiry states; no secret in DOM/storage after submit), screenshots to the scratchpad.
- [ ] **Step 5: Live read-only verification** with the owner's keys in `.env` using the real adapters in a throwaway script (never printing values): for each adapter run `inspectKey`, `fetchBalances` (asset tickers and counts only), one bounded `fetchHistory` slice (record counts and type breakdown only), confirm zero secret hits in captured output. Report exactly what was and was not verified; the authenticated app flow is not exercised by this script.
- [ ] **Step 6: Docs** (task log, project-state) stating limits honestly: not security-ready; Exchange trades/orders/transactions schemas docs-derived; App enums beyond observed unverified; owner step to run `tenants:migrate:latest`.
- [ ] **Step 7: Commit** `feat(server,webapp): wire Crypto.com adapters end to end` (code) and a separate docs commit if the owner's docs are committed.
