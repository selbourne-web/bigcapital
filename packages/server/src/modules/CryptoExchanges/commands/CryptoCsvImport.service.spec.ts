import { readFileSync } from 'fs';
import { join } from 'path';
import { CsvImportService, sanitizeFilename } from '../csv/CsvImport.service';
import { CsvParserRegistry } from '../csv/CsvParserRegistry';
import { PIONEX_CSV_PARSERS } from '../csv/parsers/pionex/pionex.parsers';
import { CsvImportError } from '../csv/csv.types';
import { cryptoEvents } from '../CryptoExchanges.events';
import { computePayloadHash } from '../utils/payloadHash';
import { PreviewCryptoCsvImportService } from './PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './RollbackCryptoCsvImport.service';
import { GetCryptoCsvImportsService } from '../queries/GetCryptoCsvImports.service';
import {
  FakeAudit,
  FakeCsvImportRepo,
  FakeEvents,
  FakeRepo,
  fakeCls,
} from './testFakes';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../csv/parsers/pionex/__fixtures__', name));

const RAW_HEADER =
  '"date(UTC+0)","executed_qty","amount","price","order_type","side","symbol","state","fee","fee_coin","market_type","tax_id"\n';

/** `good` FILLED trades with distinct seconds, then `bad` rows with a bad decimal. */
const rawTradingCsv = (good: number, bad = 0, startSecond = 0): Buffer => {
  const rows: string[] = [];
  for (let i = 0; i < good + bad; i++) {
    const t = new Date(Date.UTC(2020, 0, 1) + (startSecond + i) * 1000);
    const date = t.toISOString().slice(0, 19).replace('T', ' ');
    const qty = i < good ? '1.5' : 'abc';
    rows.push(
      `"${date}","${qty}","10","6.5","LIMIT","BUY","TEST_USDT","FILLED","0.1","TEST","Spot","s_${i}"`,
    );
  }
  return Buffer.from(RAW_HEADER + rows.join('\n') + '\n');
};

describe('Crypto CSV import services (unit, fakes)', () => {
  let connections: FakeRepo;
  let repo: FakeCsvImportRepo;
  let events: FakeEvents;
  let audit: FakeAudit;
  let preview: PreviewCryptoCsvImportService;
  let commit: CommitCryptoCsvImportService;
  let rollback: RollbackCryptoCsvImportService;
  let list: GetCryptoCsvImportsService;
  let clock: Date;
  let pionexId: number;
  let krakenId: number;

  beforeEach(() => {
    connections = new FakeRepo();
    pionexId = connections.seed({ exchange: 'pionex' }).id;
    krakenId = connections.seed({ exchange: 'kraken' }).id;
    repo = new FakeCsvImportRepo();
    events = new FakeEvents();
    audit = new FakeAudit();
    clock = new Date('2026-10-08T12:00:00Z');
    const csv = new CsvImportService(new CsvParserRegistry(PIONEX_CSV_PARSERS));
    const conns = connections as any;
    const r = repo as any;
    preview = new PreviewCryptoCsvImportService(conns, r, csv);
    (preview as any).now = () => clock;
    commit = new CommitCryptoCsvImportService(
      conns,
      r,
      csv,
      audit as any,
      events as any,
      fakeCls(),
    );
    (commit as any).now = () => clock;
    rollback = new RollbackCryptoCsvImportService(
      r,
      audit as any,
      events as any,
      fakeCls(),
    );
    list = new GetCryptoCsvImportsService(conns, r);
  });

  const upload = (buffer: Buffer, originalname = 'trading.csv') => ({
    buffer,
    originalname,
  });

  describe('preview', () => {
    it('returns counts, byType and the date range, and writes no raw records', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv'), 'my trades.csv'),
        9,
      );
      expect(p).toMatchObject({
        connectionId: pionexId,
        exchange: 'pionex',
        filename: 'my trades.csv',
        rowCount: 2,
        importable: 2,
        alreadyImported: 0,
        rejectedCount: 0,
        rejected: [],
        byType: { trade_summary: 2 },
        dateFrom: '2020-01-02T03:04:05.000Z',
        dateTo: '2020-01-03T05:06:07.000Z',
        apiOverlap: 0,
      });
      expect(p.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(repo.raw).toHaveLength(0);
      const stored = repo.imports.get(p.importId);
      expect(stored).toMatchObject({
        status: 'previewed',
        uploadedBy: 9,
        rowsRejected: 0,
      });
    });

    it('groups mixed record types', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('staking.csv')),
        1,
      );
      expect(Object.values(p.byType).reduce((a, b) => a + b, 0)).toBe(3);
      expect(p.importable).toBe(3);
    });

    it('caps the rejected list at 50 but reports the true count', async () => {
      const p = await preview.execute(
        pionexId,
        upload(rawTradingCsv(5, 60)),
        1,
      );
      expect(p.rejectedCount).toBe(60);
      expect(p.rejected).toHaveLength(50);
      expect(p.rejected[0]).toMatchObject({ line: 7 });
      expect(p.rowCount).toBe(65);
      expect(p.importable).toBe(5);
      expect(repo.imports.get(p.importId).rowsRejected).toBe(60);
    });

    it('counts API trades in the file range as apiOverlap', async () => {
      const inRange = new Date('2020-01-02T10:00:00Z');
      repo.seedRaw({
        connectionId: pionexId,
        recordType: 'trade',
        exchangeRecordId: 'api-1',
        occurredAt: inRange,
        source: 'api',
      });
      repo.seedRaw({
        connectionId: pionexId,
        recordType: 'trade',
        exchangeRecordId: 'api-2',
        occurredAt: new Date('2021-01-01T00:00:00Z'),
        source: 'api',
      });
      repo.seedRaw({
        connectionId: pionexId,
        recordType: 'deposit',
        exchangeRecordId: 'api-3',
        occurredAt: inRange,
        source: 'api',
      });
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      expect(p.apiOverlap).toBe(1);
    });

    it('refuses a wrong-exchange connection with no import row created', async () => {
      await expect(
        preview.execute(krakenId, upload(fixture('trading.csv')), 1),
      ).rejects.toMatchObject({ code: 'CSV_FORMAT_UNRECOGNIZED' });
      expect(repo.imports.size).toBe(0);
    });

    it('refuses an unrecognized file and an archived connection', async () => {
      await expect(
        preview.execute(pionexId, upload(Buffer.from('a,b\n1,2\n')), 1),
      ).rejects.toBeInstanceOf(CsvImportError);
      expect(repo.imports.size).toBe(0);
      connections.rows.get(pionexId).deletedAt = new Date();
      await expect(
        preview.execute(pionexId, upload(fixture('trading.csv')), 1),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_NOT_FOUND' });
    });

    it('refuses a derived export without creating a row', async () => {
      await expect(
        preview.execute(pionexId, upload(fixture('for-cointracker.csv')), 1),
      ).rejects.toMatchObject({ code: 'CSV_DERIVED_EXPORT_REFUSED' });
      expect(repo.imports.size).toBe(0);
    });

    it('deletes this connection previews older than 24h on a new preview', async () => {
      const first = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      const other = await repo.insertImport({
        connectionId: krakenId,
        status: 'previewed',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      });
      clock = new Date('2026-10-09T13:00:00Z'); // > 24h later
      const second = await preview.execute(
        pionexId,
        upload(fixture('staking.csv')),
        1,
      );
      expect(repo.imports.has(first.importId)).toBe(false);
      expect(repo.imports.has(second.importId)).toBe(true);
      expect(repo.imports.has(other.id)).toBe(true); // other connection untouched
    });

    it('keeps a recent preview', async () => {
      const first = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      clock = new Date('2026-10-08T20:00:00Z');
      await preview.execute(pionexId, upload(fixture('staking.csv')), 1);
      expect(repo.imports.has(first.importId)).toBe(true);
    });

    it('sanitizes the stored filename', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv'), '..\\..\\etc/pass\u0000wd‮.csv'),
        1,
      );
      expect(p.filename).toBe('passwd.csv');
      expect(sanitizeFilename('')).toBe('upload.csv');
      expect(sanitizeFilename('a'.repeat(400))).toHaveLength(255);
    });
  });

  describe('commit', () => {
    const previewAndCommit = async (
      buffer: Buffer,
      connectionId = pionexId,
    ) => {
      const p = await preview.execute(connectionId, upload(buffer), 1);
      return { p, view: await commit.execute(p.importId, { buffer }) };
    };

    it('writes csv-stamped rows with the sync-engine payload hash', async () => {
      const { p, view } = await previewAndCommit(fixture('trading.csv'));
      expect(view).toMatchObject({
        id: p.importId,
        status: 'committed',
        rowCount: 2,
        rowsImported: 2,
        rowsSkippedDuplicate: 0,
        rowsRejected: 0,
        dateFrom: '2020-01-02T03:04:05.000Z',
      });
      expect(view.committedAt).toBe(clock.toISOString());
      expect(repo.raw).toHaveLength(2);
      for (const row of repo.raw) {
        expect(row).toMatchObject({
          source: 'csv',
          importId: p.importId,
          connectionId: pionexId,
        });
        expect(row.exchangeRecordId).toMatch(/^csv:[0-9a-f]{64}/);
        expect(row.payloadHash).toBe(
          computePayloadHash(JSON.parse(row.payload)),
        );
      }
      expect(events.emitted).toEqual([
        {
          name: cryptoEvents.csvImport.committed,
          payload: expect.objectContaining({
            connectionId: pionexId,
            organizationId: 7,
          }),
        },
      ]);
    });

    it('refuses the same file again after a commit (CSV_DUPLICATE_FILE)', async () => {
      await previewAndCommit(fixture('trading.csv'));
      await expect(
        preview.execute(pionexId, upload(fixture('trading.csv')), 1),
      ).rejects.toMatchObject({ code: 'CSV_DUPLICATE_FILE' });
    });

    it('previews the same file again after a rollback', async () => {
      const { p } = await previewAndCommit(fixture('trading.csv'));
      await rollback.execute(p.importId);
      const again = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      expect(again.importable).toBe(2);
      const view = await commit.execute(again.importId, {
        buffer: fixture('trading.csv'),
      });
      expect(view.rowsImported).toBe(2);
    });

    it('detects two previews of one file: the second commit is a duplicate', async () => {
      const buffer = fixture('trading.csv');
      const a = await preview.execute(pionexId, upload(buffer), 1);
      const b = await preview.execute(pionexId, upload(buffer), 1);
      await commit.execute(a.importId, { buffer });
      await expect(
        commit.execute(b.importId, { buffer }),
      ).rejects.toMatchObject({ code: 'CSV_DUPLICATE_FILE' });
      expect(repo.raw).toHaveLength(2);
    });

    it('refuses changed bytes (CSV_FILE_CHANGED) and writes nothing', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      await expect(
        commit.execute(p.importId, { buffer: fixture('staking.csv') }),
      ).rejects.toMatchObject({ code: 'CSV_FILE_CHANGED' });
      expect(repo.raw).toHaveLength(0);
      expect(repo.imports.get(p.importId).status).toBe('previewed');
    });

    it('refuses an already committed, rolled back or unknown import', async () => {
      const { p } = await previewAndCommit(fixture('trading.csv'));
      await expect(
        commit.execute(p.importId, { buffer: fixture('trading.csv') }),
      ).rejects.toMatchObject({ code: 'CSV_NOT_COMMITTABLE' });
      await rollback.execute(p.importId);
      await expect(
        commit.execute(p.importId, { buffer: fixture('trading.csv') }),
      ).rejects.toMatchObject({ code: 'CSV_NOT_COMMITTABLE' });
      await expect(
        commit.execute(999, { buffer: fixture('trading.csv') }),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_CSV_IMPORT_NOT_FOUND' });
    });

    it('refuses when the connection was deleted after the preview', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      connections.rows.get(pionexId).deletedAt = new Date();
      await expect(
        commit.execute(p.importId, { buffer: fixture('trading.csv') }),
      ).rejects.toMatchObject({ errorType: 'CRYPTO_CONNECTION_NOT_FOUND' });
      expect(repo.raw).toHaveLength(0);
    });

    it('imports overlapping files once and reports the skipped duplicates', async () => {
      const a = fixture('trading.csv');
      const extra =
        '"2020-01-04 00:00:00","1","2","3","BUY","TEST_USDT","0.1","TEST","Spot","s_t9"\n';
      const b = Buffer.concat([a, Buffer.from(extra)]);
      const first = await previewAndCommit(a);
      expect(first.view.rowsImported).toBe(2);

      const second = await preview.execute(pionexId, upload(b), 1);
      expect(second).toMatchObject({ importable: 1, alreadyImported: 2 });
      const view = await commit.execute(second.importId, { buffer: b });
      expect(view).toMatchObject({
        rowsImported: 1,
        rowsSkippedDuplicate: 2,
      });
      expect(repo.raw).toHaveLength(3);
      expect(new Set(repo.raw.map((r) => r.exchangeRecordId)).size).toBe(3);
    });

    it('skips rows that already exist from the API without failing', async () => {
      // same key as an API row: pre-seed using the id the importer will compute
      const buffer = fixture('trading.csv');
      const first = await previewAndCommit(buffer);
      const [victim] = repo.raw;
      await rollback.execute(first.p.importId);
      repo.seedRaw({
        connectionId: pionexId,
        recordType: victim.recordType,
        exchangeRecordId: victim.exchangeRecordId,
        occurredAt: victim.occurredAt,
        source: 'api',
      });
      const second = await preview.execute(pionexId, upload(buffer), 1);
      expect(second.alreadyImported).toBe(1);
      const view = await commit.execute(second.importId, { buffer });
      expect(view).toMatchObject({ rowsImported: 1, rowsSkippedDuplicate: 1 });
      expect(repo.raw.filter((r) => r.source === 'api')).toHaveLength(1);
    });

    it('imports rows of identical content with distinct ids (n-th suffix)', async () => {
      const { view } = await previewAndCommit(fixture('staking.csv'));
      expect(view.rowsImported).toBe(3);
      expect(new Set(repo.raw.map((r) => r.exchangeRecordId)).size).toBe(3);
    });

    it('writes 1,200 rows in batches of 500', async () => {
      const buffer = rawTradingCsv(1200);
      const { view } = await previewAndCommit(buffer);
      expect(view.rowsImported).toBe(1200);
      expect(repo.insertBatches).toEqual([500, 500, 200]);
      expect(repo.transactions).toBe(1);
    });

    it('is all-or-nothing: a failure on batch 2 leaves zero rows and a failed import', async () => {
      const buffer = rawTradingCsv(1200);
      const p = await preview.execute(pionexId, upload(buffer), 1);
      repo.failOnInsertCall = 2;
      await expect(commit.execute(p.importId, { buffer })).rejects.toThrow(
        'forced insert failure',
      );
      expect(repo.raw).toHaveLength(0);
      expect(repo.imports.get(p.importId)).toMatchObject({
        status: 'failed',
        error: 'Import failed and was rolled back.',
      });
      expect(events.emitted).toHaveLength(0);
    });

    it('aborts when INSERT IGNORE silently dropped a row', async () => {
      const buffer = fixture('trading.csv');
      const p = await preview.execute(pionexId, upload(buffer), 1);
      const original = repo.insertIgnoringDuplicates;
      repo.insertIgnoringDuplicates = async (rows: any[]) => {
        // pretend the database ignored the last row for some other reason
        await original(rows.slice(0, -1));
        return rows.length - 1;
      };
      await expect(commit.execute(p.importId, { buffer })).rejects.toThrow(
        /verification failed/,
      );
      expect(repo.raw).toHaveLength(0);
    });
  });

  describe('rollback', () => {
    it('removes only that import and leaves another import and API rows', async () => {
      const a = fixture('trading.csv');
      const b = fixture('others.csv');
      repo.seedRaw({
        connectionId: pionexId,
        recordType: 'trade',
        exchangeRecordId: 'api-keep',
        occurredAt: new Date('2020-01-02T10:00:00Z'),
        source: 'api',
      });
      const pa = await preview.execute(pionexId, upload(a), 1);
      await commit.execute(pa.importId, { buffer: a });
      const pb = await preview.execute(pionexId, upload(b), 1);
      await commit.execute(pb.importId, { buffer: b });
      const total = repo.raw.length;
      expect(total).toBe(1 + 2 + 3);

      const view = await rollback.execute(pa.importId);
      expect(view.status).toBe('rolled_back');
      expect(repo.raw.filter((r) => r.importId === pa.importId)).toHaveLength(
        0,
      );
      expect(repo.raw.filter((r) => r.importId === pb.importId)).toHaveLength(
        3,
      );
      expect(repo.raw.filter((r) => r.source === 'api')).toHaveLength(1);
      expect(events.emitted.map((e) => e.name)).toContain(
        cryptoEvents.csvImport.rolledBack,
      );
    });

    it('does not delete an earlier import row that this import skipped as a duplicate', async () => {
      const a = fixture('trading.csv');
      const extra =
        '"2020-01-04 00:00:00","1","2","3","BUY","TEST_USDT","0.1","TEST","Spot","s_t9"\n';
      const b = Buffer.concat([a, Buffer.from(extra)]);
      const pa = await preview.execute(pionexId, upload(a), 1);
      await commit.execute(pa.importId, { buffer: a });
      const pb = await preview.execute(pionexId, upload(b), 1);
      await commit.execute(pb.importId, { buffer: b });
      expect(repo.raw).toHaveLength(3);

      await rollback.execute(pb.importId);

      // A's two rows survive; only B's one new row is gone
      expect(repo.raw).toHaveLength(2);
      expect(repo.raw.every((r) => r.importId === pa.importId)).toBe(true);
    });

    it('refuses anything that is not committed', async () => {
      const p = await preview.execute(
        pionexId,
        upload(fixture('trading.csv')),
        1,
      );
      await expect(rollback.execute(p.importId)).rejects.toMatchObject({
        code: 'CSV_NOT_ROLLBACKABLE',
      });
      await commit.execute(p.importId, { buffer: fixture('trading.csv') });
      await rollback.execute(p.importId);
      await expect(rollback.execute(p.importId)).rejects.toMatchObject({
        code: 'CSV_NOT_ROLLBACKABLE',
      });
      await expect(rollback.execute(404)).rejects.toMatchObject({
        errorType: 'CRYPTO_CSV_IMPORT_NOT_FOUND',
      });
    });
  });

  describe('list', () => {
    it('lists a connection history newest first through the allow-list view', async () => {
      const a = fixture('trading.csv');
      const pa = await preview.execute(pionexId, upload(a, 'a.csv'), 1);
      await commit.execute(pa.importId, { buffer: a });
      const pb = await preview.execute(
        pionexId,
        upload(fixture('staking.csv'), 'b.csv'),
        1,
      );
      const views = await list.execute(pionexId);
      expect(views.map((v) => v.id)).toEqual([pb.importId, pa.importId]);
      expect(views[1]).toMatchObject({
        filename: 'a.csv',
        status: 'committed',
        rowsImported: 2,
      });
      expect(Object.keys(views[0]).sort()).toEqual(
        [
          'committedAt',
          'connectionId',
          'createdAt',
          'dateFrom',
          'dateTo',
          'filename',
          'id',
          'reportType',
          'rowCount',
          'rowsImported',
          'rowsRejected',
          'rowsSkippedDuplicate',
          'status',
        ].sort(),
      );
    });

    it('404s for an unknown or archived connection', async () => {
      await expect(list.execute(999)).rejects.toMatchObject({
        errorType: 'CRYPTO_CONNECTION_NOT_FOUND',
      });
    });
  });

  describe('audit trail', () => {
    it('records commit and rollback with ids and counts but no row data or filename', async () => {
      const buffer = fixture('trading.csv');
      const p = await preview.execute(
        pionexId,
        upload(buffer, 'secret-name.csv'),
        1,
      );
      await commit.execute(p.importId, { buffer });
      await rollback.execute(p.importId);

      expect(audit.rows).toHaveLength(2);
      expect(audit.rows[0]).toMatchObject({
        action: 'csv_imported',
        subjectId: pionexId,
        metadata: {
          importId: p.importId,
          reportType: p.reportType,
          rowCount: 2,
          rowsImported: 2,
          rowsSkippedDuplicate: 0,
          rowsRejected: 0,
        },
      });
      expect(audit.rows[0].trx).toBeDefined();
      expect(audit.rows[1]).toMatchObject({
        action: 'csv_rolled_back',
        subjectId: pionexId,
        metadata: { importId: p.importId, rowsRemoved: 2 },
      });
      const text = JSON.stringify(audit.rows.map((r) => r.metadata));
      expect(text).not.toContain('secret-name');
      expect(text).not.toContain('TEST_USDT');
    });

    it('a failing audit write rolls the commit back', async () => {
      const buffer = fixture('trading.csv');
      const p = await preview.execute(pionexId, upload(buffer), 1);
      audit.failWith = new Error('audit down');
      await expect(commit.execute(p.importId, { buffer })).rejects.toThrow(
        'audit down',
      );
      expect(repo.raw).toHaveLength(0);
      expect(events.emitted).toHaveLength(0);
      expect(repo.imports.get(p.importId).status).not.toBe('committed');
    });

    it('a failing audit write rolls the rollback back', async () => {
      const buffer = fixture('trading.csv');
      const p = await preview.execute(pionexId, upload(buffer), 1);
      await commit.execute(p.importId, { buffer });
      audit.failWith = new Error('audit down');
      await expect(rollback.execute(p.importId)).rejects.toThrow('audit down');
      expect(repo.raw).toHaveLength(2);
      expect(repo.imports.get(p.importId).status).toBe('committed');
    });
  });

  describe('rollback dependency guard', () => {
    const extraRow = (n: number) =>
      Buffer.from(
        `"2020-01-0${n} 00:00:00","1","2","3","BUY","TEST_USDT","0.1","TEST","Spot","s_x${n}"\n`,
      );
    const commitFile = async (buffer: Buffer) => {
      clock = new Date(clock.getTime() + 1000);
      const p = await preview.execute(pionexId, upload(buffer), 1);
      await commit.execute(p.importId, { buffer });
      return p.importId;
    };

    it('refuses to roll back A while a later overlapping import skipped rows of A', async () => {
      const a = fixture('trading.csv');
      const b = Buffer.concat([a, extraRow(4)]);
      const idA = await commitFile(a);
      const idB = await commitFile(b);

      const error = await rollback.execute(idA).catch((e) => e);
      expect(error).toBeInstanceOf(CsvImportError);
      expect(error.code).toBe('CSV_NOT_ROLLBACKABLE');
      expect(error.details.dependentImportIds).toEqual([idB]);
      expect(error.message).toMatch(/later import/i);
      expect(repo.raw).toHaveLength(3);

      await rollback.execute(idB);
      await rollback.execute(idA);
      expect(repo.raw).toHaveLength(0);
    });

    it('an unrelated later import (no skipped rows) does not block', async () => {
      const idA = await commitFile(fixture('trading.csv'));
      await commitFile(fixture('others.csv')); // different report type, no overlap in ids
      const view = await rollback.execute(idA);
      expect(view.status).toBe('rolled_back');
    });

    it('a later import with skipped rows but a disjoint date range does not block', async () => {
      const a = fixture('trading.csv'); // 2020-01-02 .. 2020-01-03
      const idA = await commitFile(a);
      // later file skips nothing of A's and has other dates: simulate skipped rows
      const idB = await commitFile(fixture('others.csv'));
      repo.imports.get(idB).rowsSkippedDuplicate = 5;
      repo.imports.get(idB).dateFrom = new Date('2021-01-01T00:00:00Z');
      repo.imports.get(idB).dateTo = new Date('2021-01-02T00:00:00Z');
      await expect(rollback.execute(idA)).resolves.toMatchObject({
        status: 'rolled_back',
      });
    });

    it('an EARLIER import never blocks a later one', async () => {
      const a = fixture('trading.csv');
      const b = Buffer.concat([a, extraRow(4)]);
      await commitFile(a);
      const idB = await commitFile(b);
      await expect(rollback.execute(idB)).resolves.toMatchObject({
        status: 'rolled_back',
      });
    });
  });

  describe('byte-bounded batches', () => {
    it('splits a statement once its payload bytes pass the cap', async () => {
      const comment = 'x'.repeat(1900);
      const rows = [];
      for (let i = 0; i < 10; i++) {
        rows.push(
          `"2020-01-01 00:00:${String(i).padStart(2, '0')}","USDT","1","FundingFee","${comment}"`,
        );
      }
      const buffer = Buffer.from(
        '"date(UTC+0)","coin","amount","tag","comment"\n' +
          rows.join('\n') +
          '\n',
      );
      (commit as any).insertMaxBytes = 5000;
      const p = await preview.execute(pionexId, upload(buffer), 1);
      const view = await commit.execute(p.importId, { buffer });
      expect(view.rowsImported).toBe(10);
      expect(repo.insertBatches).toEqual([2, 2, 2, 2, 2]);
    });
  });
});
