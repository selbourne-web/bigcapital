# Crypto Connectors Piece 2b (Pionex adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Pionex adapter (`pionex`) to the connector framework with balances (including bot-account funds where the API exposes them) and the history the Pionex API can provide, flagged "History limited" until the CSV importer (2c) exists.

**Architecture:** Same pattern as the Crypto.com adapters from 2a: thin hand-written adapter (`adapters/pionex/`), per-api-key serialization lanes, per-method pacing, exact decimals, fixtures built from REAL response shapes discovered by a live read-only probe FIRST (the 2a live pass found three defects that docs-derived fixtures had hidden). Wiring adds a fifth queue/worker. The Pionex API cannot return deposits, withdrawals or bot-internal fills (spec 3.2); those arrive through CSV in 2c.

**Tech Stack:** NestJS 10, BullMQ, jest (`--runInBand --forceExit`), React/Blueprint webapp (no test runner).

**Spec:** `docs/superpowers/specs/2026-10-06-crypto-connectors-piece2-design.md` section 3.2 (+ 3, 4). Facts: `docs/superpowers/research/2026-10-06-piece2-exchange-api-facts.md` section 3 (verified marks), `docs/superpowers/research/2026-10-06-cryptocom-live-probe.md` for the probe method. Conventions to copy: `adapters/cryptocom/CryptoComAdapter.ts` and `adapters/cryptocomapp/CryptoComAppAdapter.ts` (lanes, pacing, `quoteExactNumbers`, error mapping, `idText`, tests with injected clock/sleep).

## Global Constraints

- Read-only only. Allowed Pionex calls (exact paths, all GET): `/api/v1/account/balances`, `/api/v1/wallet/balancesFull`, `/api/v1/common/symbols`, `/api/v1/trade/fills`, `/api/v1/trade/allOrders`, `/api/v1/bot/orders` (read-only bot listing, optional), `/api/v1/market/tickers` (public, optional). Never any POST/DELETE, trade, transfer (`/api/v1/assets/transfer`), order, or `earn`/`futures` write. A path allow-list is enforced inside `send()`.
- Auth (official, verified): headers `PIONEX-KEY`, `PIONEX-SIGNATURE`; query param `timestamp` (ms; reject-if-older-than-20s or future, so send `now - 1000`); signature = hex HMAC-SHA256(secret, `METHOD + PATH + "?" + sorted query "k=v" joined by "&" (not URL-encoded, timestamp included) [+ raw body for POST/DELETE]`); the vendor test vector (secret `NFqv4MB3hB0SOiEsJNDP9e0jDdKPWbDqS_Z1dbU4`, ts `1655896754515`, request `GET/api/v1/trade/allOrders?limit=1&symbol=BTC_USDT&timestamp=1655896754515`) must be a unit test (fetch the expected signature from the official authentication page https://pionex-doc.gitbook.io/apidocs/restful/general/authentication; if it prints none, derive independently and say so).
- Envelope `{result: bool, data, timestamp}`; errors `{result:false, code, message}`: map `INVALID_APIKEY`/`APIKEY_LOST`/`APIKEY_EXPIRED`/`INVALID_SIGNATURE`/`SIGNATURE_LOST`/`PERMISSION_DENIED` to `ExchangeAuthError` with distinct actionable messages, `IP_NOT_WHITELISTED` (IP restriction), `INVALID_TIMESTAMP` (clock skew), HTTP 429 to `ExchangeRateLimitError` with `retryAfterMs: 60_000` and an enforced cool-down (a retry inside the cool-down EXTENDS Pionex's ban: never retry inside it, per api-key); unknown codes non-retryable network error; 5xx retryable.
- Rate limits: IP 10 req/s overall, private 10 req/s per account, fills/allOrders weight 5 (so at most 2 per second): declare `rateLimit {capacity: 10, refillPerSec: 10, historyPageCost: 10}` (capacity MUST be >= historyPageCost: `RateLimiter.acquire` throws otherwise; add the adapter to the generic registry test) and enforce a per-key per-method minimum gap of 600 ms for fills/allOrders and 120 ms otherwise inside `call()` (like Exchange per-method pacing).
- `inspectKey` returns `readOnly: 'unverifiable'` (no permission introspection exists), `permissions` descriptive (`['read']`, plus `'bot-read'` if `/api/v1/bot/orders` succeeds), no warnings; the first authenticated call (`/api/v1/account/balances`) must authenticate (auth errors propagate with distinct messages); a bot-read probe error never propagates. Attestation is therefore required (existing flow).
- `historyCoverage = { level: 'partial', note: 'Pionex API history is limited to the latest 100 fills per market and excludes deposits, withdrawals and bot activity; import the CSV exports for complete history.' }`.
- Money: decimal strings only; exact decimals through `adapters/shared.ts` (`addDecimal`, `subDecimal`, `isDecimal`); no float math; negative values tolerated per the 2a lessons (skip negative balances; signed amounts kept as text in payloads); parse the response as text then JSON.parse; hard-coded host `https://api.pionex.com`, `redirect: 'error'`, `AbortSignal.timeout`.
- Record ids: `fill:<id>` for fills (type `trade`), `order:<id>:s<status>` for orders (type `trade`, payload marker `_source: 'order-history'`; fills `_source: 'fills'`); any id fragment over 64 chars hashed (reuse the 2a `idText` approach; ids must stay < 191 chars); one immutable raw row per order status transition; unmapped or malformed rows become `unparsed` with a content-hash id and never throw; a response that is not the documented envelope throws `ExchangeSchemaError`.
- Secrets never in logs/errors/payloads/fixtures (fake keys `TEST_KEY`/`TEST_SECRET`; sanitized fake values in fixtures built from REAL shapes); every new Redis/queue/job id org-scoped (use existing helpers).
- New migration only if needed (none expected). No new dependencies expected.
- Tooling: `source ~/.nvm/nvm.sh && nvm use 22`; jest `--runInBand --forceExit`, one heavy command at a time, check `uptime; free -m`; never `wsl --shutdown`; the owner's API and Vite run as systemd services (hot reload): do not restart them; never read `.env` values or `~/_sys-access`; LF endings (`sed -i 's/\r$//'` after Windows-side edits); never run prettier on `__fixtures__`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; husky needs nvm in the same shell and may leave the first commit empty (re-stage, retry); do not stage `.claude/CLAUDE.md` or `.superpowers`; no push. Live checks use the owner's read-only keys from `.env` (`PIONEX_EXCHANGE_API_KEY` / `PIONEX_EXCHANGE_SECRET_KEY`) only inside throwaway node processes; never print values, balances, ids, addresses.

## Review Focus

1. Pionex bot-account funds: `/api/v1/account/balances` excludes them and `balancesFull` entries' per-coin shape is undocumented; wrong handling either hides funds or double counts (balancesFull may also include trading-account coins). Expected: no coin counted twice; unknown shapes never fail the whole sync.
2. Symbol enumeration for fills/orders: no fills for a coin with no `_USDT`/`_USDC` market, delisted markets, a coin held only in a bot, a huge symbol list (rate budget), and fills exactly 100 in a window (must page back without losing rows or looping on identical timestamps).
3. A 429 or ban: cool-down enforced per key, no retry inside it, sync fails retryably with a clear message, other keys unaffected.
4. Clock skew: the timestamp rule (older than 20 s OR in the future is invalid): `INVALID_TIMESTAMP` surfaces as an actionable clock message, not a generic network error.
5. Wiring: fifth queue/worker consumed, scheduler/unschedule cover five queues, `pionex`/`nexo` handling in DTO/validators (nexo still unsupported), webapp list/help text, attestation callout works for a key with no permission info.

---

### Task 1: Live read-only shape discovery (no production code)

**Files:** Create `docs/superpowers/research/2026-10-07-pionex-live-probe.md` (field names/types only). Scratch scripts live in the scratchpad directory, never in the repo.

**Interfaces:** Produces the findings every later task's fixtures and decisions depend on.

- [ ] **Step 1:** With the owner's read-only Pionex keys (names above) inside a throwaway node process (Node 18.16.1, `fetch`), perform signed GETs ONLY on the allow-listed paths and record, as field names and value TYPES only (no amounts, ids, addresses, names): the signing works with the documented scheme (timestamp `now - 1000`); `/api/v1/account/balances` shape; `/api/v1/wallet/balancesFull` full shape including `botAccount.detail[].list` entries per `type`, `traderAccount`, `prices`, whether trading-account coins are repeated there; `/api/v1/common/symbols` shape (symbol format, `type`, `enable`/status fields); one `/api/v1/trade/fills` and one `/api/v1/trade/allOrders` call for a market the account actually traded (pick from non-zero balances) with a wide `startTime`/`endTime`, noting ordering, count cap behavior, status/role enums, field types (sizes and prices as strings or numbers), and what happens with no `symbol`; `/api/v1/bot/orders` (status running and finished) shape; the error shape for a missing-permission call if one occurs naturally (do NOT cause errors on purpose beyond an unauthenticated-timestamp-free probe); rate-limit response headers if any; response time per call.
- [ ] **Step 2:** Verify the official signing test vector offline and report whether the official page lists the expected signature.
- [ ] **Step 3:** Write the findings doc; list every place where the facts doc or this plan's assumptions are wrong or unspecified; scan captured output for the key and secret substrings and report `zero hits`. Do not commit code; commit only the findings doc.
- [ ] **Step 4:** Commit `docs: Pionex live probe findings`.

---

### Task 2: Pionex adapter: signing, errors, inspectKey, fetchBalances (+ registry and generic tests)

**Files:** Create `adapters/pionex/pionex.signing.ts`, `pionex.signing.spec.ts`, `PionexAdapter.ts`, `PionexAdapter.spec.ts`, `__fixtures__/{account-balances.json,wallet-balances-full.json,symbols.json}` (REAL shapes from Task 1 with fake values). Modify `adapters/AdapterRegistry.ts` (+ spec: pionex in the generic capacity test), `CryptoExchanges.constants.ts` (`'pionex'` already in the id type; add to `SUPPORTED_CRYPTO_EXCHANGES`, `CRYPTO_SYNC_QUEUES`, `CRYPTO_SYNC_QUEUE_NAMES`, new `CRYPTO_SYNC_PIONEX_QUEUE`).

**Interfaces:**
- Produces: `pionexSign(a: { method: string; path: string; query: Record<string, string | number>; body?: string; secret: string }): string`; `class PionexAdapter implements ExchangeAdapter` with `id: 'pionex'`, constructor `(fetchImpl = fetch, requestTimeoutMs = 30_000, now = () => Date.now(), sleep = defaultSleep)`; the structure of lanes/pacing/allow-list/`call()` mirrors `CryptoComAdapter`; `historyCoverage` and `rateLimit` as in Global Constraints.
- Consumes: Task 1 findings; `shared.ts` helpers; error classes; `normalizeAsset`.

- [ ] **Step 1: Write failing tests:** signing vector; payload construction (sorted, not URL-encoded, timestamp included, method+path prepended, body appended for POST in a pure-function test even though the adapter never POSTs); inspectKey: `account/balances` auth error mapping for each code in Global Constraints with distinct messages; success returns `{readOnly:'unverifiable', permissions:['read']}`; bot-read probe success adds `'bot-read'`, any bot probe error (incl. auth/429) is swallowed; fetchBalances: merge `account/balances` (free/frozen: free = free, locked = frozen) with bot-account funds from `balancesFull` per the Task 1 shape WITHOUT double counting coins that also appear in the trading account; zero/negative/malformed entries skipped; only structurally wrong envelopes throw `ExchangeSchemaError`; 429 sets a per-key cool-down (second call within 60 s fails fast without a network request); per-method pacing with injected clock; per-key lanes (key A slow does not delay key B); allow-list rejects `/api/v1/assets/transfer`; secret redaction; generic registry test (`historyPageCost <= capacity`).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** to the signatures; `historyCoverage`/`rateLimit` literal values from Global Constraints; `fetchHistory` stub returning `{ records: [] }` marked for Task 3.
- [ ] **Step 4: Run** `PionexAdapter`, `pionex.signing`, `AdapterRegistry` specs; tsc; eslint; expect green.
- [ ] **Step 5: Commit** `feat(server): Pionex adapter (auth, key inspection, balances)`.

---

### Task 3: Pionex adapter: fetchHistory (fills and orders)

**Files:** Modify `adapters/pionex/PionexAdapter.ts` and its specs; Create `__fixtures__/{fills-page.json,orders-page.json}` from REAL shapes (Task 1), plus a >100-row synthetic page built in the spec.

**Interfaces:** Produces `fetchHistory(c, { since?, cursor?, knownAssets? })` with an opaque bounded cursor `{ phase: 'fills'|'orders', symbolIndex: number, endTime: number, symbols?: string[] }`; symbols = markets (from `/api/v1/common/symbols`, validated/enabled) whose base coin is in `knownAssets` ∪ current non-zero balances ∪ coins seen in stored records; records: fills `type:'trade'` id `fill:<id>`; orders `type:'trade'` id `order:<id>:s<status>`; one HTTP page per request; at most 8 requests per call; per-symbol walk backwards from now to `max(since - 1 day, 2018-01-01)` by moving `endTime` to the oldest returned timestamp (+/- the same-ms termination rule from the Crypto.com adapter); a full page of 100 fills re-requests until fewer than 100 or no progress; empty symbols advance within the call; final symbol/phase end => no `nextCursor`.
- Consumes: Task 2 `call()`; the sync service contract (see `sync/CryptoSync.service.ts`: since overlap, cursor persistence, page cost 10, budgets).

- [ ] **Step 1: Write failing tests:** symbol enumeration from balances + knownAssets (delisted/disabled market skipped, coin with no market skipped, bounded symbol count with a documented cap and a `nextCursor` continuation); fills walk with exactly 100 rows and with 250 synthetic rows across timestamps (none lost, no duplicates); identical-timestamp page of 100 terminates; orders status-in-id (two ids for one order across statuses); cursor round trip and malformed cursor => `ExchangeSchemaError`; `since` lower bound with 1-day overlap; request spying: only the allow-listed paths with `symbol`, `startTime`, `endTime`, `limit` params; unknown shapes => `unparsed`; numbers-as-strings stay exact; per-method pacing between consecutive fills calls across `fetchHistory` calls (>= 600 ms with injected clock).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** as specified (small private methods per phase; do not exceed the request budget per call).
- [ ] **Step 4: Run** the pionex specs; tsc; eslint; expect green.
- [ ] **Step 5: Commit** `feat(server): Pionex history (fills and orders per market)`.

---

### Task 4: Wiring, webapp, validation, live verification, docs

**Files:** Modify `CryptoExchanges.module.ts` (a `CryptoSyncPionexWorker` `@Processor` like the existing four, constant-based), `sync/CryptoSync.processor.ts`, `sync/CryptoSync.scheduler.ts` (inject and route the fifth queue; `unschedule` loops all queues), swagger/DTO examples, `CryptoExchanges.wire.spec.ts`, scheduler/processor specs; webapp `containers/Crypto/exchanges.ts` (add `pionex` label), `AddConnectionDialog.tsx` help text; `.claude/docs/task-log/2026-10-08-crypto-connectors-piece2b.md` (new), `.claude/docs/project-state.md` (update), force-added, local only.

**Interfaces:** consumes Tasks 2 and 3; webapp `CRYPTO_EXCHANGES` entry `{ value: 'pionex', label: 'Pionex', help: <text> }` with help: "In Pionex, open API management and create a key with 'Enable reading' only (add 'Bot reading' if you use trading bots). Leave trading and transfer off. Pionex cannot confirm a key's permissions, so you will be asked to confirm the key is read-only."

- [ ] **Step 1: Write failing tests:** wire spec creating a `pionex` connection with a fake adapter (422 attestation body with `permissions`/`warnings` arrays; view has `history_coverage`); `nexo` still returns the clean unsupported error (not 500); the scheduler registers on and unschedules from all five queues; the module spec asserts every sync queue has a `@Processor`; no hard-coded exchange lists elsewhere (grep test or code reading).
- [ ] **Step 2: Run; expect FAIL where wiring is incomplete.**
- [ ] **Step 3: Implement** the wiring and webapp entries; run DB-gated specs on a scratch DB (`scratch_*`, dropped afterwards; use the container's own env inside the container, never print it).
- [ ] **Step 4: Full validation:** `tsc --noEmit` server and webapp, eslint on changed files, jest `--runInBand --forceExit` for CryptoExchanges, CryptoPrices, CryptoLive (one directory at a time, `TEST_REDIS=1` if local Redis available), fixture browser check of the Add dialog (Pionex listed with help text; attestation callout for a mocked 422; no secret in DOM/storage).
- [ ] **Step 5: Live read-only verification** with the owner's Pionex keys through the compiled `dist` adapter in a throwaway script (never printing values): `inspectKey`, `fetchBalances` (tickers/counts only; confirm no double counting of coins across trading and bot accounts), one bounded `fetchHistory` walk (counts by record type, unparsed count + reasons, schema errors, cursor behavior, rate-limit behavior), zero secret hits. Report what was NOT verified (the authenticated app flow: UI add-connection, worker, dashboard).
- [ ] **Step 6: Docs** (task log, project-state): honest limits (API history partial, no deposits/withdrawals/bot fills until 2c, `balancesFull` shape as observed, key expiry undocumented, not security-ready).
- [ ] **Step 7: Commit** code `feat(server,webapp): wire Pionex adapter end to end`; docs commit separately.
