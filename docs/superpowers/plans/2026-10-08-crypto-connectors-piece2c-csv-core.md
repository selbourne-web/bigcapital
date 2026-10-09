# Crypto Connectors Piece 2c: CSV Import Core and Pionex Parsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner import exchange CSV exports as a second, previewable, committable and reversible data source on an existing connection, with parsers for the Pionex reports.

**Architecture:** A new `csv/` folder inside `CryptoExchanges` holds a bounded CSV reader, a parser registry keyed by header signature, and one parser per Pionex report. An import service runs preview (parse, hash, de-duplicate, report) then commit (re-sent file, hash verified, batched transactional insert stamped `source='csv'`, `import_id`) and rollback (delete one import's rows). A multipart controller, error codes and a webapp dialog expose it. Raw records stay append-only and idempotent on `(connection_id, record_type, exchange_record_id)`.

**Tech Stack:** NestJS 10, objection/knex tenant migrations, multer (already used by `common/interceptors/file.interceptor.ts`), `csv-parse` (new, MIT, no runtime dependencies), jest `--runInBand --forceExit`, React + Blueprint + react-query v5 (webapp has no test runner).

**Spec:** docs/superpowers/specs/2026-10-06-crypto-connectors-piece2-design.md (sections 4.1, 5, 6, 7). Pionex samples: `~/Screenshots/pionex_txn_2026-01-01_2026-10-07_gen_2026-10-07/`.

## Global Constraints

- Node 18.16.1 runtime (API), nvm 22 for tooling. Every WSL command starts `source ~/.nvm/nvm.sh && nvm use 22`. Jest always `--runInBand --forceExit`, one heavy command at a time.
- Amounts are decimal strings, never floats (`adapters/shared.ts`: `isDecimal`, `addDecimal`, `subDecimal`, `decimalEquals`, `normalizeDecimal`). No formula evaluation; cell text is data.
- CSV is untrusted input: file cap 10 MB, row cap 200,000, header-signature gating before row processing, filename used for display only (sanitized, max 255 chars, no path).
- Header matching: trim whitespace and a UTF-8 BOM, case-sensitive exact column names.
- Pionex timestamps are `date(UTC+0)`, format `YYYY-MM-DD HH:mm:ss`, parsed as UTC.
- Raw records are append-only and idempotent; `exchange_record_id` is `varchar(191)`; `record_type` is `varchar(16)` (every new type name must be 16 characters or fewer).
- CSV record ids: `csv:` + sha256 hex of (`parserId` + `\n` + canonical JSON of the row's raw cells in header order) and, for the n-th identical row in one file (n >= 1), the suffix `:n`.
- Permissions reuse `CryptoExchange`: preview/commit/list = Create/View, rollback = Delete. Any queue or Redis key is organization-scoped (none planned).
- Fixtures are synthetic, shape-identical to the owner's real samples (changed numbers and dates); never commit the owner's real files. Never run prettier on `__fixtures__`. LF line endings. Do not touch `.claude/`. Do not push. Never print `.env` values.
- Git identity Scott Griffith <sjc.griffith@selbourne.co>; commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; husky needs nvm sourced in the same shell and may leave the first commit empty (re-stage and retry).
- Tenant migrations are NOT applied by the implementer; the controller applies them with the documented dist CLI after review.

## Rulings made in this plan (owner may override)

1. **Pionex fill overlap (spec open question 7):** `raw-trading-details.csv` (one row per fill, has `order_type` and `state`) is canonical and becomes `trade` records. `trading.csv` is the same fills grouped by `tax_id`; it is stored as `trade_summary` (not for ledger posting) so nothing is double counted.
2. **Non-FILLED order rows** (`state` other than `FILLED`, or `executed_qty` of zero) are stored as `unparsed` and counted, never as `trade`.
3. **Commit re-sends the file** (stateless): no staging table, no file on disk. The server verifies the sha256 equals the preview's, else `CSV_FILE_CHANGED`.
4. **Cross-source overlap:** a CSV fill has no exchange id, so it cannot match an API fill by key. Preview reports `apiOverlap` (count of API `trade` records inside the file's date range) and piece 3 reconciles by natural key. Recorded as a piece-3 carry note.
5. Credential columns become nullable and `csv_only` creation are deferred to 2d; 2c adds `mode` only as a column with default `api`.

## Review Focus

- A file with a BOM, CRLF line endings and a quoted field containing a comma and a newline parses to the same rows as the plain file.
- A cell starting with `=`, `+`, `-` or `@` is stored verbatim and never evaluated; negative amounts such as `-0.00024780982935618` remain valid decimals.
- Two identical rows inside one file both import (suffix `:1`); uploading the same file twice is refused (`CSV_DUPLICATE_FILE`); two overlapping files import each row once.
- A Nexo or Binance file uploaded to a Pionex connection fails `CSV_FORMAT_UNRECOGNIZED` and writes nothing; the `for-cointracker` and `for-cointracking` files fail `CSV_DERIVED_EXPORT_REFUSED`.
- An 11 MB file, a 200,001-row file, a header-only recognized file, a truncated last line, an invalid date and a non-decimal amount each end in a defined result (413 / 413 / zero-row preview / rejected row with line number).
- Rolling back import A leaves import B's and all API rows untouched; rolling back twice is a no-op error, not a crash.

---

### Task 1: Dependency, migration, models and constants

**Files:**
- Modify: `packages/server/package.json` (add `csv-parse`, exact latest 5.x or 6.x compatible with Node 18; record license, version and zero runtime dependencies in the commit body)
- Create: `packages/server/src/database/tenant/migrations/20261008000000_create_crypto_csv_imports.ts`
- Create: `packages/server/src/modules/CryptoExchanges/models/CryptoCsvImport.ts`
- Modify: `models/CryptoRawRecord.ts` (add `source: 'api' | 'csv'`, `importId: number | null`), `models/CryptoConnection.ts` (add `mode: 'api' | 'csv_only'`), `CryptoExchanges.constants.ts` (record types, import statuses, limits), `CryptoExchanges.module.ts` (register `CryptoCsvImport`)
- Modify: `commands/CryptoConnectionView.ts` (expose `mode`)
- Test: `CryptoExchanges.constants.spec.ts`, `CryptoSchema.spec.ts` (DB-gated, scratch DB)

**Interfaces:**
- Produces (constants): `CryptoRecordType` gains `'trade_summary' | 'funding' | 'adjustment' | 'position'`; `export type CsvImportStatus = 'previewed' | 'committed' | 'rolled_back' | 'failed'`; `export const CSV_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 200_000, maxCellChars: 2_000, maxFilenameChars: 255 } as const`.
- Produces (model): `CryptoCsvImport` table `crypto_csv_imports` with the spec's columns (id, connection_id FK CASCADE, exchange, report_type, original_filename, file_sha256 char(64), row_count, rows_imported, rows_skipped_duplicate, rows_rejected, date_from, date_to, status, error, created_at, committed_at, uploaded_by) plus unique `(connection_id, file_sha256)` only for status `committed` enforced in service logic (not a DB unique, so a rolled-back file can be re-imported).
- Migration: `crypto_connections.mode varchar(16) not null default 'api'`; `crypto_raw_records.source varchar(8) not null default 'api'`, `import_id int unsigned null` FK to `crypto_csv_imports(id)` ON DELETE SET NULL plus index `(import_id)`.

- [ ] **Step 1: Write failing tests.** Constants spec: the four new record types exist, every `CryptoRecordType` literal is at most 16 characters, `CSV_LIMITS` values equal the Global Constraints. Schema spec (gated): after migrating a scratch DB, `crypto_raw_records.source` defaults to `'api'`, an insert with a nonexistent `import_id` fails, deleting an import sets its rows' `import_id` to null, and `crypto_connections.mode` defaults to `'api'`.
- [ ] **Step 2: Run them; expect FAIL** (missing exports/columns). Command: `npx jest --runInBand --forceExit src/modules/CryptoExchanges/CryptoExchanges.constants.spec.ts` from `packages/server`.
- [ ] **Step 3: Implement** the dependency (`pnpm add csv-parse` in `packages/server`; check `npm view csv-parse license dependencies` first), the migration (with `down`), model, model field additions, constants, module registration, connection-view `mode`.
- [ ] **Step 4: Run** constants spec plus the model/module specs (`CryptoExchanges.module.spec.ts`) and `npx tsc --noEmit -p packages/server` filtered to CryptoExchanges; run `CryptoSchema.spec.ts` against a scratch DB (`TEST_TENANT_DB`, see how earlier specs created it; drop the scratch DB afterwards). Expected: all pass.
- [ ] **Step 5: Commit** `feat(server): CSV import tables, raw-record source columns and constants`.

---

### Task 2: CSV reader and parser registry (exchange-agnostic core)

**Files:**
- Create: `packages/server/src/modules/CryptoExchanges/csv/csv.types.ts`, `csv/CsvReader.ts`, `csv/CsvParserRegistry.ts`, `csv/csvRecordId.ts`
- Test: `csv/CsvReader.spec.ts`, `csv/CsvParserRegistry.spec.ts`, `csv/csvRecordId.spec.ts`, fixtures under `csv/__fixtures__/` (synthetic)

**Interfaces:**
- Produces (`csv.types.ts`):
  ```ts
  export interface CsvRecordInput { recordType: CryptoRecordType; occurredAt: Date; payload: Record<string, unknown>; }
  export type CsvRowResult = { kind: 'record'; record: CsvRecordInput } | { kind: 'reject'; reason: string };
  export interface CsvParser {
    readonly id: string;               // e.g. 'pionex:raw-trading-details'
    readonly exchange: CryptoExchangeId;
    readonly reportType: string;
    readonly disposition: 'import' | 'refuse';
    readonly refuseReason?: string;    // required when disposition === 'refuse'
    matches(headers: string[]): boolean;   // exact signature after trim/BOM strip
    parseRow(row: Record<string, string>, ctx: { line: number }): CsvRowResult;
  }
  export interface ReadCsvResult { headers: string[]; rows: Array<{ line: number; cells: Record<string, string> }>; rejected: Array<{ line: number; reason: string }>; }
  export class CsvImportError extends Error { constructor(readonly code: CsvErrorCode, message: string, readonly details?: Record<string, unknown>) }
  export type CsvErrorCode = 'CSV_FORMAT_UNRECOGNIZED' | 'CSV_DERIVED_EXPORT_REFUSED' | 'CSV_DUPLICATE_FILE' | 'CSV_TOO_LARGE' | 'CSV_FILE_CHANGED' | 'CSV_NOT_ROLLBACKABLE' | 'CSV_MALFORMED';
  ```
- Produces (`CsvReader.ts`): `readCsv(buffer: Buffer): ReadCsvResult` (throws `CsvImportError('CSV_TOO_LARGE')` above `CSV_LIMITS.maxBytes` or `maxRows`, `'CSV_MALFORMED'` on parse failure or a cell above `maxCellChars`). Uses `csv-parse/sync` with `bom: true`, `relax_column_count: false`, `skip_empty_lines: true`, `trim: false`, header trimmed by the reader; a row with the wrong column count is returned in `rejected` with its line number, not thrown.
- Produces (`CsvParserRegistry.ts`): `class CsvParserRegistry { constructor(parsers: CsvParser[]); resolve(exchange: CryptoExchangeId, headers: string[]): CsvParser }` throwing `CSV_FORMAT_UNRECOGNIZED` (message lists the headers found, truncated to 20 names) when none matches the exchange, or `CSV_DERIVED_EXPORT_REFUSED` (message = `refuseReason`) when the match has `disposition: 'refuse'`.
- Produces (`csvRecordId.ts`): `assignCsvRecordIds(parserId: string, rows: Array<{ cells: Record<string,string>; record: CsvRecordInput }>): Array<{ exchangeRecordId: string; record: CsvRecordInput }>` implementing the id rule in Global Constraints (occurrence counter per identical content).

- [ ] **Step 1: Write failing tests** with these assertions: BOM + CRLF + quoted comma-and-newline cell parse equal to the plain file; a header with a leading space still matches; a data row with too few columns is `rejected` with the right 1-based file line number (header is line 1); 200,001 rows throws `CSV_TOO_LARGE`; 10 MB + 1 byte throws `CSV_TOO_LARGE`; a 2,001-character cell throws `CSV_MALFORMED`; unbalanced quote throws `CSV_MALFORMED`; registry resolves by exact signature, rejects a header set for another exchange with `CSV_FORMAT_UNRECOGNIZED`, rejects a `refuse` parser with `CSV_DERIVED_EXPORT_REFUSED`; two identical rows get ids `X` and `X:1`; the same row set in a different file order yields the same ids; ids are always <= 191 chars.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the four files. Approach: synchronous bounded read (the file is already capped at 10 MB in memory), row cap checked while iterating.
- [ ] **Step 4: Run** the three specs and tsc filter; expect PASS.
- [ ] **Step 5: Commit** `feat(server): bounded CSV reader, parser registry and deterministic record ids`.

---

### Task 3: Pionex parsers

**Files:**
- Create: `csv/parsers/pionex/pionex.csv.shared.ts`, `pionexRawTrading.parser.ts`, `pionexTrading.parser.ts`, `pionexStaking.parser.ts`, `pionexOthers.parser.ts`, `pionexPositionFutures.parser.ts`, `pionexHeaderOnly.parsers.ts` (convert, deposit-withdraw, dust-collector, structured-products), `pionexDerived.parsers.ts` (for-cointracker, for-cointracking), `pionex.parsers.ts` (exports `PIONEX_CSV_PARSERS: CsvParser[]`)
- Test: `csv/parsers/pionex/pionex.parsers.spec.ts`; fixtures `csv/parsers/pionex/__fixtures__/*.csv` (synthetic, one per report, shaped exactly like the samples, 3 to 6 rows each, including a FILLED futures `IOC` row, a `CANCELED` row, a negative `FundingFee`, one `RiskCoverage` row, two identical staking rows)

**Interfaces:**
- Consumes: `CsvParser`, `CsvRowResult` (Task 2); `isDecimal` from `adapters/shared.ts`.
- Produces: `PIONEX_CSV_PARSERS` with ids `pionex:raw-trading-details`, `pionex:trading`, `pionex:staking`, `pionex:others`, `pionex:position-futures`, `pionex:convert`, `pionex:deposit-withdraw`, `pionex:dust-collector`, `pionex:structured-products` (all `import`), `pionex:for-cointracker`, `pionex:for-cointracking` (both `refuse`, reason "Derived export in a third-party format; import the original Pionex reports instead.").
- Signatures (exact header arrays, in order): raw-trading-details `date(UTC+0),executed_qty,amount,price,order_type,side,symbol,state,fee,fee_coin,market_type,tax_id`; trading `date(UTC+0),executed_qty,amount,price,side,symbol,fee,fee_coin,market_type,tax_id`; staking `date(UTC+0),Received Quantity,Received Currency,Sent Quantity,Sent Currency,tag`; others `date(UTC+0),coin,amount,tag,comment`; position_futures `position_id,symbol,position_side,open_time,close_time,pnl,fee,funding_fee`; convert `date(UTC+0),sell_coin,sell_amount,buy_coin,buy_amount`; deposit-withdraw `date(UTC+0),tx_type,amount,coin,network,txid,fee`; dust-collector `date(UTC+0),amount,coin,price,swap_value`; structured-products `date(UTC+0),Received Quantity,Received Currency,Sent Quantity,Sent Currency`; for-cointracker `Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag`; for-cointracking `Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID`.
- Row mapping: raw-trading-details FILLED with `executed_qty` > 0 -> `trade` (payload keeps every raw cell plus `normalizedBase`/`normalizedQuote` split from `symbol` on `_`, `PERP` suffix kept in symbol, and `source: 'csv'`), otherwise `unparsed` (ruling 2). trading -> `trade_summary`. staking: a Received row -> `reward`, a row with Sent Quantity -> `unparsed`. others: `tag` `FundingFee` -> `funding` (amount signed), any other tag (`RiskCoverage`, unknown) -> `adjustment`. position_futures -> `position` with `occurredAt` = `close_time`. Header-only parsers: any data row -> `unparsed` (row semantics unproven; signature recognized, no rows in the samples). All times parsed as UTC; invalid date or non-decimal amount/price/fee -> `reject` with a reason naming the column. Never throw from `parseRow`.

- [ ] **Step 1: Write failing tests**: each fixture resolves to the expected parser id via a `CsvParserRegistry` built from `PIONEX_CSV_PARSERS`; mapping assertions for each row kind above, including the signed `FundingFee`, the `CANCELED` row becoming `unparsed`, an invalid `date(UTC+0)` and a non-decimal `price` producing `reject` with the column name, timestamps equal to the exact UTC `Date`, symbol `ZEC_USDT_PERP` kept verbatim, two identical staking rows importing as two records, a Nexo-style header set failing `CSV_FORMAT_UNRECOGNIZED`, both derived headers failing `CSV_DERIVED_EXPORT_REFUSED`, a header-only file producing zero records and zero rejects.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the parsers (shared helpers for UTC parsing and decimal checks in `pionex.csv.shared.ts`).
- [ ] **Step 4: Run** the spec and tsc filter. Then a throwaway script (scratchpad, not committed) feeds the owner's real sample files through `readCsv` + registry + `parseRow` and prints per-file counts of records by type and rejects; expect zero rejects for `trading`, `raw-trading-details`, `staking`, `others`, `position_futures` and the two derived files refused. Report the counts.
- [ ] **Step 5: Commit** `feat(server): Pionex CSV parsers for trading, staking, funding and futures reports`.

---

### Task 4: Import service (preview, commit, list, rollback)

**Files:**
- Create: `commands/PreviewCryptoCsvImport.service.ts`, `commands/CommitCryptoCsvImport.service.ts`, `commands/RollbackCryptoCsvImport.service.ts`, `queries/GetCryptoCsvImports.service.ts`, `csv/CsvImport.service.ts` (shared parse-and-plan used by preview and commit), `csv/csvImport.types.ts`
- Modify: `CryptoExchanges.module.ts` (providers, `CSV_PARSER_REGISTRY` provider built from `PIONEX_CSV_PARSERS`)
- Test: `commands/CryptoCsvImport.service.spec.ts` (unit with fakes in `commands/testFakes.ts` style) and `commands/CryptoCsvImport.integration.spec.ts` (scratch DB, gated like the other integration specs)

**Interfaces:**
- Consumes: `readCsv`, `CsvParserRegistry.resolve`, `assignCsvRecordIds` (Task 2); `PIONEX_CSV_PARSERS` (Task 3); models from Task 1.
- Produces (`csvImport.types.ts`):
  ```ts
  export interface CsvImportPreview { importId: number; connectionId: number; exchange: CryptoExchangeId; reportType: string; filename: string; fileSha256: string; rowCount: number; importable: number; alreadyImported: number; rejectedCount: number; rejected: Array<{ line: number; reason: string }>; /* first 50 */ byType: Record<string, number>; dateFrom: string | null; dateTo: string | null; apiOverlap: number; }
  export interface CsvImportView { id: number; connectionId: number; reportType: string; filename: string; rowCount: number; rowsImported: number; rowsSkippedDuplicate: number; rowsRejected: number; dateFrom: string | null; dateTo: string | null; status: CsvImportStatus; createdAt: string; committedAt: string | null; }
  ```
- Produces services: `PreviewCryptoCsvImportService.execute(connectionId: number, file: { buffer: Buffer; originalname: string }, userId: number): Promise<CsvImportPreview>`; `CommitCryptoCsvImportService.execute(importId: number, file: { buffer: Buffer }): Promise<CsvImportView>`; `RollbackCryptoCsvImportService.execute(importId: number): Promise<CsvImportView>`; `GetCryptoCsvImportsService.execute(connectionId: number): Promise<CsvImportView[]>`.
- Behavior: preview refuses a connection that is deleted or whose exchange has no registered parsers (`CSV_FORMAT_UNRECOGNIZED`); computes sha256 of the buffer; refuses `CSV_DUPLICATE_FILE` when a `committed` import of the same `(connection_id, file_sha256)` exists; creates a `previewed` import row (and deletes this connection's `previewed` imports older than 24 h); `alreadyImported` = ids already present in `crypto_raw_records` for the connection+type (chunked `whereIn` of at most 1,000 ids); `apiOverlap` = count of `source='api'` `trade` records for the connection with `occurredAt` between `dateFrom` and `dateTo`. Commit re-parses the re-sent file, requires status `previewed` and an equal sha256 (`CSV_FILE_CHANGED` otherwise), inserts in batches of 500 inside one transaction with `source='csv'`, `import_id`, `payload_hash` computed as the sync engine does (reuse its helper; if private, extract it to `utils/` in this task), ignoring duplicate keys (`ON DUPLICATE KEY` no-op via the same duplicate-key fallback pattern as the sync engine), then sets counts, `status='committed'`, `committed_at`. Rollback requires status `committed` (else `CSV_NOT_ROLLBACKABLE`), deletes `crypto_raw_records WHERE import_id = ? AND source = 'csv'` in chunks, sets `status='rolled_back'`. A connection event is emitted for imported and rolled back using the existing `emitConnectionEvent` pattern.

- [ ] **Step 1: Write failing tests** (unit with fakes): preview of a Pionex fixture returns counts and `byType`, date range from min/max `occurredAt`, rejected list capped at 50 with correct `rejectedCount`; same file after commit -> `CSV_DUPLICATE_FILE`; same file after rollback previews again; a wrong-exchange file -> `CSV_FORMAT_UNRECOGNIZED` and no import row created; commit with changed bytes -> `CSV_FILE_CHANGED`; commit of an already committed import -> error; two overlapping files import each id once and the second reports `rowsSkippedDuplicate`; abandoned previews older than 24 h are deleted; rollback of import A leaves import B's rows and API rows. Integration (scratch DB): real insert of 1,200 rows commits in batches in one transaction and a forced failure on batch 2 leaves zero rows; rollback removes exactly that import's rows; `previewed` import for a deleted connection is gone via CASCADE.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the services and wiring. Approach: `CsvImport.service.ts` owns parse + id assignment + plan so preview and commit cannot diverge.
- [ ] **Step 4: Run** unit specs, the integration spec against a scratch DB (create and drop it as earlier tasks did; `accounts.id` must be `INT UNSIGNED`), the whole `src/modules/CryptoExchanges` directory, and tsc filter. Report skipped counts honestly.
- [ ] **Step 5: Commit** `feat(server): CSV import preview, commit, list and rollback services`.

---

### Task 5: REST endpoints, error mapping and swagger

**Files:**
- Modify: `CryptoExchanges.controller.ts`, `CryptoExchanges.filter.ts`, `CryptoExchanges.swagger.ts`, `CryptoExchanges.module.ts` (multer options)
- Create: `dtos/CsvImportParams.dto.ts` if params need validation beyond `ParseIntPipe`
- Test: `CryptoExchanges.controller.spec.ts` (extend), `CryptoExchanges.filter` cases in the existing spec file, `CryptoExchanges.csv.wire.spec.ts` (HTTP-level with supertest/Nest testing module like `CryptoExchanges.wire.spec.ts`)

**Interfaces:**
- Consumes: the four services (Task 4), `CsvImportError`, `CSV_LIMITS`.
- Produces endpoints (all under `/api/crypto`, `AuthorizationGuard` + `PermissionGuard`): `POST connections/:id/imports` multipart field `file`, Create ability, returns `CsvImportPreview` (201); `POST imports/:importId/commit` multipart field `file`, Create ability, returns `CsvImportView`; `GET connections/:id/imports`, View ability, returns `CsvImportView[]`; `DELETE imports/:importId`, Delete ability, returns `CsvImportView`. Multer: memory storage, `limits.fileSize = CSV_LIMITS.maxBytes`, `files: 1`, extension `.csv` and a text-ish mimetype check (`text/csv`, `application/vnd.ms-excel`, `text/plain`, `application/octet-stream`); wrong type -> 415-style `CSV_FORMAT_UNRECOGNIZED`; multer's size error -> `CSV_TOO_LARGE`.
- Error mapping in the filter (body `{ code, message }`, no stack, no row contents): `CSV_FORMAT_UNRECOGNIZED` 422, `CSV_DERIVED_EXPORT_REFUSED` 422, `CSV_MALFORMED` 422, `CSV_DUPLICATE_FILE` 409, `CSV_FILE_CHANGED` 409, `CSV_NOT_ROLLBACKABLE` 409, `CSV_TOO_LARGE` 413.

- [ ] **Step 1: Write failing tests**: each endpoint enforces its ability (user without Create gets 403 on preview/commit, without Delete 403 on rollback, without View 403 on list); each `CsvErrorCode` maps to the listed status with a stable `code`; an 11 MB upload gets 413 `CSV_TOO_LARGE`; a `.exe` or `.csv` with `image/png` gets rejected; a sanitized filename (path separators and control characters stripped, max 255) is what is stored; the response never includes parsed row payloads beyond the capped rejected list; a multipart request with two files is rejected.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** reusing `common/interceptors/file.interceptor.ts` (`FileInterceptor('file', { storage: multer.memoryStorage(), limits, fileFilter })`) and the existing `ForbiddenException` ability checks used by sibling handlers.
- [ ] **Step 4: Run** the controller, filter and wire specs, the whole CryptoExchanges dir, tsc filter.
- [ ] **Step 5: Commit** `feat(server): CSV import REST endpoints with upload limits and error codes`.

---

### Task 6: Webapp import dialog and history

**Files:**
- Modify: `packages/webapp/src/hooks/query/crypto.ts` (hooks), `containers/Crypto/exchanges.ts` (`CSV_IMPORT_EXCHANGES = ['pionex']`, `supportsCsvImport(exchange)`), `containers/Preferences/CryptoConnections/ConnectionRow.tsx` (Import CSV action, import-history toggle), `CryptoConnections.module.scss`
- Create: `containers/Preferences/CryptoConnections/ImportCsvDialog.tsx`, `ImportHistory.tsx`

**Interfaces:**
- Consumes: the four endpoints (Task 5); `describeCryptoError` for server error mapping (extend its switch with the seven `CSV_*` codes and plain-language messages).
- Produces hooks: `useCryptoCsvImports(connectionId: number, options?)`, `usePreviewCryptoCsv()` (mutation `{ connectionId, file }` -> `CsvImportPreview`), `useCommitCryptoCsv()` (mutation `{ importId, file }`), `useRollbackCryptoCsv()` (mutation `{ importId }`); all invalidate the imports query, and commit/rollback also invalidate `['crypto','balances']` and connections.
- UI: choose-file (accept `.csv`, client-side 10 MB check), preview table (counts, date range, by-type, rejected rows with line numbers, `apiOverlap` note "Piece 3 will reconcile overlap with API history"), Confirm import, result summary; import history list with status, counts, date range and a Roll back button behind a confirmation Alert. Blueprint/SCSS, keyboard-accessible, `aria-live` on result, disabled-state while pending, no file contents rendered beyond the preview fields; reuse the existing History-limited notice's "Import CSV" action text.

- [ ] **Step 1: Implement** hooks and components following the AddConnectionDialog patterns (the webapp has no test runner: say so).
- [ ] **Step 2: Verify** with `npx tsc --noEmit -p packages/webapp` filtered to the touched files and `npx eslint` on them (no new errors); then a browser pass against the running dev app is the owner's check, not claimed.
- [ ] **Step 3: Commit** `feat(webapp): Pionex CSV import dialog, preview and rollback history`.

---

### Task 7: Real-sample verification, docs and templates

**Files:**
- Create: `.claude/docs/task-log/2026-10-08-crypto-connectors-piece2c.md` (force-add, local only), update `.claude/docs/project-state.md` and the template `.claude/docs/templates/credential-vault-and-exchange-adapter-pattern.md` with a CSV-import section
- Create: `docs/superpowers/research/2026-10-08-pionex-csv-samples.md` (shapes, ruling 1, counts; no real values)

- [ ] **Step 1:** Run the real sample files end to end through preview and commit on a scratch DB with the built services (throwaway script): expected record counts by type, zero rejects, second upload of the same file refused, rollback restores zero CSV rows. Record exact counts in the research note.
- [ ] **Step 2:** Write the docs, including known limitations (header-only report semantics unproven, cross-source overlap reconciled in piece 3, no 2d CSV-only creation yet, security tools not run) and security notes (untrusted input handling, caps, no file storage).
- [ ] **Step 3: Commit** docs (`git add -f` for `.claude/docs`; never stage `.claude/CLAUDE.md`).
