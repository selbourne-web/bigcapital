# Crypto Connectors Piece 2d (Nexo CSV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner add a CSV-only "Nexo" connection (no API key, no adapter) and import Nexo's two exports (transactions, futures transactions) through the existing preview, commit and rollback pipeline.

**Architecture:** Two new parser modules (`nexo:transactions`, `nexo:futures`) registered in the existing `CsvParserRegistry`; a new `mode = 'csv_only'` connection created through a separate route that skips the adapter probe, the vault, the `created` event and the sync queues; every API-only action is guarded server side (409 `CRYPTO_CONNECTION_CSV_ONLY`) and hidden in the webapp. Imported records are raw records only (like Pionex CSV): they do not feed balances or the ledger; piece 3 interprets them.

**Tech Stack:** NestJS 10, Objection/Knex (MariaDB 10.2, utf8mb3), csv-parse (existing `readCsv`), Jest (`--runInBand --forceExit`), React 18 + Blueprint 4 + SCSS modules (webapp has no test runner).

**Spec:** `docs/superpowers/specs/2026-10-06-crypto-connectors-piece2-design.md` (sections 3.4, 5.1, 5.3, 5.4); sample facts: `docs/superpowers/research/2026-10-11-nexo-csv-samples.md`; CSV core plan for conventions: `docs/superpowers/plans/2026-10-08-crypto-connectors-piece2c-csv-core.md`.

## Global Constraints

- Node 22 for every command (`source ~/.nvm/nvm.sh; nvm use 22`); the systemd API service runs Node 18.16.1, so no Node 20+ only APIs in server code.
- Jest always `--runInBand --forceExit`; ONE heavy WSL job at a time; scratch DB convention `TEST_TENANT_DB=scratch_*` (create and drop your own; a stub `accounts` table needs `is_syncing_owner`).
- Amounts are decimal strings, never floats. Timestamps are UTC `Date`. Nexo transactions dates are `YYYY-MM-DD HH:MM:SS` UTC; Nexo futures timestamps are epoch milliseconds.
- Fixtures are SYNTHETIC (shape-faithful, invented values, never copied from the owner's files; an earlier task failed review for deriving fixtures from real values). Real files are used only in Task 6, outside git, and no real value (amount, id, timestamp, name) is ever recorded in code, docs, logs or commit messages.
- Record ids stay `csv:` + content hash (`csv/csvRecordId.ts`); they cannot be supplied by a parser. Do not change them.
- Database table names print UPPERCASE on this MariaDB (`CRYPTO_CSV_IMPORTS`); use the model/knex layer, not raw lowercase SQL against the live DB.
- Commit scopes must be one of server, webapp, utils, email-components, pdf-templates, sdk-ts. Run commits with nvm sourced (pre-commit runs `git add -A`; CRLF-noise files `.husky/*`, `docker/garage/setup.sh`, `docs/superpowers/research/2026-10-06-cryptocom-live-probe.md` may show modified in the Windows view only: never commit them; never stage `.claude/CLAUDE.md`). Every commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push.
- The Nexo `Details` column can contain a person's name: it is stored in the raw payload but must never appear in logs, error messages, preview output, audit metadata or API responses other than the allow-listed ones.

## Rulings (decided here; flagged for owner review)

1. **No credential-nullability migration.** csv_only rows store `''` in `api_key_encrypted`/`api_secret_encrypted` (the same convention `archive()` already uses). The spec §5.1 says the columns become nullable; this plan deviates to avoid a schema change for a row that is never decrypted. If wrong: one migration + model typing.
2. **Separate create route** `POST /api/crypto/connections/csv-only` (not an extension of the key-based DTO) so the key-based path keeps its required-credential validation.
3. **Two new record types** `transfer` (internal moves, 8 chars) and `credit` (loan/credit-line activity, 6 chars) are added to `CRYPTO_RECORD_TYPES`; the column is `varchar(16)` with no DB check, so no migration.
4. **Provisional type mapping** (raw records only, piece 3 re-interprets): see Task 2/3 tables. Anything not listed becomes `unparsed` and is counted, never dropped.
5. **Cross-file overlap is not suppressed.** The transactions file's `Transfer To Advanced` (43 rows) and the futures file's `TRANSFER_TO_WALLET` (43 rows) describe the same transfers; both import as `transfer` records. Piece 3 must treat the pair as one internal transfer. Documented, not de-duplicated.
6. **Interest is not one event.** `Interest` rows with negative `Input Amount` (likely charges on credit lines) map to `adjustment`, positive to `reward`; the raw `Credit Line` and amounts stay in the payload.
7. **Balances:** a csv_only connection shows no balances (balances come from snapshots only). Stated limitation until piece 3.

## Review Focus

- A Nexo file uploaded to a Pionex (or other API) connection, or a Pionex file to the Nexo connection, is refused with `CSV_FORMAT_UNRECOGNIZED` (registry matches by connection exchange) — Task 3.
- A csv_only connection must not 500 any page or action: `GET /connections` list, Sync now, Pause/Resume, Rotate key, Reconnect, Delete — Task 4 (guards return 409 `CRYPTO_CONNECTION_CSV_ONLY`; list works; delete works).
- Nexo `null` literal, `-` literal and empty-string tokens, `$` USD Equivalent, negative/zero amounts, up to 8 decimals, leading-space `" Id"` header, mixed-case `Side` — Tasks 1-3.
- `Details` (may contain a name) never leaves the server except inside the stored raw payload — Task 2 (test on preview/error output).
- An unknown `Type` in a recognised file is stored as `unparsed`, counted, and does not abort the import — Tasks 2-3.

---

### Task 1: Shared CSV helpers, record types and Nexo value helpers

**Files:**
- Create: `packages/server/src/modules/CryptoExchanges/csv/parsers/csv.shared.ts`, `.../csv/parsers/nexo/nexo.csv.shared.ts`, `.../csv/parsers/nexo/nexo.csv.shared.spec.ts`
- Modify: `.../csv/parsers/pionex/pionex.csv.shared.ts` (re-export the generic helpers from `csv.shared.ts`), `CryptoExchanges.constants.ts` (`CRYPTO_RECORD_TYPES`)
- Test: `nexo.csv.shared.spec.ts`; existing `pionex.parsers.spec.ts` must stay green.

**Interfaces:**
- Consumes: existing helpers in `pionex.csv.shared.ts` (`importParser`, `safe`, `dateOrReject`, `firstBadDecimal`, `record`, `reject`, `rawPayload`, `parseUtc`, `isSignedDecimal`): read the file first; move the exchange-neutral ones (`importParser`, `safe`, `record`, `reject`, `rawPayload`, `isSignedDecimal`, `firstBadDecimal`) into `csv.shared.ts` unchanged and re-export them from the Pionex file so no Pionex import path changes.
- Produces in `nexo.csv.shared.ts`:
  - `parseNexoUtc(text: string): Date | null` — strictly `YYYY-MM-DD HH:MM:SS`, valid calendar date, interpreted as UTC, else `null`.
  - `parseEpochMs(text: string): Date | null` — 13-digit integer string within 2015-01-01..2100-01-01, else `null`.
  - `nexoCell(text: string | undefined): string | null` — trims; returns `null` for `''`, `'-'` and case-insensitive `'null'`, else the trimmed text.
  - `isNexoDecimal(text: string): boolean` — plain signed decimal, up to 12 fractional digits, no exponent, no separators.
  - `isNexoUsd(text: string): boolean` — exactly `$` followed by a non-negative plain decimal (`$d+` or `$d+.d+`); no sign, no separators.
- `CRYPTO_RECORD_TYPES` gains `'transfer'` and `'credit'`.

- [ ] **Step 1: Write failing tests** in `nexo.csv.shared.spec.ts`: `parseNexoUtc('2026-01-31 23:59:59')` equals `new Date(Date.UTC(2026,0,31,23,59,59))`; rejects `'2026-02-30 00:00:00'`, `'2026-01-31T23:59:59Z'`, `'31/01/2026'`, `''`; `parseEpochMs('1767225600000')` is `new Date(1767225600000)`, rejects `'1767225600'`, `'abc'`, `'99999999999999'`; `nexoCell` maps `' - '`, `'null'`, `'NULL'`, `''` to `null` and keeps `'0'`, `'xUSD'`; `isNexoDecimal` accepts `'0'`, `'-0.00000001'`, `'12.5'`, rejects `'1,000.5'`, `'1e-8'`, `'$5'`, `'.5'`, `''`; `isNexoUsd` accepts `'$0.00'`, `'$123.45'`, rejects `'123.45'`, `'-$5.00'`, `'$1,000.00'`. Add a test that `CRYPTO_RECORD_TYPES` contains `transfer` and `credit`.
- [ ] **Step 2: Run** `npx jest --runInBand --forceExit src/modules/CryptoExchanges/csv/parsers/nexo` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the helper moves and the five functions above; one regex or hand parse each, no new dependency.
- [ ] **Step 4: Run** the nexo helper spec and `src/modules/CryptoExchanges/csv` entirely — expect PASS, Pionex parser specs unchanged and green; server `tsc --noEmit` shows 0 CryptoExchanges errors.
- [ ] **Step 5: Commit** `refactor(server): share CSV parser helpers and add Nexo value helpers and record types`.

---

### Task 2: Nexo transactions parser

**Files:**
- Create: `.../csv/parsers/nexo/nexoTransactions.parser.ts`, `.../csv/parsers/nexo/nexo.parsers.ts`, `.../csv/parsers/nexo/nexoTransactions.parser.spec.ts`, `.../csv/parsers/nexo/__fixtures__/transactions.csv` (synthetic, 12-20 rows)
- Test: `nexoTransactions.parser.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `CsvParser`, `CsvRowResult` from `csv/csv.types.ts`; `readCsv` for the spec.
- Produces: `NEXO_TRANSACTIONS_PARSER: CsvParser` with `id: 'nexo:transactions'`, `exchange: 'nexo'`, `reportType: 'transactions'`, `disposition: 'import'`; header signature exactly `Transaction, Type, Credit Line, Input Currency, Input Amount, Output Currency, Output Amount, USD Equivalent, Fee, Fee Currency, Details, Date / Time (UTC)` (after the reader's trim); `NEXO_CSV_PARSERS: CsvParser[]` exported from `nexo.parsers.ts` (Task 3 appends the futures parser).
- Row rules: `occurredAt = parseNexoUtc('Date / Time (UTC)')` else reject `'Unrecognised date.'`; `Transaction` must be non-empty else reject; `Input Amount`/`Output Amount` must satisfy `isNexoDecimal` (Output `0` allowed; Output Currency `-` allowed) else reject naming the column, never the value; `USD Equivalent` must satisfy `isNexoUsd` else reject; `Fee` is `nexoCell` and, when non-null, `isNexoDecimal`. Payload = `rawPayload(row)` (all raw cells + `source:'csv'`).

Type mapping (`Type` column, exact match; Task 2's table is the contract):

| Type | recordType |
|---|---|
| `Interest` with Input > 0 | `reward` |
| `Interest` with Input < 0, or Input = 0 | `adjustment` |
| `Fixed Term Interest`, `Dividend`, `Exchange Cashback`, `Earn Adjustment` | `reward` (Earn Adjustment: `adjustment`) |
| `Exchange`, `Exchange Credit`, `Exchange Booster`, `Exchange Deposited On` | `trade` |
| `Deposit To Exchange`, `Top up Crypto` | `deposit` |
| `Withdrawal` | `withdrawal` |
| `Transfer In`, `Transfer Out`, `Transfer To Pro Wallet`, `Transfer From Pro Wallet`, `Locking Term Deposit`, `Unlocking Term Deposit`, `Transfer To Advanced`, and the Advanced Trading Bonus transfer/fund types listed in the research note | `transfer` |
| `Loan Withdrawal`, `Manual Repayment`, `Manual Sell Order`, `Exchange Liquidation`, `Deposit Over Repayment` | `credit` |
| anything else | `unparsed` |

(The exact Type strings come from `docs/superpowers/research/2026-10-11-nexo-csv-samples.md`; implement the mapping as one `Record<string, ...>` table plus the Interest sign rule so the table is the single source of truth and a test iterates every key.)

- [ ] **Step 1: Write failing tests**: (a) the fixture parses with the expected record types per row (table-driven over every mapped Type string, including Interest +/-/0 and an unknown Type -> `unparsed`); (b) `matches` is true for the exact header and false for the Pionex trading header and for the futures header; (c) a leading space or BOM in the first header still matches when read through `readCsv`; (d) rejects: bad date, non-decimal amount `'1,000'`, USD without `$`, empty Transaction — each reason text contains the column name and never the cell value; (e) `Details` containing `Jane Example` appears in the stored payload but in none of the reject reasons or in `JSON.stringify` of a preview built from the fixture; (f) `-` Fee/Output Currency/Fee Currency accepted; (g) `occurredAt` equals the UTC instant of the cell; (h) two rows identical except `Transaction` get distinct record ids (through `assignCsvRecordIds`).
- [ ] **Step 2: Run** the spec — FAIL.
- [ ] **Step 3: Implement** `nexoTransactions.parser.ts` using the Task 1/`csv.shared.ts` helpers (`importParser` factory) and register it in `nexo.parsers.ts`.
- [ ] **Step 4: Run** the spec and `src/modules/CryptoExchanges/csv` — PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(server): Nexo transactions CSV parser`.

---

### Task 3: Nexo futures parser and registry wiring

**Files:**
- Create: `.../csv/parsers/nexo/nexoFutures.parser.ts`, `.../csv/parsers/nexo/nexoFutures.parser.spec.ts`, `.../csv/parsers/nexo/__fixtures__/futures.csv` (synthetic, 12-20 rows incl. leading-space header)
- Modify: `.../csv/parsers/nexo/nexo.parsers.ts` (append), `CryptoExchanges.module.ts:107-110` (registry factory adds `...NEXO_CSV_PARSERS`)
- Test: `nexoFutures.parser.spec.ts`; extend `CsvParserRegistry.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 `NEXO_CSV_PARSERS`.
- Produces: `NEXO_FUTURES_PARSER: CsvParser`, `id: 'nexo:futures'`, `exchange: 'nexo'`, `reportType: 'futures'`, `disposition: 'import'`; header signature `Id, Timestamp, Symbol, Type, Position, Price, Amount, Status, Asset, Side, DealId, InternalTransactionType, TradingFeeAmount, TradingFeeAsset, ExecutionPriceAsset, ExchangeRate, SourceAsset, SourceAmount` (reader trims the leading space of `" Id"`).
- Row rules: `occurredAt = parseEpochMs(Timestamp)` else reject; `Id` non-empty; `Price`, `Amount`, `TradingFeeAmount`, `ExchangeRate`, `SourceAmount`: `nexoCell` then `isNexoDecimal` when non-null; `Side` and `Position` normalised to lower case only for validation (payload keeps raw cells); an `ORDER` row (`InternalTransactionType='ORDER'`) must have non-null Symbol and Amount.
- Type mapping: `MARKET_OPEN`, `MARKET_CLOSE` (Status `PLACED` or `LIQUIDATED`) -> `trade`; `FUNDING_FEE` -> `funding`; `REALIZED_PNL` -> `position`; `LIQUIDATION_FEE` -> `fee`; `TRANSFER_TO_WALLET` -> `transfer`; anything else -> `unparsed`. Table-driven like Task 2.

- [ ] **Step 1: Write failing tests**: mapping per Type/Status incl. a `LIQUIDATED` close; `null` literals in Position/Status/Price/Symbol accepted; `ExecutionPriceAsset` empty string accepted; mixed-case Side accepted; epoch-ms `occurredAt` exact; bad timestamp (`'1767225600'`) rejected with a reason naming the column only; unknown Type -> `unparsed`; `matches` false for the transactions header and for Pionex headers; registry tests: `resolve('nexo', transactionsHeaders)` -> `nexo:transactions`, `resolve('nexo', futuresHeaders)` -> `nexo:futures`, `resolve('pionex', nexoHeaders)` throws `CSV_FORMAT_UNRECOGNIZED`, `resolve('nexo', pionexHeaders)` throws the same.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the parser, append it to `NEXO_CSV_PARSERS`, and add `...NEXO_CSV_PARSERS` to the registry factory in the module.
- [ ] **Step 4: Run** the nexo and csv specs, `CryptoExchanges.module` boot spec if present, tsc — PASS.
- [ ] **Step 5: Commit** `feat(server): Nexo futures CSV parser and registry wiring`.

---

### Task 4: CSV-only connections (server)

**Files:**
- Create: `dtos/CreateCsvOnlyConnection.dto.ts`, `commands/CreateCsvOnlyConnection.service.ts`, `commands/CreateCsvOnlyConnection.service.spec.ts`, `CryptoExchanges.csvOnly.wire.spec.ts`
- Modify: `CryptoExchanges.constants.ts` (`CSV_ONLY_EXCHANGES = ['nexo'] as const`, error `CRYPTO_CONNECTION_ERRORS.CONNECTION_CSV_ONLY = 'CRYPTO_CONNECTION_CSV_ONLY'`), `CryptoExchanges.controller.ts` (+ route, swagger), `CryptoExchanges.module.ts` (provider), `CryptoExchanges.filter.ts` (409 mapping), `commands/CryptoConnectionView.ts` (`mode` is already in the view; confirm it is serialised), `queries/GetCryptoConnections.service.ts`, `sync/CryptoSyncRequest.service.ts` (selfHeal skips csv_only; `requestManualSync` guard), the pause/resume, rotate-credentials, reconnect handlers and `sync/CryptoSync.subscriber.ts` (mode guards), `CryptoExchanges.swagger.ts`
- Test: the new specs plus extensions of the existing controller/service specs.

**Interfaces:**
- Consumes: `CreateCryptoConnectionService` patterns (account validation/creation, audit log); `CryptoConnection.repository`; `CRYPTO_CONNECTION_ERRORS`.
- Produces: `POST /api/crypto/connections/csv-only` body `{ exchange: 'nexo', label: string, accountId?: number, createAccount?: boolean }` (Create ability; class-validator: exchange `IsIn(CSV_ONLY_EXCHANGES)`, label trimmed non-empty max 255), returns the connection view (201) with `mode: 'csv_only'`, `status: 'active'`; `CreateCsvOnlyConnectionService.execute(dto): Promise<CryptoConnectionView>`; guard helper `assertApiMode(connection)` throwing `ServiceError(CONNECTION_CSV_ONLY)` mapped to 409.
- Behaviour: inserts `mode:'csv_only'`, `apiKeyEncrypted:''`, `apiSecretEncrypted:''`, no vault call, no adapter probe, no `cryptoEvents.connection.created`, no queue scheduling; writes the same audit log entry kind as the key-based create with `mode` in metadata (no secrets exist). `GetCryptoConnections` returns `historyCoverage: null` for csv_only instead of calling `registry.get`. `selfHeal` skips csv_only rows. Sync now, Pause, Resume, Rotate key and Reconnect on a csv_only connection return 409 `CRYPTO_CONNECTION_CSV_ONLY`; Delete (archive) and Import endpoints work. The key-based DTO still rejects `exchange: 'nexo'`.

- [ ] **Step 1: Write failing tests** (service + wire): create succeeds, row has `mode='csv_only'`, empty credential columns, nothing enqueued or scheduled (fake scheduler asserts zero calls), vault never called; DTO rejects `exchange:'pionex'` on the csv-only route and `exchange:'nexo'` on the key route; `GET /connections` with one nexo row returns 200 and the row with `mode:'csv_only'`, `history_coverage: null`; each of the five guarded actions returns 409 with that code; delete works; permission table: Create ability required for the new route; audit entry written; the connection can preview/commit a Nexo fixture via the existing import services (integration with the scratch DB and the real registry).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per the Interfaces block; reuse `CreateCryptoConnectionService`'s account helpers rather than duplicating them (extract a shared private helper if needed).
- [ ] **Step 4: Run** the whole `src/modules/CryptoExchanges` dir without and with `TEST_TENANT_DB`, plus tsc — PASS, 0 failed.
- [ ] **Step 5: Commit** `feat(server): CSV-only crypto connections with API-action guards`.

---

### Task 5: Webapp — add CSV-only connection, hide API actions

**Files:**
- Modify: `packages/webapp/src/hooks/query/crypto.ts` (`mode` on `CryptoConnection` and mapper; `useCreateCsvOnlyConnection`), `containers/Crypto/exchanges.ts` (`CSV_ONLY_EXCHANGES`, add `'nexo'` to `CSV_IMPORT_EXCHANGES`, label "Nexo"), `containers/Preferences/CryptoConnections/AddConnectionDialog.tsx` (describeCryptoError: `CRYPTO_CONNECTION_CSV_ONLY` message), `.../ConnectionRow.tsx`, `.../ImportCsvDialog.tsx` (copy), `.../CryptoConnections.tsx` (new button), `.../CryptoConnections.module.scss`
- Create: `.../AddCsvOnlyConnectionDialog.tsx`

**Interfaces:**
- Consumes: Task 4 route and view (`mode`); existing `AccountPicker`, `describeCryptoError`, Blueprint `Dialog`.
- Produces: an "Add CSV-only connection" button next to "Add connection" opening a dialog with exchange select (options from `CSV_ONLY_EXCHANGES`, label "Nexo (CSV)"), connection label, `AccountPicker` / create-account option (same semantics as the key dialog), no key/secret/passphrase/attestation fields; `ConnectionRow` for `mode==='csv_only'` hides Reconnect, Sync now, Pause/Resume, Rotate key, the "Key ending…/Key saved" line and the key-expiry block, shows a small "CSV only" tag and the history line "Updated by CSV imports only", keeps Import CSV, Import history, Delete; `ImportCsvDialog` intro text for csv_only says "Import a report you exported from <Exchange>. You will see a preview first; nothing is saved until you confirm." (no "the API cannot return"); keyboard accessible; same a11y conventions as `ImportCsvDialog` (focus, live regions, `aria-label`s including the connection label).

- [ ] **Step 1: Implement** the hook, constants, dialog, row guards and copy (webapp has no test runner: say so in the report; export a pure `isCsvOnly(connection): boolean` helper and unit-test it only if a runner exists).
- [ ] **Step 2: Verify** `npx tsc --noEmit -p packages/webapp` filtered to touched files shows 0 errors (the package has pre-existing errors elsewhere: compare against the baseline of 21), `npx eslint` and `npx prettier --check` on touched files clean, Vite dev server returns 200 for the new/changed modules and the SCSS (`?direct`) contains the new classes. Do not claim a browser pass.
- [ ] **Step 3: Commit** `feat(webapp): Nexo CSV-only connection dialog and CSV-only row actions`.

---

### Task 6: Real-sample verification and docs

**Files:**
- Create: `docs/superpowers/research/2026-10-11-nexo-csv-import-verification.md` (counts, timings, mapping table; no real values), `.claude/docs/task-log/2026-10-11-crypto-connectors-piece2d.md` (force-add, local only)
- Modify: `.claude/docs/project-state.md`, `.claude/docs/templates/credential-vault-and-exchange-adapter-pattern.md` (CSV-only connection section); commit the research note `docs/superpowers/research/2026-10-11-nexo-csv-samples.md` created during planning if still uncommitted.

- [ ] **Step 1:** With a throwaway jest spec (deleted afterwards, never committed) on a scratch DB built from the real migrations, create a csv_only nexo connection through `CreateCsvOnlyConnectionService`, then run both real files (`~/Screenshots/nexo_transactions_10-06-2026_22-19-19.csv`, `~/Screenshots/nexo_futures_transactions.csv`) through preview, commit, duplicate re-upload, and rollback. Expected: transactions 13,042 rows and futures 4,670 rows recognised, 0 rejects, counts by record type recorded (print counts only), second upload refused `CSV_DUPLICATE_FILE`, rollback leaves 0 CSV rows, a Pionex file into the Nexo connection and a Nexo file into a Pionex connection both refused. Record commit/rollback timings. If any count or reject differs from expectation, stop and report; do not adjust the parsers to hide it.
- [ ] **Step 2:** Write the docs: mapping table (rulings 3-6), overlap note (ruling 5), limitations (records do not feed balances, mapping provisional until piece 3, loan/bonus semantics unconfirmed, `Details` privacy), security notes, what was not run (ZAP, open-code-review, authenticated live E2E), and the owner's live-check steps.
- [ ] **Step 3: Commit** the research note with `docs(server): Nexo CSV import verification and task log` (`git add -f` for `.claude/docs`; never `.claude/CLAUDE.md`).

---

## Self-review notes

- Spec coverage: §3.4 (CSV-only connection, no adapter) Tasks 4-5; §5.3 Nexo parsers Tasks 2-3 incl. header trimming and `null` literals, ids as content hashes (ruling in constraints); §5.4 UI "Nexo (CSV)" Task 5; unrecognised rows -> `unparsed` Tasks 2-3; large files in bounded batches inherited from the 2c commit path (Task 6 measures 13k rows).
- Deviations: ruling 1 (no nullability migration) and the spec's "exchange's own id column when the export has one" (not possible without changing 2c record ids; content hashes dedupe identical re-exports).
- Types: `CSV_ONLY_EXCHANGES`, `CONNECTION_CSV_ONLY`, `NEXO_CSV_PARSERS`, `nexoCell`, `parseNexoUtc`, `parseEpochMs`, `isNexoDecimal`, `isNexoUsd` are defined once (Tasks 1, 3, 4) and used with those exact names.
