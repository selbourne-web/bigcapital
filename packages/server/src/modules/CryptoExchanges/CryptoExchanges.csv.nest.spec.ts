import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import {
  DEFAULT_STRATEGY,
  SerializeInterceptor,
} from '@/common/interceptors/serialize.interceptor';
import { ClsService } from 'nestjs-cls';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import { CsvImportError } from './csv/csv.types';
import { GetCryptoBalancesService } from './queries/GetCryptoBalances.service';
import { GetCryptoConnectionsService } from './queries/GetCryptoConnections.service';
import { GetCryptoSyncRunsService } from './queries/GetCryptoSyncRuns.service';
import { CreateCryptoConnectionService } from './commands/CreateCryptoConnection.service';
import { UpdateCryptoConnectionService } from './commands/UpdateCryptoConnection.service';
import { RotateCryptoCredentialsService } from './commands/RotateCryptoCredentials.service';
import { DeleteCryptoConnectionService } from './commands/DeleteCryptoConnection.service';
import { CryptoSyncRequestService } from './sync/CryptoSyncRequest.service';
import { PreviewCryptoCsvImportService } from './commands/PreviewCryptoCsvImport.service';
import { CommitCryptoCsvImportService } from './commands/CommitCryptoCsvImport.service';
import { RollbackCryptoCsvImportService } from './commands/RollbackCryptoCsvImport.service';
import { GetCryptoCsvImportsService } from './queries/GetCryptoCsvImports.service';

/**
 * The controller booted in a real Nest HTTP app: route params (ParseIntPipe),
 * @UploadedFile, @UseFilters, @HttpCode and the global SerializeInterceptor,
 * with the two guards overridden (they are unit-tested elsewhere).
 */
describe('CSV endpoints in a booted Nest app', () => {
  let app: INestApplication;
  let base: string;
  const preview = { execute: jest.fn() };
  const commit = { execute: jest.fn() };
  const rollback = { execute: jest.fn() };
  const list = { execute: jest.fn() };

  beforeAll(async () => {
    const stub = {};
    const moduleRef = await Test.createTestingModule({
      controllers: [CryptoExchangesController],
      providers: [
        ...[
          GetCryptoConnectionsService,
          GetCryptoBalancesService,
          GetCryptoSyncRunsService,
          CreateCryptoConnectionService,
          UpdateCryptoConnectionService,
          RotateCryptoCredentialsService,
          DeleteCryptoConnectionService,
          CryptoSyncRequestService,
        ].map((provide) => ({ provide, useValue: stub })),
        { provide: PreviewCryptoCsvImportService, useValue: preview },
        { provide: CommitCryptoCsvImportService, useValue: commit },
        { provide: RollbackCryptoCsvImportService, useValue: rollback },
        { provide: GetCryptoCsvImportsService, useValue: list },
        { provide: ClsService, useValue: { get: () => 7 } },
      ],
    })
      .overrideGuard(AuthorizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalInterceptors(new SerializeInterceptor(DEFAULT_STRATEGY));
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  const upload = (path: string, method = 'POST', name = 'a.csv') => {
    const form = new FormData();
    form.append('file', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), name);
    return fetch(base + path, { method, body: form });
  };

  it('preview: 201, ParseIntPipe 400 on a bad id, serializer output is snake_case', async () => {
    preview.execute.mockResolvedValueOnce({
      importId: 5,
      byType: { trade_summary: 1 },
    });
    const ok = await upload('/crypto/connections/3/imports');
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({
      import_id: 5,
      by_type: { trade_summary: 1 },
    });
    expect(preview.execute).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ originalname: 'a.csv' }),
      7,
    );
    expect((await upload('/crypto/connections/abc/imports')).status).toBe(400);
  });

  it('commit answers 200; CSV errors go through the crypto filter', async () => {
    commit.execute.mockResolvedValueOnce({ id: 5, rowsImported: 1 });
    const ok = await upload('/crypto/imports/5/commit');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 5, rows_imported: 1 });

    commit.execute.mockRejectedValueOnce(
      new CsvImportError('CSV_BUSY', 'busy'),
    );
    const busy = await upload('/crypto/imports/5/commit');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(await busy.json()).toEqual({ code: 'CSV_BUSY', message: 'busy' });
  });

  it('a request without a file is 422 CSV_FORMAT_UNRECOGNIZED', async () => {
    const res = await fetch(base + '/crypto/connections/3/imports', {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CSV_FORMAT_UNRECOGNIZED');
  });

  it('rollback and list delegate over HTTP', async () => {
    rollback.execute.mockRejectedValueOnce(
      new CsvImportError('CSV_NOT_ROLLBACKABLE', 'later first', {
        dependentImportIds: [9],
      }),
    );
    const res = await fetch(base + '/crypto/imports/5', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).dependentImportIds).toEqual([9]);
    list.execute.mockResolvedValueOnce([{ id: 1, connectionId: 3 }]);
    const l = await fetch(base + '/crypto/connections/3/imports');
    expect(await l.json()).toEqual([{ id: 1, connection_id: 3 }]);
  });
});
