import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { lastValueFrom, of } from 'rxjs';
import {
  DEFAULT_STRATEGY,
  SerializeInterceptor,
} from '@/common/interceptors/serialize.interceptor';
import { ExcludeNullInterceptor } from '@/interceptors/ExcludeNull.interceptor';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import { toConnectionView } from './commands/CryptoConnectionView';
import { toCsvImportView } from './commands/CryptoCsvImportView';
import { buildBalancesView } from './queries/GetCryptoBalances.service';
import { toRunView } from './queries/GetCryptoSyncRuns.service';

/**
 * Wire format of the success responses: the REAL SerializeInterceptor (the one
 * AppModule registers globally) is run over the REAL view builders. Fact pinned
 * here: objects inside arrays ARE converted (the `skipChildren` branch of
 * camelToSnake never fires for them), so every success body is uniformly
 * snake_case. Error bodies written by the controller's exception filter bypass
 * the interceptor and stay camelCase.
 */
const wire = async (value: unknown) => {
  const request = { body: undefined, query: {} };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
  const out = await lastValueFrom(
    new SerializeInterceptor(DEFAULT_STRATEGY).intercept(context, {
      handle: () => of(value),
    }),
  );
  // what Express would put on the wire
  return JSON.parse(JSON.stringify(out));
};

const connections = [
  {
    id: 1,
    exchange: 'kraken',
    label: 'Kraken - Trading',
    status: 'active',
    keyHint: '7731',
    accountId: 12,
    lastSyncAt: new Date('2026-10-05T10:00:00Z'),
    lastError: null,
    createdAt: new Date('2026-10-01T09:00:00Z'),
    keyExpiresAt: new Date('2027-01-05T00:00:00Z'),
    apiKeyEncrypted: 'CIPHER',
  },
  {
    id: 2,
    exchange: 'binance',
    label: 'Binance',
    status: 'error',
    keyHint: 'ab12',
    accountId: null,
    lastSyncAt: null,
    lastError: 'The exchange rejected this API key.',
    createdAt: new Date('2026-10-02T09:00:00Z'),
  },
] as any[];

describe('crypto wire format (real SerializeInterceptor)', () => {
  it('GET /connections: array elements are snake_case, nulls survive', async () => {
    expect(await wire(connections.map(toConnectionView))).toEqual([
      {
        id: 1,
        exchange: 'kraken',
        label: 'Kraken - Trading',
        status: 'active',
        mode: 'api',
        key_hint: '7731',
        account_id: 12,
        last_sync_at: '2026-10-05T10:00:00.000Z',
        last_error: null,
        created_at: '2026-10-01T09:00:00.000Z',
        key_expires_at: '2027-01-05T00:00:00.000Z',
      },
      {
        id: 2,
        exchange: 'binance',
        label: 'Binance',
        status: 'error',
        mode: 'api',
        key_hint: 'ab12',
        account_id: null,
        last_sync_at: null,
        last_error: 'The exchange rejected this API key.',
        created_at: '2026-10-02T09:00:00.000Z',
        key_expires_at: null,
      },
    ]);
  });

  it('POST/PATCH /connections: a single object is snake_case too', async () => {
    expect(await wire(toConnectionView(connections[1]))).toEqual({
      id: 2,
      exchange: 'binance',
      label: 'Binance',
      status: 'error',
      mode: 'api',
      key_hint: 'ab12',
      account_id: null,
      last_sync_at: null,
      last_error: 'The exchange rejected this API key.',
      created_at: '2026-10-02T09:00:00.000Z',
      key_expires_at: null,
    });
  });

  it('GET /balances: top level, connections[] elements and nested balances[] are snake_case; asset keys are values, not keys', async () => {
    const view = buildBalancesView(
      [
        { id: 1, accountId: 12 },
        { id: 2, accountId: null },
      ] as any,
      [
        {
          id: 1,
          connectionId: 1,
          asset: 'BTC',
          free: '0.75000000',
          locked: '0.10000000',
          capturedAt: new Date('2026-10-05T10:00:00Z'),
        },
        {
          id: 2,
          connectionId: 1,
          asset: 'ETH',
          free: '2.00000000',
          locked: '0',
          capturedAt: new Date('2026-10-05T10:00:00Z'),
        },
        {
          id: 3,
          connectionId: 2,
          asset: 'SOL',
          free: '10',
          locked: '0',
          capturedAt: new Date('2026-10-05T10:05:00Z'),
        },
        {
          id: 4,
          connectionId: 2,
          asset: 'USDT',
          free: '5.5',
          locked: '1.5',
          capturedAt: new Date('2026-10-05T10:05:00Z'),
        },
      ] as any,
    );

    expect(await wire(view)).toEqual({
      connections: [
        {
          connection_id: 1,
          account_id: 12,
          balances: [
            { asset: 'BTC', free: '0.75000000', locked: '0.10000000' },
            { asset: 'ETH', free: '2.00000000', locked: '0' },
          ],
          captured_at: '2026-10-05T10:00:00.000Z',
        },
        {
          connection_id: 2,
          account_id: null,
          balances: [
            { asset: 'SOL', free: '10', locked: '0' },
            { asset: 'USDT', free: '5.5', locked: '1.5' },
          ],
          captured_at: '2026-10-05T10:05:00.000Z',
        },
      ],
    });
  });

  it('GET /sync-runs: elements and their errors[] are snake_case', async () => {
    const run = toRunView({
      id: 4,
      connectionId: 2,
      kind: 'manual',
      status: 'failed',
      rangeFrom: null,
      rangeTo: null,
      fetchedCount: 10,
      insertedCount: 8,
      errors: JSON.stringify([
        {
          name: 'ExchangeAuthError',
          message: 'The exchange rejected this API key.',
          retryable: false,
          at: '2026-10-05T10:00:00.000Z',
          code: 'AUTH',
        },
      ]),
      startedAt: new Date('2026-10-05T10:00:00Z'),
      finishedAt: new Date('2026-10-05T10:01:00Z'),
    } as any);

    expect(await wire([run])).toEqual([
      {
        id: 4,
        connection_id: 2,
        kind: 'manual',
        status: 'failed',
        range_from: null,
        range_to: null,
        fetched_count: 10,
        inserted_count: 8,
        errors: [
          {
            code: 'AUTH',
            message: 'The exchange rejected this API key.',
            retryable: false,
            at: '2026-10-05T10:00:00.000Z',
          },
        ],
        started_at: '2026-10-05T10:00:00.000Z',
        finished_at: '2026-10-05T10:01:00.000Z',
      },
    ]);
  });

  it('POST /:id/sync: { queued: true } is unchanged; null from a handler becomes an empty string only at the top level', async () => {
    expect(await wire({ queued: true })).toEqual({ queued: true });
    const excl = new ExcludeNullInterceptor();
    const top = await lastValueFrom(
      excl.intercept({} as any, { handle: () => of(null) }),
    );
    expect(top).toBe('');
    const nested = await lastValueFrom(
      excl.intercept({} as any, { handle: () => of({ account_id: null }) }),
    );
    expect(nested).toEqual({ account_id: null });
  });
});

describe('connections list wire format with history coverage', () => {
  it('serializes history_coverage and key_expires_at in snake_case', async () => {
    const out = await wire([
      {
        ...toConnectionView(connections[0]),
        historyCoverage: { level: 'partial', note: 'API history is limited' },
      },
    ]);
    expect(out[0]).toMatchObject({
      key_expires_at: '2027-01-05T00:00:00.000Z',
      history_coverage: { level: 'partial', note: 'API history is limited' },
    });
  });
});

describe('crypto Swagger documentation', () => {
  const proto = CryptoExchangesController.prototype as any;
  const statuses = (name: string) =>
    Object.keys(
      Reflect.getMetadata(DECORATORS.API_RESPONSE, proto[name]) ?? {},
    );

  it.each([
    ['listConnections', ['200']],
    ['createCryptoConnection', ['201', '400', '409', '422', '429']],
    ['updateCryptoConnection', ['200', '404', '409']],
    ['deleteCryptoConnection', ['200', '404']],
    ['rotateCryptoCredentials', ['200', '404', '422']],
    ['syncCryptoConnection', ['202', '404', '409', '429']],
    ['cryptoBalances', ['200']],
    ['cryptoSyncRuns', ['200']],
    ['previewCryptoCsv', ['201', '404', '409', '413', '422']],
    ['commitCryptoCsv', ['200', '404', '409', '413', '422', '503']],
    ['listCryptoCsvImports', ['200', '404']],
    ['rollbackCryptoCsv', ['200', '404', '409']],
  ])('%s documents responses %j', (name, expected) => {
    expect(statuses(name)).toEqual(expect.arrayContaining(expected));
  });

  it('every documented response carries an example', () => {
    for (const name of Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    )) {
      const responses = Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        proto[name],
      );
      for (const [status, response] of Object.entries<any>(responses)) {
        expect([name, status, response.schema?.example !== undefined]).toEqual([
          name,
          status,
          true,
        ]);
      }
    }
  });
});

describe('CSV import wire format (real SerializeInterceptor)', () => {
  it('the import view is snake_case', async () => {
    const out = await wire(
      toCsvImportView({
        id: 12,
        connectionId: 1,
        reportType: 'raw-trading-details',
        originalFilename: 'trades.csv',
        rowCount: 120,
        rowsImported: 118,
        rowsSkippedDuplicate: 0,
        rowsRejected: 2,
        dateFrom: new Date('2026-01-02T08:00:00Z'),
        dateTo: null,
        status: 'committed',
        createdAt: new Date('2026-10-08T10:00:00Z'),
        committedAt: null,
      } as any),
    );
    expect(out).toMatchObject({
      id: 12,
      connection_id: 1,
      report_type: 'raw-trading-details',
      row_count: 120,
      rows_imported: 118,
      rows_skipped_duplicate: 0,
      rows_rejected: 2,
      date_from: '2026-01-02T08:00:00.000Z',
      date_to: null,
      created_at: '2026-10-08T10:00:00.000Z',
      committed_at: null,
    });
    expect(Object.keys(out).some((k) => /[A-Z]/.test(k))).toBe(false);
  });

  it('the preview is snake_case, including by_type keys and the rejected list', async () => {
    const out = await wire({
      importId: 12,
      connectionId: 1,
      exchange: 'pionex',
      reportType: 'raw-trading-details',
      filename: 'trades.csv',
      fileSha256: 'abc',
      rowCount: 5,
      importable: 3,
      alreadyImported: 0,
      rejectedCount: 2,
      rejected: [{ line: 14, reason: 'Bad decimal' }],
      byType: { trade_summary: 3 },
      dateFrom: null,
      dateTo: null,
      apiOverlap: 0,
    });
    expect(out).toMatchObject({
      import_id: 12,
      file_sha256: 'abc',
      row_count: 5,
      already_imported: 0,
      rejected_count: 2,
      by_type: { trade_summary: 3 },
      api_overlap: 0,
      rejected: [{ line: 14, reason: 'Bad decimal' }],
    });
    expect(Object.keys(out).some((k) => /[A-Z]/.test(k))).toBe(false);
  });
});
