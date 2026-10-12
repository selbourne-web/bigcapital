import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { ValidationPipe } from '@/common/pipes/ClassValidation.pipe';
import {
  DEFAULT_STRATEGY,
  SerializeInterceptor,
} from '@/common/interceptors/serialize.interceptor';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { CsvImportService } from './csv/CsvImport.service';
import { CsvParserRegistry } from './csv/CsvParserRegistry';
import { NEXO_CSV_PARSERS } from './csv/parsers/nexo/nexo.parsers';
import { PIONEX_CSV_PARSERS } from './csv/parsers/pionex/pionex.parsers';
import { GetCryptoBalancesService } from './queries/GetCryptoBalances.service';
import { GetCryptoConnectionsService } from './queries/GetCryptoConnections.service';
import { GetCryptoSyncRunsService } from './queries/GetCryptoSyncRuns.service';
import { GetCryptoCsvImportsService } from './queries/GetCryptoCsvImports.service';
import { CreateCryptoConnectionService } from './commands/CreateCryptoConnection.service';
import { CreateCsvOnlyConnectionService } from './commands/CreateCsvOnlyConnection.service';
import { UpdateCryptoConnectionService } from './commands/UpdateCryptoConnection.service';
import { RotateCryptoCredentialsService } from './commands/RotateCryptoCredentials.service';
import { DeleteCryptoConnectionService } from './commands/DeleteCryptoConnection.service';
import { PreviewCryptoCsvImportService } from './commands/PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './commands/CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './commands/RollbackCryptoCsvImport.service';
import { CryptoSyncRequestService } from './sync/CryptoSyncRequest.service';
import {
  FAKE_KEY,
  FAKE_SECRET,
  FakeAccounts,
  FakeAdapter,
  FakeAudit,
  FakeCreateAccount,
  FakeCsvImportRepo,
  FakeEvents,
  FakeRepo,
  FakeUow,
  makeValidators,
  makeVault,
} from './commands/testFakes';

/**
 * CSV-only connections over HTTP: a booted Nest app with the real controller,
 * the app's ValidationPipe and SerializeInterceptor, the crypto exception
 * filter and the REAL services (create, update, rotate, delete, list, manual
 * sync, CSV preview/commit) over in-memory fakes. Guards are overridden (the
 * permission table lives in the controller spec). The scheduler is a recording
 * fake: nothing may ever be scheduled or enqueued for a csv_only connection.
 */
describe('CSV-only connections over HTTP (booted Nest app)', () => {
  let app: INestApplication;
  let base: string;
  const repo = new FakeRepo();
  const adapter = new FakeAdapter();
  const accounts = new FakeAccounts();
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const uow = new FakeUow();
  const imports = new FakeCsvImportRepo();
  const scheduler = {
    schedule: jest.fn(async () => undefined),
    enqueue: jest.fn(async () => undefined),
    unschedule: jest.fn(async () => undefined),
  };
  const cls = {
    get: (key: string) =>
      key === 'organizationId' ? 'org-1' : key === 'userId' ? 1 : undefined,
  } as any;
  const { validators, limiter } = makeValidators(adapter, accounts, repo);

  /** The list query over the fake rows (archived hidden), like the real one. */
  const connectionModel = () => ({
    query: () => ({
      whereNull: () => ({
        orderBy: async () =>
          [...repo.rows.values()]
            .filter((r) => !r.deletedAt)
            .map((r) => ({ ...r })),
      }),
    }),
  });

  beforeAll(async () => {
    const createAccount = new FakeCreateAccount(accounts);
    const csv = new CsvImportService(
      new CsvParserRegistry([...PIONEX_CSV_PARSERS, ...NEXO_CSV_PARSERS]),
    );
    const r = repo as any;
    const services = [
      [
        GetCryptoConnectionsService,
        new GetCryptoConnectionsService(
          connectionModel as any,
          new AdapterRegistry(),
        ),
      ],
      [GetCryptoBalancesService, {}],
      [GetCryptoSyncRunsService, {}],
      [
        CreateCryptoConnectionService,
        new CreateCryptoConnectionService(
          r,
          makeVault(),
          validators,
          uow as any,
          createAccount as any,
          audit as any,
          events as any,
          cls,
        ),
      ],
      [
        CreateCsvOnlyConnectionService,
        new CreateCsvOnlyConnectionService(
          r,
          validators,
          uow as any,
          createAccount as any,
          audit as any,
        ),
      ],
      [
        UpdateCryptoConnectionService,
        new UpdateCryptoConnectionService(
          r,
          validators,
          uow as any,
          audit as any,
          events as any,
          cls,
        ),
      ],
      [
        RotateCryptoCredentialsService,
        new RotateCryptoCredentialsService(
          r,
          makeVault(),
          validators,
          uow as any,
          audit as any,
          events as any,
          cls,
        ),
      ],
      [
        DeleteCryptoConnectionService,
        new DeleteCryptoConnectionService(
          r,
          uow as any,
          audit as any,
          events as any,
          cls,
        ),
      ],
      [
        CryptoSyncRequestService,
        new CryptoSyncRequestService(
          r,
          scheduler as any,
          {
            getOrThrow: () => {
              throw new Error('Redis must not be touched for csv_only');
            },
          } as any,
          cls,
        ),
      ],
      [
        PreviewCryptoCsvImportService,
        new PreviewCryptoCsvImportService(r, imports as any, csv),
      ],
      [
        CommitCryptoCsvImportService,
        new CommitCryptoCsvImportService(
          r,
          imports as any,
          csv,
          audit as any,
          events as any,
          cls,
        ),
      ],
      [RollbackCryptoCsvImportService, {}],
      [
        GetCryptoCsvImportsService,
        new GetCryptoCsvImportsService(r, imports as any),
      ],
    ] as const;

    const moduleRef = await Test.createTestingModule({
      controllers: [CryptoExchangesController],
      providers: [
        ...services.map(([provide, useValue]) => ({ provide, useValue })),
        { provide: ClsService, useValue: cls },
      ],
    })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    app.useGlobalInterceptors(new SerializeInterceptor(DEFAULT_STRATEGY));
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + '/crypto' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  const createNexo = async (label = 'Nexo') => {
    const res = await call('POST', '/connections/csv-only', {
      exchange: 'nexo',
      label,
    });
    expect(res.status).toBe(201);
    return res.json.id as number;
  };

  const resetRecorders = () => {
    scheduler.schedule.mockClear();
    scheduler.enqueue.mockClear();
    limiter.acquire.mockClear();
    adapter.inspected = [];
    events.emitted = [];
  };

  it('POST /connections/csv-only: 201, snake_case view with mode csv_only, empty credential columns, nothing probed, emitted or scheduled', async () => {
    resetRecorders();
    const res = await call('POST', '/connections/csv-only', {
      exchange: 'nexo',
      label: '  Nexo savings ',
    });

    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      id: expect.any(Number),
      exchange: 'nexo',
      label: 'Nexo savings',
      status: 'active',
      mode: 'csv_only',
      key_hint: null,
      account_id: null,
      last_sync_at: null,
      last_error: null,
      created_at: expect.any(String),
      key_expires_at: null,
    });
    expect(repo.rows.get(res.json.id)).toMatchObject({
      mode: 'csv_only',
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      passphraseEncrypted: null,
    });
    expect(adapter.inspected).toHaveLength(0);
    expect(limiter.acquire).not.toHaveBeenCalled();
    expect(events.emitted).toHaveLength(0);
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['an API exchange (pionex)', { exchange: 'pionex', label: 'P' }],
    ['an empty label', { exchange: 'nexo', label: '  ' }],
    ['a label over 255', { exchange: 'nexo', label: 'x'.repeat(256) }],
  ])('POST /connections/csv-only rejects %s with 400', async (_n, body) => {
    const before = repo.rows.size;
    const res = await call('POST', '/connections/csv-only', body);
    expect(res.status).toBe(400);
    expect(repo.rows.size).toBe(before);
  });

  it('POST /connections (key route) still rejects exchange nexo with 400 before any probe', async () => {
    resetRecorders();
    const res = await call('POST', '/connections', {
      exchange: 'nexo',
      label: 'N',
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
    });
    expect(res.status).toBe(400);
    expect(adapter.inspected).toHaveLength(0);
    // (Pre-existing, app-wide: the class-validator 400 body echoes the request
    // body as `target`, so the caller's own key is reflected back. Not
    // asserted here; flagged in the task report.)
  });

  it('GET /connections: 200 with the nexo row (history_coverage null) and only API rows self-healed', async () => {
    const nexoId = await createNexo('Nexo list');
    const kraken = repo.seed({ exchange: 'kraken', mode: 'api' });
    resetRecorders();

    const res = await call('GET', '/connections');

    expect(res.status).toBe(200);
    const nexo = res.json.find((c: any) => c.id === nexoId);
    expect(nexo).toMatchObject({
      exchange: 'nexo',
      mode: 'csv_only',
      history_coverage: null,
    });
    expect(
      res.json.find((c: any) => c.id === kraken.id).history_coverage,
    ).toEqual(expect.objectContaining({ level: expect.any(String) }));
    expect(
      scheduler.schedule.mock.calls.map((c: any[]) => c[0].id),
    ).not.toContain(nexoId);
    expect(scheduler.schedule.mock.calls.map((c: any[]) => c[0].id)).toContain(
      kraken.id,
    );
    for (const c of res.json) {
      expect(Object.keys(c)).not.toEqual(
        expect.arrayContaining(['api_key_encrypted']),
      );
    }
  });

  it.each([
    ['Sync now', 'POST', 'sync', undefined],
    ['Pause', 'PATCH', '', { status: 'paused' }],
    ['Resume', 'PATCH', '', { status: 'active' }],
    [
      'Rotate key / Reconnect',
      'POST',
      'credentials',
      { apiKey: FAKE_KEY, apiSecret: FAKE_SECRET },
    ],
  ])(
    '%s on a csv_only connection answers 409 CRYPTO_CONNECTION_CSV_ONLY and changes nothing',
    async (_action, method, suffix, body) => {
      const id = await createNexo();
      const before = { ...repo.rows.get(id) };
      resetRecorders();

      const res = await call(
        method,
        `/connections/${id}${suffix ? `/${suffix}` : ''}`,
        body,
      );

      expect(res.status).toBe(409);
      expect(res.json).toEqual({
        errors: [
          {
            statusCode: 409,
            type: 'CRYPTO_CONNECTION_CSV_ONLY',
            message: expect.any(String),
          },
        ],
      });
      expect(repo.rows.get(id)).toEqual(before);
      expect(adapter.inspected).toHaveLength(0);
      expect(events.emitted).toHaveLength(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(scheduler.enqueue).not.toHaveBeenCalled();
      expect(JSON.stringify(res.json)).not.toContain(FAKE_SECRET);
    },
  );

  it('renaming a csv_only connection still works (200)', async () => {
    const id = await createNexo();
    const res = await call('PATCH', `/connections/${id}`, { label: 'Nexo 2' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ label: 'Nexo 2', mode: 'csv_only' });
  });

  it('previews and commits a Nexo transactions file on the csv_only connection', async () => {
    const id = await createNexo('Nexo import');
    const bytes = readFileSync(
      join(__dirname, 'csv/parsers/nexo/__fixtures__/transactions.csv'),
    );
    const form = () => {
      const f = new FormData();
      f.append('file', new Blob([bytes], { type: 'text/csv' }), 'nexo.csv');
      return f;
    };

    const preview = await fetch(`${base}/crypto/connections/${id}/imports`, {
      method: 'POST',
      body: form(),
    });
    expect(preview.status).toBe(201);
    const p = await preview.json();
    expect(p).toMatchObject({ connection_id: id, exchange: 'nexo' });
    expect(p.importable).toBeGreaterThan(0);

    const commit = await fetch(`${base}/crypto/imports/${p.import_id}/commit`, {
      method: 'POST',
      body: form(),
    });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({
      id: p.import_id,
      status: 'committed',
    });
    expect(imports.raw.filter((r) => r.connectionId === id).length).toBe(
      p.importable,
    );
  });

  it('DELETE /connections/:id archives the csv_only connection (200) and it leaves the list', async () => {
    const id = await createNexo('Nexo delete');
    const res = await call('DELETE', `/connections/${id}`);
    expect(res.status).toBe(200);
    expect(repo.rows.get(id).deletedAt).toBeInstanceOf(Date);
    const list = await call('GET', '/connections');
    expect(list.json.map((c: any) => c.id)).not.toContain(id);
  });
});
