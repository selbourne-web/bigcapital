import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { of } from 'rxjs';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import { CryptoExchangeExceptionFilter } from './CryptoExchanges.filter';
import { CsvUploadInterceptor } from './csv/csvUpload.interceptor';
import { CsvImportService } from './csv/CsvImport.service';
import { CsvParserRegistry } from './csv/CsvParserRegistry';
import { PIONEX_CSV_PARSERS } from './csv/parsers/pionex/pionex.parsers';
import { PreviewCryptoCsvImportService } from './commands/PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './commands/CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './commands/RollbackCryptoCsvImport.service';
import { GetCryptoCsvImportsService } from './queries/GetCryptoCsvImports.service';
import {
  FakeAudit,
  FakeCsvImportRepo,
  FakeEvents,
  FakeRepo,
  fakeCls,
} from './commands/testFakes';
import { CSV_LIMITS } from './CryptoExchanges.constants';

/**
 * HTTP-level test of the CSV upload endpoints: a real http server, the REAL
 * multer-based CsvUploadInterceptor, the real controller handlers, the real
 * services over in-memory fakes, and the real exception filter. (Guards and
 * the global serializer are covered in the controller / wire specs.)
 */

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'csv/parsers/pionex/__fixtures__', name));

const RAW_HEADER =
  '"date(UTC+0)","executed_qty","amount","price","order_type","side","symbol","state","fee","fee_coin","market_type","tax_id"\n';

/** `good` FILLED trades then `bad` rows with a bad decimal. */
const rawTradingCsv = (good: number, bad = 0): Buffer => {
  const rows: string[] = [];
  for (let i = 0; i < good + bad; i++) {
    const t = new Date(Date.UTC(2020, 0, 1) + i * 1000);
    const date = t.toISOString().slice(0, 19).replace('T', ' ');
    const qty = i < good ? '1.5' : 'SECRETCELL';
    rows.push(
      `"${date}","${qty}","10","6.5","LIMIT","BUY","TEST_USDT","FILLED","0.1","TEST","Spot","s_${i}"`,
    );
  }
  return Buffer.from(RAW_HEADER + rows.join('\n') + '\n');
};

const BOUNDARY = '----csvwiretest';
type Part = {
  name: string;
  filename?: string;
  type?: string;
  data: Buffer | string;
};
const multipart = (parts: Part[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp =
      `form-data; name="${p.name}"` +
      (p.filename !== undefined ? `; filename="${p.filename}"` : '');
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: ${disp}\r\n` +
          (p.type ? `Content-Type: ${p.type}\r\n` : '') +
          '\r\n',
      ),
      Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
};

describe('CSV import endpoints over HTTP (real multer interceptor)', () => {
  let server: Server;
  let base: string;
  let repo: FakeCsvImportRepo;
  let pionexId: number;
  let previewSpy: jest.SpyInstance;
  const filter = new CryptoExchangeExceptionFilter();
  const Upload = CsvUploadInterceptor();

  beforeAll(async () => {
    const connections = new FakeRepo();
    pionexId = connections.seed({ exchange: 'pionex' }).id;
    repo = new FakeCsvImportRepo();
    const csv = new CsvImportService(new CsvParserRegistry(PIONEX_CSV_PARSERS));
    const conns = connections as any;
    const r = repo as any;
    const events = new FakeEvents() as any;
    const audit = new FakeAudit() as any;
    const preview = new PreviewCryptoCsvImportService(conns, r, csv);
    previewSpy = jest.spyOn(preview, 'execute');
    const controller = new CryptoExchangesController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      preview,
      new CommitCryptoCsvImportService(conns, r, csv, audit, events, fakeCls()),
      new RollbackCryptoCsvImportService(r, audit, events, fakeCls()),
      new GetCryptoCsvImportsService(conns, r),
      { get: (k: string) => (k === 'userId' ? 1 : undefined) } as any,
    );
    const interceptor = new Upload();

    server = createServer(async (req, rawRes) => {
      // minimal express-like response for the filter
      const res: any = rawRes;
      res.status = (code: number) => ((res.statusCode = code), res);
      res.json = (body: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
        return res;
      };
      const host = { switchToHttp: () => ({ getResponse: () => res }) } as any;
      try {
        const ctx = {
          switchToHttp: () => ({
            getRequest: () => req,
            getResponse: () => res,
          }),
        } as any;
        await interceptor.intercept(ctx, { handle: () => of(null) });
        const file = (req as any).file;
        const url = req.url ?? '';
        let out: unknown;
        let status = 200;
        if (req.method === 'POST' && /\/connections\/\d+\/imports$/.test(url)) {
          out = await controller.previewCryptoCsv(
            Number(url.match(/connections\/(\d+)/)![1]),
            file,
          );
          status = 201;
        } else {
          out = await controller.commitCryptoCsv(
            Number(url.match(/imports\/(\d+)/)![1]),
            file,
          );
        }
        res.status(status).json(out);
      } catch (error) {
        // like express: let the client finish sending before the reply, so an
        // early rejection (413) is not turned into a connection reset
        req.resume();
        filter.catch(error, host);
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = async (path: string, body: Buffer, contentType?: string) => {
    // A server that rejects an 11 MB body early may reset the socket while
    // the client is still writing (Node behaviour, load dependent): retry the
    // transport error, never an HTTP answer.
    let res: Response | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await fetch(base + path, {
          method: 'POST',
          headers: {
            'Content-Type':
              contentType ?? `multipart/form-data; boundary=${BOUNDARY}`,
          },
          body,
        });
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, headers: res.headers, json };
  };
  const previewPath = () => `/connections/${pionexId}/imports`;
  const csvPart = (data: Buffer, filename = 'trades.csv', type = 'text/csv') =>
    ({ name: 'file', filename, type, data }) as Part;

  it('previews a valid file: 201 with counts, snake-free camel view, no row payloads', async () => {
    const res = await post(
      previewPath(),
      multipart([csvPart(rawTradingCsv(3, 2))]),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      connectionId: pionexId,
      rowCount: 5,
      importable: 3,
      rejectedCount: 2,
    });
    expect(Object.keys(res.json).sort()).toEqual(
      [
        'alreadyImported',
        'apiOverlap',
        'byType',
        'connectionId',
        'dateFrom',
        'dateTo',
        'exchange',
        'fileSha256',
        'filename',
        'importId',
        'importable',
        'rejected',
        'rejectedCount',
        'reportType',
        'rowCount',
      ].sort(),
    );
    expect(res.json.rejected.length).toBeLessThanOrEqual(50);
    for (const r of res.json.rejected) {
      expect(Object.keys(r).sort()).toEqual(['line', 'reason']);
    }
    // parsed row content never comes back
    const wire = JSON.stringify(res.json);
    expect(wire).not.toContain('TEST_USDT');
    expect(wire).not.toContain('SECRETCELL');
    expect(wire).not.toContain('s_1');
  });

  it('the commit endpoint round-trips with the same bytes (200) and rejects different bytes (409)', async () => {
    const bytes = rawTradingCsv(2);
    const p = await post(previewPath(), multipart([csvPart(bytes)]));
    expect(p.status).toBe(201);

    const changed = await post(
      `/imports/${p.json.importId}/commit`,
      multipart([csvPart(rawTradingCsv(3))]),
    );
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('CSV_FILE_CHANGED');

    const ok = await post(
      `/imports/${p.json.importId}/commit`,
      multipart([csvPart(bytes)]),
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: p.json.importId, status: 'committed' });

    const again = await post(
      `/imports/${p.json.importId}/commit`,
      multipart([csvPart(bytes)]),
    );
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('CSV_NOT_COMMITTABLE');
  });

  it('answers 404 with the service-error body for an unknown import', async () => {
    const res = await post(
      '/imports/99999/commit',
      multipart([csvPart(rawTradingCsv(1))]),
    );
    expect(res.status).toBe(404);
    expect(res.json.errors[0].type).toBe('CRYPTO_CSV_IMPORT_NOT_FOUND');
  });

  it('an 11 MB upload is 413 CSV_TOO_LARGE and nothing reaches the service', async () => {
    previewSpy.mockClear();
    const big = Buffer.alloc(11 * 1024 * 1024, 'a');
    const res = await post(previewPath(), multipart([csvPart(big)]));
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('CSV_TOO_LARGE');
    expect(Object.keys(res.json).sort()).toEqual(['code', 'message']);
    expect(previewSpy).not.toHaveBeenCalled();
    expect(CSV_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
  });

  it.each([
    ['an .exe', 'malware.exe', 'application/octet-stream'],
    ['a .csv with image/png', 'trades.csv', 'image/png'],
    ['a .csv.exe', 'trades.csv.exe', 'text/csv'],
    ['no extension', 'trades', 'text/csv'],
  ])('rejects %s with 422 CSV_FORMAT_UNRECOGNIZED', async (_l, name, type) => {
    previewSpy.mockClear();
    const res = await post(
      previewPath(),
      multipart([csvPart(rawTradingCsv(1), name, type)]),
    );
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('CSV_FORMAT_UNRECOGNIZED');
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('rejects two files with 422 CSV_FORMAT_UNRECOGNIZED', async () => {
    previewSpy.mockClear();
    const res = await post(
      previewPath(),
      multipart([
        csvPart(rawTradingCsv(1)),
        csvPart(rawTradingCsv(2), 'b.csv'),
      ]),
    );
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('CSV_FORMAT_UNRECOGNIZED');
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('rejects a file under the wrong field name with 422', async () => {
    const res = await post(
      previewPath(),
      multipart([{ ...csvPart(rawTradingCsv(1)), name: 'upload' }]),
    );
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('CSV_FORMAT_UNRECOGNIZED');
  });

  it('rejects a request without a file (fields only, and non-multipart) with 422', async () => {
    const fieldsOnly = await post(
      previewPath(),
      multipart([{ name: 'note', data: 'hello' }]),
    );
    expect(fieldsOnly.status).toBe(422);
    expect(fieldsOnly.json.code).toBe('CSV_FORMAT_UNRECOGNIZED');

    const json = await post(
      previewPath(),
      Buffer.from('{}'),
      'application/json',
    );
    expect(json.status).toBe(422);
    expect(json.json.code).toBe('CSV_FORMAT_UNRECOGNIZED');
  });

  it('stores a sanitized filename (separators and control characters removed, max 255)', async () => {
    const nasty = `..\\..\\etc/pass‮wd${'x'.repeat(400)}.csv`;
    const res = await post(
      previewPath(),
      multipart([csvPart(fixture('trading.csv'), nasty)]),
    );
    // (raw control characters cannot be sent in a multipart header; the
    // service spec covers them, here: separators, bidi override, length)
    expect(res.status).toBe(201);
    expect(res.json.filename).not.toMatch(/[\\/\u0000-\u001f‮]/);
    expect(res.json.filename.length).toBeLessThanOrEqual(255);
    expect(res.json.filename.startsWith('pass')).toBe(true);
    const stored = [...repo.imports.values()].find(
      (i: any) => i.id === res.json.importId,
    ) as any;
    expect(stored.originalFilename).toBe(res.json.filename);
  });
});
