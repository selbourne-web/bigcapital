# Crypto Exchange Connectors (Piece 2) - Design

Date: 2026-10-06. Status: draft for owner review.
Builds on: `2026-10-04-crypto-connectors-design.md` (piece 1, implemented on `feat/crypto-connectors`).
Facts source: `docs/superpowers/research/2026-10-06-piece2-exchange-api-facts.md` (every claim there is tagged verified / inferred / unclear; this spec only relies on `verified` claims unless marked).

## 1. Context and goal

Piece 1 delivered the connector framework, the credential vault, Kraken and Binance adapters, the sync engine, the live price feed and the dashboard widget. Piece 2 adds Crypto.com Exchange, Pionex and Nexo Pro as exchange connections and a CSV import path for history that APIs do not provide.

### Decisions already taken (owner, 2026-10-06)

1. Platforms: **Crypto.com Exchange** and **Crypto.com App** (two different APIs, two adapters), **Pionex**, and **Nexo**. Crypto.com provides no CSV exports, so its history comes from the APIs only.
2. **Nexo has no API** (owner, 2026-10-06: Nexo Pro API access has only been surveyed, not released). Nexo is a **CSV-only** connection fed by its two CSV exports. A Nexo adapter is out of scope until Nexo releases an API and the owner supplies its official documentation.
3. CSV is **a second data source on the same connection** (option A), not a separate entity. A connection is `api`, `api+csv` or `csv_only`.
4. Delivery order: 2a Crypto.com, 2b Pionex, 2c CSV core with Crypto.com and Pionex parsers, 2d Nexo Pro API plus Nexo CSV.
5. Dependencies may be added when needed (owner, 2026-10-06), subject to the usual review (maintenance, license, footprint).
6. Keys are **read-only**; the same attestation rules as piece 1 apply where the exchange cannot tell us a key's permissions.

## 2. Non-goals

- Ledger posting, journal entries, cost basis, tax, reports, AI analytics (pieces 3 to 5). Piece 2 only stores raw records and balances.
- Trading, withdrawals, any write call to an exchange.
- Derivatives, margin and futures accounts (stored raw if the endpoint returns them, never interpreted).
- Bot-level accounting for Pionex (grid/DCA); only what its APIs and CSV exports expose.

## 3. Architecture changes

The `ExchangeAdapter` interface is kept. Additions are optional so Kraken and Binance are unchanged:

```ts
interface ExchangeAdapter {
  // existing members unchanged
  readonly historyCoverage: { level: 'full' | 'partial'; note?: string };
}
```

`CryptoExchangeId` gains `crypto_com` (Exchange API), `crypto_com_app`, `pionex` and `nexo` (CSV-only, no adapter). `AdapterRegistry` registers the new adapters. The sync engine, vault, rate limiter, queues, price feeds, REST controller and webapp hooks are reused. Per-exchange rate-limit buckets stay global per exchange (known limitation from piece 1; revisit when per-key limits are verified).

### 3.1 Crypto.com Exchange adapter (2a)

- Base `https://api.crypto.com/exchange/v1/{method}`, private calls are POST JSON. No UAT in production code; UAT base is configurable for tests only.
- Signing: HMAC-SHA256 hex over `method + id + api_key + sortedParamString + nonce`; nonce is the epoch ms; the server accepts +/-60 s, so a clock-skew error is reported as a distinct, actionable error.
- `inspectKey`: there is no permission-introspection endpoint. Default result is `readOnly: 'unverifiable'`, which routes through the existing attestation flow (HTTP 422 `ATTESTATION_REQUIRED`). As a non-blocking safety signal, a probe of `private/get-deposit-address` is run: the vendor documents it as working only when withdrawal is enabled, so a success adds a warning ("the exchange cannot confirm this key is read-only and this call suggests withdrawal may be enabled; confirm 'Can Read' only in your Crypto.com dashboard") shown with the attestation checkbox. It does not auto-reject, because the probe's behaviour on a read-only key is unobserved (open item 1) and the owner has stated the key is read-only (the 2026-10-06 live probe of that key succeeded, which is why the warning exists; the owner's statement is recorded as the attestation basis).
- Observed live: deposit and withdrawal list amounts and fees are JSON **numbers** (not strings): the adapter converts via the raw decimal text where possible and never uses float arithmetic; everything else is strings.
- `fetchBalances`: account summary endpoint; asset symbols normalized by `assets.ts`.
- `fetchHistory`: trades and order history page backwards by time window (100 records max, default 1 day); deposits and withdrawals by page number (200 max); staking rewards within 180 days of `end_time`. API retention is 6 months, so the first sync backfills 6 months and `historyCoverage` is `partial` ("API history is limited to 6 months; import a CSV for older records").
- Rate limits: 1 request/s on trades and order history, 3 per 100 ms on most other private calls. The adapter declares the stricter bucket and a per-call cost.
- Optional IP allow-list on the key is documented for the owner; a blocked IP returns code 40103, mapped to an actionable error.

### 3.2 Pionex adapter (2b)

- Base `https://api.pionex.com`. Headers `PIONEX-KEY`, `PIONEX-SIGNATURE`; `timestamp` query param (20 s window). Signature is HMAC-SHA256 hex over `METHOD + path + sorted query + body`; the exchange publishes a test vector, which becomes a unit test.
- `inspectKey`: no introspection endpoint; `readOnly: 'unverifiable'` (attestation). Pionex has no retail withdraw permission; trading permission cannot be detected without a write.
- `fetchBalances`: `/api/v1/account/balances` (excludes bot and Earn funds) plus `/api/v1/wallet/balancesFull` for bot and futures accounts. The per-entry schema of `balancesFull` is not specified in the docs: it is stored raw and parsed defensively; schema drift is flagged exactly as in piece 1 (`unparsed` records, `SCHEMA_DRIFT`).
- `fetchHistory`: fills and orders are per symbol and capped to the latest 100 fills, spot orders exclude bot orders, bots appear only as summaries, and there is no retail deposit/withdrawal endpoint. `historyCoverage` is `partial` ("Pionex's API cannot return full history; import its CSV exports"). Symbols are discovered from current balances, `knownAssets` and stored trades.
- Rate limit 10/s per IP and per account, weighted (fills and orders cost 5). A 429 triggers a 60 s ban that grows with further requests, so the adapter treats 429 as `RateLimited` with an enforced cool-down and never retries inside the cool-down.

### 3.3 Crypto.com App adapter (2a, live-probed 2026-10-06; see `2026-10-06-cryptocom-live-probe.md`)

- Host `https://wapi.crypto.com`; signed GETs. Headers `Cdc-Api-Key`, `Cdc-Api-Timestamp` (ms), `Cdc-Api-Signature` = base64 HMAC-SHA256(secret, `timestamp + METHOD + path-without-query + body`). Signing and endpoints were taken from the vendor's open-source client (source reviewed, not installed: it is a trade/withdraw agent skill) and confirmed by a live read-only probe with the owner's key.
- `inspectKey`: **introspection exists**: `GET /v1/api-keys/current` returns `scopes: string[]` of the form `<resource>:<read|write>`, `status`, `expires_at`. Rule: status must be active. Any scope that can move funds or trade (a `:write` scope whose resource matches withdrawal, transfer, trade, purchase, sale, exchange or conversion, or any scope whose resource name is not recognized as safe) is **refused** with the permission list. Other `:write` scopes (the probed key has `fiat.deposit:write`, which only creates deposit instructions) yield `readOnly: 'unverifiable'`: the UI lists those scopes and requires the attestation checkbox. Fully `:read` scopes are accepted without attestation. `expires_at` is stored on the connection and surfaced in the UI (App keys expire; the probed key expires 90 days after creation), including a warning before expiry.
- `fetchBalances`: `GET /v1/crypto-account` (`wallets[]`, filter non-zero; `available`/`locked`) and `GET /v1/fiat-account` (`balances[]`). `GET /v1/portfolio` is **not** used for balances because its products include an "Exchange" slice that overlaps the Exchange connector (double-count risk).
- `fetchHistory`: `GET /v1/transactions`, cursor pagination (`count` max 50, newest first; follow `meta.pagination.next` params until absent; `meta.pagination.total` is unreliable and ignored). Retention is effectively full history (the probe reached 7.5 years), so `historyCoverage` is `full`. Records include deposits, staking and interest, airdrops, swaps (paired credited and debited rows) and App to Exchange transfers; enums beyond those observed (withdrawals, fiat, card, cashback, other statuses) are stored raw and tolerated, never rejected.
- App to Exchange transfers (`crypto_to_exchange_transfer`, `exchange_to_crypto_transfer`) appear in both connectors; they are stored raw and flagged for piece 3 to treat as internal transfers.
- Rate limit: HTTP 429 means wait 60 s; the adapter enforces the cool-down. Rate budget is declared conservatively until measured.
- The owner states both Crypto.com keys are read-only. The probed App key lists `fiat.deposit:write` alongside read scopes; under the rule above it is accepted with attestation (not silently as read-only), and the UI shows that scope. The owner may remove it in the Crypto.com dashboard to get the no-attestation path.

### 3.4 Nexo (CSV-only, 2d)

No adapter. The connection is `csv_only` and uses the Nexo CSV parsers in 5.3. The Nexo transactions export mixes interest, transfers, exchanges and credit-line activity in one file; the futures export is a separate file with a different layout.

## 4. History coverage in the UI

The connections page shows, per connection, a "History limited" notice when the adapter's `historyCoverage.level` is `partial`, with the adapter's note and an "Import CSV" action. The API response of connections gains `history_coverage` (`{level, note}`) and `mode`.

## 5. CSV import subsystem (2c, 2d)

### 5.1 Model (tenant DB, new migration; existing migrations are not edited)

- `crypto_connections.mode` (`api` | `csv_only`, default `api`); `csv_only` connections store no credentials (credential columns are already nullable or become nullable in the migration, verified in planning). `api+csv` is simply an `api` connection that also has imports.
- `crypto_csv_imports`: id, connection_id, exchange, report_type, original_filename, file_sha256, row_count, rows_imported, rows_skipped_duplicate, rows_rejected, date_from, date_to, status (`previewed` | `committed` | `failed` | `rolled_back`; `rolled_back` was added in the plan so a rolled-back file is distinguishable and can be imported again), error, created_at, committed_at, uploaded_by.
- `crypto_raw_records` gains `source` (`api` | `csv`, default `api`) and nullable `import_id` (FK to `crypto_csv_imports`). The idempotency key remains `(connection_id, record_type, exchange_record_id)`. For CSV rows `exchange_record_id` is the exchange's own id column when the export has one; otherwise a deterministic hash of the normalized row fields prefixed `csv:`.
- Re-uploading the same file (same `file_sha256`) is refused with a clear message; overlapping files de-duplicate by record id.

### 5.2 Flow

1. `POST /api/crypto/connections/:id/imports` (multipart, `Create` ability, size cap 10 MB, row cap 200,000): the file is parsed in memory; no raw file is stored on disk, only the parsed rows' raw payloads plus the file hash.
2. The parser registry picks a parser by header signature (exchange + report type). Unrecognized headers fail with `CSV_FORMAT_UNRECOGNIZED` listing the headers found; nothing is imported.
3. Response is a **preview** (counts, date range, duplicates, rejected rows with line numbers and reasons). Nothing is written until the owner confirms.
4. `POST /api/crypto/imports/:importId/commit` writes the rows in one transaction in batches, stamped with `source='csv'` and `import_id`.
5. A committed import can be reviewed (list) and rolled back (deletes only that import's CSV rows; API rows are never touched).

### 5.3 Parsers

One parser module per exchange and report type, each with: header signature, row schema (zod or class-validator, reusing what piece 1 uses), timestamp and timezone handling (explicit, documented per exchange), amount parsing as decimal strings (never floats), and a fixture set. Parsers are written from the **real sample files the owner supplied** (columns observed 2026-10-06; sanitized copies become test fixtures only with the owner's approval). Files are matched by exact header signature after trimming whitespace and a UTF-8 BOM (the Nexo futures file has a leading space in its first header).

| Exchange | Report type (header signature) | Notes |
|---|---|---|
| Pionex | `trading` (date, executed_qty, amount, price, side, symbol, fee, fee_coin, market_type, tax_id) | Spot and futures fills; `tax_id` groups fills. |
| Pionex | `raw-trading-details` (adds order_type, state) | Superseded by ruling 1: `trading` maps to `trade_summary` (a summary row, not a fill) and `raw-trading-details` FILLED rows map to `trade`, so the two do not share a record type and no cross de-duplication is done; non-FILLED rows become `unparsed` (ruling 2). |
| Pionex | `staking` (Received/Sent Quantity and Currency, tag) | Hourly staking income; very high row count. |
| Pionex | `others` (coin, amount, tag, comment) | Funding fees and other adjustments (tag values kept raw). |
| Pionex | `convert`, `deposit-withdraw`, `dust-collector`, `structured-products`, `position_futures` | Header-only in the sample (no rows) except `position_futures`; signatures recognized, row semantics finalized when real rows exist. |
| Pionex | `for-cointracker`, `for-cointracking` | **Derived third-party-format duplicates of the files above. Recognized and refused by default ("derived export; import the original reports") so activity is never double counted.** |
| Nexo | transactions (Transaction, Type, Credit Line, Input/Output Currency and Amount, USD Equivalent, Fee, Fee Currency, Details, Date / Time (UTC)) | Has its own transaction id; mixed types (interest, transfers, exchanges, credit); `USD Equivalent` is stored raw, not trusted for valuation; Nexo-specific tokens (e.g. xUSD) are preserved verbatim. |
| Nexo | futures transactions ( Id, Timestamp (epoch ms), Symbol, Type, Position, Price, Amount, Status, Asset, Side, DealId, InternalTransactionType, TradingFeeAmount/Asset, ExecutionPriceAsset, ExchangeRate, SourceAsset/Amount) | `null` literals mean missing; liquidations and realized PnL appear as rows. |

Timestamps: Pionex dates are UTC (`date(UTC+0)`); Nexo transactions are UTC; Nexo futures are epoch milliseconds. Each parser documents and tests its timezone handling. Crypto.com has no CSV export and no parser. Anything unrecognized in a recognized file is kept as a raw record of type `unparsed` and counted, never silently dropped. Large files (Nexo ~13,000 rows, Pionex staking ~6,700) are processed in bounded batches.

### 5.4 UI

The connections page gains an Add CSV-only connection option ("Nexo (CSV)", "Crypto.com App (CSV)") and an Import CSV dialog: choose file, preview table, confirm, result summary, import history with rollback. Same Blueprint/SCSS conventions and accessibility rules as piece 1.

## 6. Security

- No secrets are added to the CSV path. CSV content is untrusted input: strict size and row caps, streaming/bounded parsing, no formula evaluation, no path or filename use beyond display (sanitized), content-type and extension checks, header-signature gating before any row processing.
- Permissions reuse `CryptoExchange` View/Create/Edit/Delete. Imports are tenant-scoped through the tenant DB; any Redis or queue key introduced is organization-scoped from the start (piece 1 audit finding).
- The attestation flow and the "never ask for trade or withdraw rights" copy are reused for the new exchanges, with per-exchange help text.
- Dependencies: a CSV parser may be added (candidate: `csv-parse`; review license, size and maintenance in the plan) and a multipart handler if the server does not already have one (check existing upload code first).
- Audit trail: connection created/updated/imported/rolled back events use the existing audit log pattern.
- The security tooling listed in the project instructions applies before any production deployment; piece 2 does not declare itself security-ready.

## 7. Error handling

Reuse piece 1 error classes. New actionable errors: clock skew (Crypto.com nonce window, Pionex timestamp window), IP not allow-listed (Crypto.com 40103), rate-limit cool-down (Pionex), `CSV_FORMAT_UNRECOGNIZED`, `CSV_DUPLICATE_FILE`, `CSV_TOO_LARGE`, `CSV_ROWS_REJECTED` (preview only). Network failures remain retryable with the existing backoff. Note: the owner's dev host (WSL) currently has an IPv6 DNS stall for some exchange hosts; this is environmental and documented, not worked around in code.

## 8. Testing

- Adapters: unit tests with recorded fixtures built from the official docs examples; signing tests with the exchange-published test vectors where they exist (Pionex); fake-fetch tests for pagination, windows, retention limits and error mapping; redaction tests (no secret in logs/errors) matching piece 1.
- CSV: parser tests per exchange and report type from the owner's sample files (sanitized copies committed as fixtures only with the owner's approval); preview/commit/rollback integration tests on a scratch DB; duplicate and overlap tests; hostile-input tests (oversized, malformed quoting, huge fields, wrong encoding/BOM, formulas).
- Webapp: fixture-driven browser checks as in piece 1 (connections page coverage notice, import dialog states).
- Live verification with the owner's read-only keys for Crypto.com and Pionex (adapters only until the authenticated app flow is exercised); explicitly reported as such.

## 9. Delivery plan

| Step | Scope | Needs from owner |
|------|-------|------------------|
| 2a | Crypto.com Exchange adapter and Crypto.com App adapter, registry, UI exchange options, help text, history-coverage flag plumbing and key-expiry surfacing (server + webapp) | Nothing new: the owner's existing Crypto.com App and Exchange keys (in `.env`, stated read-only) are used; they enter the app through the connections form with attestation as described in 3.1 and 3.3. |
| 2b | Pionex adapter | Keys already in `.env` (`PIONEX_EXCHANGE_*`); confirm they are read-only (Pionex cannot tell us, so attestation applies) |
| 2c | CSV core (migration, upload/preview/commit/rollback API, UI) + Pionex parsers | Samples already supplied (Pionex) |
| 2d | Nexo CSV parsers (transactions and futures) + CSV-only connection UI | Samples already supplied (Nexo) |

Each step is its own plan and its own review cycle on branch `feat/crypto-connectors-piece2`.

## 10. Open items

1. Crypto.com Exchange: shape of the `get-deposit-address` error when withdrawal is disabled (needs a read-only Exchange key).
2. Pionex: `balancesFull` entry schema; key-expiry policy (`APIKEY_EXPIRED` exists but rules are undocumented).
3. Crypto.com Exchange `get-trades` / `get-order-history` / `get-transactions` field schemas: the probed key had no trades in range, so these rest on the docs until a live sample exists.
4. Crypto.com App: enums for withdrawals, fiat, card and cashback transactions (none in the probed account) and status values other than `done`.
5. Per-key versus per-IP rate limits for each exchange (currently one shared bucket per exchange).
6. Retention of raw records and balance snapshots (piece 1 follow-up) before CSV adds volume.
7. Pionex `trading.csv` vs `raw-trading-details.csv` overlap: confirm with the owner which is canonical, or keep both with de-duplication as proposed.
8. Nexo API: a future piece, only when Nexo ships API access and documentation.
