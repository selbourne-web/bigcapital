# Crypto Exchange Connectors (Piece 1) - Design

Date: 2026-10-04
Status: Draft for owner review
Scope: Piece 1 of 5 of the crypto-exchange feature (Selbourne Financial / Bigcapital fork).

## 1. Context and goal

Selbourne Financial needs to connect crypto exchange accounts by API, show per-exchange
balances on the dashboard with a live, dynamic valuation, and capture full transaction
history so later pieces can produce financial reports, tax reports, trade analytics and AI
recommendations.

Whole-feature decomposition (each piece gets its own spec, plan and build):

1. **Connector framework + credential vault + live prices + dashboard (this spec)**; first adapters: Kraken, Binance.
2. Remaining adapters: Crypto.com, Pionex, Nexo (CSV import fallback where no API exists; API coverage to be verified).
3. Normalized ledger (trades, transfers, fees), historical pricing, ledger-account mapping and journal posting.
4. Cost basis, realized/unrealized P&L, tax and financial reports. Jurisdiction rules are pluggable: Barbados is active; USA (Delaware LLC, registered office Lewes DE) is deferred.
5. Trade and position analytics, AI recommendations (builds on the existing `BankingAI` module).

### Decisions already taken (owner)

- Multiple labelled connections per exchange (e.g. "Binance - Treasury").
- Each connection maps to exactly one Chart-of-Accounts **asset account** (valued in the base currency, BBD). Per-asset quantities live in the crypto tables; no per-asset ledger accounts. The account is chosen by picking an existing asset account or by auto-creating one named after the connection. The mapping is required before piece 3 can post, but is editable later, so a connection can sync and display without it.
- Piece 1 syncs balances AND full raw history, stored immutably; normalization is piece 3.
- Piece 1 includes a live price feed and a dynamic dashboard.
- Prices come from public exchange endpoints (no API key), precedence Kraken > Binance > Crypto.com.
- Exchange adapters are thin and hand-written behind a common interface (no CCXT in piece 1).
- Read-only API keys only; keys with trading/withdrawal rights are rejected.

## 2. Non-goals (piece 1)

Normalized transactions, P&L, tax, analytics, AI, journal posting (piece 1 only maps the account; it posts nothing), historical price storage,
Crypto.com/Pionex/Nexo adapters, mobile layout below 850px (matches existing dashboard).

## 3. Architecture

Patterned on `packages/server/src/modules/BankingPlaid` (models / command / jobs / controller / dtos) and BullMQ queues registered via `BullModule.registerQueue`.

| Module | Scope | Responsibility |
|---|---|---|
| `CryptoExchanges` | tenant | connections, credential vault, sync jobs, raw records, balances, REST controller |
| `CryptoPrices` | global (no tenant data) | upstream price streams, cache, failover |
| `CryptoLive` | global gateway | authenticated Socket.IO namespace `/crypto` |

The existing `modules/Socket/Socket.gateway.ts` is **not reused**: it is unauthenticated, broadcasts to all clients and uses CORS `*`.

### 3.1 ExchangeAdapter interface

One class per exchange:

- `inspectKey()` - returns the key's permissions; anything beyond read-only means reject.
- `fetchBalances()`
- `fetchHistory({ since, cursor })` - returns a raw page plus next cursor.
- Declared rate-limit policy.

Request signing uses Node's built-in `crypto` (HMAC). No new dependency is planned for adapters.

## 4. Data model (tenant DB)

- `crypto_connections`: id, exchange, label, encrypted key / secret / optional passphrase, key version, key hint (last 4 chars), status (`active|paused|error`), last_sync_at, last_error, `account_id` (nullable FK to the tenant `accounts` table; must reference an asset-type account; unique per connection, and the same account may not be mapped to two connections), timestamps. Null means "not yet mapped": sync and display work, posting (piece 3) is blocked.
- `crypto_raw_records`: id, connection_id, record_type (`trade|deposit|withdrawal|fee|reward`), exchange_record_id, occurred_at, raw JSON payload, payload hash. Append-only. Unique (connection_id, record_type, exchange_record_id) so re-syncs are idempotent.
- `crypto_balance_snapshots`: connection_id, asset, free, locked, captured_at.
- `crypto_sync_runs`: connection_id, kind (initial/incremental/manual), status, range, counts, errors, timestamps.

Secrets: AES-256-GCM using a dedicated `CRYPTO_ENCRYPTION_KEY` (separate from the MFA key; helper pattern from `Auth/mfa/mfa-secret-crypto.ts`). The API never returns secrets after creation.

## 5. Connection and sync flow

**Add connection:** user enters exchange, label, key, secret (and passphrase if required). Server calls `inspectKey()`. If not read-only: reject, store nothing. Otherwise encrypt, store, queue initial sync.

**Account mapping (in the same form, optional at creation):** the user either picks an existing asset account (validated: asset type, not already mapped, base currency) or chooses "create account for me", which creates a new asset account named after the connection label (e.g. "Kraken - Trading") through the existing `Accounts` module services, in one transaction with the connection. If creation or mapping fails, nothing is stored. The mapping can be set or changed later via `PATCH`. Changing it after journals exist is blocked once piece 3 has posted entries (rule defined in piece 3).

**Jobs (BullMQ, one queue per exchange):**
- Initial sync: backfills all available history by cursor; resumable from the saved cursor.
- Incremental sync: repeatable, default every 5 minutes, fetches since last seen timestamp with a small overlap window (safe because of the unique key).
- Each run takes a balance snapshot.
- Manual "Sync now", rate-limited per connection.

**Rate limits and failures:**
- Per-exchange token bucket in Redis shared across tenants.
- 429/5xx: exponential backoff retry.
- Auth failure (revoked/expired key): status `error`, syncing pauses, no retry (avoids IP bans), dashboard shows "Reconnect".
- Every run writes a `crypto_sync_runs` row.
- On completion the server emits a tenant-room event carrying only ids/status, never balances.

## 6. Price feed and live channel

`CryptoPrices`:
- Public WebSocket tickers for Kraken, Binance, Crypto.com. Subscribes only to assets held by any tenant, reconciled every minute.
- Latest price per asset in memory, mirrored to Redis.
- Precedence Kraken > Binance > Crypto.com; failover after 30 s silence. Each price carries `source` and `asOf`.
- USD quote; BBD derived through the existing `ExchangeRates` module (Barbados peg is 2 BBD : 1 USD; verify what the module already provides before adding anything).
- Jittered reconnect backoff; if all sources are down, last known prices are shown marked stale.
- Fallback source (e.g. an aggregator) stays pluggable and is not built now.

`CryptoLive` (`/crypto` namespace):
- Handshake validates the same JWT and organization id as the REST API; unauthenticated sockets rejected.
- `prices` room: batched ticks throttled to about 1/s per asset.
- `tenant:<id>` room: sync status events only; a tenant can only join its own room.
- CORS restricted to the app origin.
- **Balances never travel over the socket**; clients refetch via REST.

Valuation (balance x live price) is computed in the browser. No pricing is stored in piece 1.

## 7. REST API and UI

REST under `/api/crypto`, guarded by existing auth, tenancy and a new `CryptoExchanges` permission:

- `GET /connections`, `POST /connections`
- `POST /connections` accepts `accountId` (existing) or `createAccount: true`, not both.
- `PATCH /connections/:id` (rename, pause, resume, set/change `accountId`), `DELETE /connections/:id` (raw records kept unless the caller explicitly asks to delete data)
- `POST /connections/:id/credentials` (rotate; re-runs `inspectKey()`)
- `POST /connections/:id/sync`
- `GET /balances`, `GET /sync-runs`

Webapp (visx, following bklit-ui conventions adapted to this stack because the shadcn route needs Node >= 20.18.1 and Tailwind; record this adaptation in the task docs):
- Dashboard "Crypto" widget: live total, per-exchange breakdown, holdings table (asset, quantity, price, value, 24h change if the feed provides it), connection status strip with Reconnect.
- "Crypto Connections" settings page: add / rotate / remove, per-exchange read-only-key instructions, an account picker (existing asset accounts, or "create account for me"), and an "Account not mapped" badge on unmapped connections.
- Socket ticks feed a price store (not the React Query cache). Reduced-motion preferences respected. Empty state: "Connect an exchange".

## 8. Security

- Read-only enforced on add and rotate; keys decrypted only in the sync worker for the duration of a call; never logged (scrubber redacts key/secret fields); exchange error text sanitized before storing or showing.
- `CRYPTO_ENCRYPTION_KEY` required at boot; the module refuses to start without it; stored key version enables rotation.
- New permission gates all endpoints and the gateway; add / rotate / delete / manual-sync are written to the audit log.
- DTO validation, rate limits on connect and sync endpoints; exchange hosts come from adapters only (no user-supplied URLs, so no SSRF).
- Socket: JWT handshake, room isolation, restricted CORS.
- Pre-merge: OWASP ZAP against staging, Cloudflare security-audit skill, Alibaba open-code-review; results and accepted risks documented in the task log.
- No new dependencies planned (Node `crypto`; `ws` only if already in the dependency tree - to verify).
- Users never paste keys into chat; keys live in `.env` / the app form only.

## 9. Error handling

Typed errors: auth, rate-limit, network, schema drift, key-has-extra-permissions - each with a user-facing message and a retry rule. If an exchange changes its response format, the raw record is still saved and flagged by the parser, so no data is lost.

## 10. Testing

- Account mapping: reject non-asset or already-mapped accounts, atomic create-account-plus-connection (rollback on failure), unmapped connections still sync and display.
- Unit: HMAC signing against published test vectors; key-permission rejection; idempotent insert; cursor resume; price failover.
- Adapters run against recorded fixture responses (deterministic, no live keys).
- Integration: add -> sync -> balances against a mock exchange server; gateway rejects unauthenticated and cross-tenant sockets.
- Webapp: dev preview route with sample data (like the existing `/__preview/dashboard`) and a headless-browser check of live ticking, stale badges and error states.
- Limitation: live verification against real exchanges requires the owner's read-only keys; until then, only fixture/mocked behaviour is verified.

## 11. Open items for later pieces

- Historical price storage and cost-basis method (piece 3/4).
- Posting to the mapped account (trades, fees, revaluation of the account to BBD value) and the rule for changing a mapping after posting (piece 3). Piece 1 only stores and validates the mapping.
- Optional per-asset account override (e.g. route a stablecoin elsewhere): not built; the one-account-per-connection model can be extended later.
- Per-exchange API coverage and history-depth limits for Crypto.com, Pionex, Nexo (piece 2).
- USA tax rules (deferred).
