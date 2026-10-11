import { Ability } from '@casl/ability';
import {
  BadRequestException,
  ForbiddenException,
  RequestMethod,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ServiceError } from '@/modules/Items/ServiceError';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { REQUIRED_PERMISSION_KEY } from '@/modules/Roles/RequirePermission.decorator';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { ValidationPipe } from '@/common/pipes/ClassValidation.pipe';
import { CryptoExchangesController } from './CryptoExchanges.controller';
import {
  CryptoExchangeExceptionFilter,
  CSV_ERROR_STATUS,
} from './CryptoExchanges.filter';
import {
  CRYPTO_CONNECTION_ERRORS as ERRORS,
  CRYPTO_CSV_IMPORT_ERRORS,
} from './CryptoExchanges.constants';
import { CsvErrorCode, CsvImportError } from './csv/csv.types';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  ExchangeSchemaError,
  KeyHasExtraPermissionsError,
} from './adapters/errors';
import { CreateCryptoConnectionDto } from './dtos/CreateCryptoConnection.dto';
import { DeleteCryptoConnectionQueryDto } from './dtos/DeleteCryptoConnectionQuery.dto';
import { GetCryptoSyncRunsQueryDto } from './dtos/GetCryptoSyncRunsQuery.dto';
import { RotateCredentialsDto } from './dtos/RotateCredentials.dto';
import { UpdateCryptoConnectionDto } from './dtos/UpdateCryptoConnection.dto';
import { toConnectionView } from './commands/CryptoConnectionView';
import {
  CryptoManualSyncThrottledException,
  CryptoSyncRequestService,
} from './sync/CryptoSyncRequest.service';
import { FAKE_KEY, FAKE_PASSPHRASE, FAKE_SECRET } from './commands/testFakes';

/**
 * Plain unit tests: the controller is instantiated directly and its guards,
 * pipe and exception filter are exercised on their own. (Nest's HTTP server
 * never answers inside this jest environment, so there is no supertest here;
 * the real HTTP behaviour is verified against the running API instead.)
 */

const connectionRow = {
  id: 7,
  exchange: 'kraken',
  label: 'Kraken - Trading',
  status: 'active',
  keyHint: '7731',
  accountId: null,
  lastSyncAt: null,
  lastError: null,
  createdAt: new Date('2026-10-05T10:00:00Z'),
  // what must never reach the wire
  apiKeyEncrypted: `CIPHER-${FAKE_KEY}`,
  apiSecretEncrypted: `CIPHER-${FAKE_SECRET}`,
  passphraseEncrypted: `CIPHER-${FAKE_PASSPHRASE}`,
};
const view = () => toConnectionView(connectionRow as any);

const makeMocks = () => ({
  list: { execute: jest.fn(async () => [view()]) },
  balances: { execute: jest.fn(async () => ({ connections: [] })) },
  runs: { execute: jest.fn(async () => []) },
  create: { execute: jest.fn(async () => view()) },
  update: { execute: jest.fn(async () => view()) },
  rotate: { execute: jest.fn(async () => view()) },
  remove: { execute: jest.fn(async () => undefined) },
  sync: {
    selfHeal: jest.fn(async () => undefined),
    requestManualSync: jest.fn(async () => undefined),
  },
  csvPreview: { execute: jest.fn(async () => ({ importId: 5 })) },
  csvCommit: { execute: jest.fn(async () => ({ id: 5 })) },
  csvRollback: { execute: jest.fn(async () => ({ id: 5 })) },
  csvList: { execute: jest.fn(async () => [{ id: 5 }]) },
  cls: { get: jest.fn((key: string) => (key === 'userId' ? 42 : undefined)) },
});

const makeController = (mocks = makeMocks()) => ({
  mocks,
  controller: new CryptoExchangesController(
    mocks.list as any,
    mocks.balances as any,
    mocks.runs as any,
    mocks.create as any,
    mocks.update as any,
    mocks.rotate as any,
    mocks.remove as any,
    mocks.sync as any,
    mocks.csvPreview as any,
    mocks.csvCommit as any,
    mocks.csvRollback as any,
    mocks.csvList as any,
    mocks.cls as any,
  ),
});

const fakeRes = () => {
  const res: any = { code: undefined, headers: {}, body: undefined };
  res.status = (code: number) => ((res.code = code), res);
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  res.json = (body: unknown) => ((res.body = body), res);
  return res;
};
const host = (res: unknown) =>
  ({ switchToHttp: () => ({ getResponse: () => res }) }) as any;

const mapError = (error: unknown) => {
  const res = fakeRes();
  new CryptoExchangeExceptionFilter().catch(error, host(res));
  return res;
};

const pipe = new ValidationPipe();
const validate = (metatype: any, value: unknown, type = 'body') =>
  pipe.transform(value, { metatype, type } as any);

const withAccount = {
  ability: new Ability([
    { action: 'Create', subject: AbilitySubject.CryptoExchange },
    { action: 'Create', subject: AbilitySubject.Account },
  ]),
};

const createBody = {
  exchange: 'kraken',
  label: 'Kraken - Trading',
  apiKey: FAKE_KEY,
  apiSecret: FAKE_SECRET,
  passphrase: FAKE_PASSPHRASE,
  createAccount: true,
};

describe('CryptoExchangesController routing and permissions', () => {
  /** handler name, HTTP verb, path, permission action */
  const routes: Array<[string, RequestMethod, string, string]> = [
    ['listConnections', RequestMethod.GET, 'connections', 'View'],
    ['createCryptoConnection', RequestMethod.POST, 'connections', 'Create'],
    ['updateCryptoConnection', RequestMethod.PATCH, 'connections/:id', 'Edit'],
    [
      'deleteCryptoConnection',
      RequestMethod.DELETE,
      'connections/:id',
      'Delete',
    ],
    [
      'rotateCryptoCredentials',
      RequestMethod.POST,
      'connections/:id/credentials',
      'Edit',
    ],
    [
      'syncCryptoConnection',
      RequestMethod.POST,
      'connections/:id/sync',
      'Edit',
    ],
    ['cryptoBalances', RequestMethod.GET, 'balances', 'View'],
    ['cryptoSyncRuns', RequestMethod.GET, 'sync-runs', 'View'],
    [
      'previewCryptoCsv',
      RequestMethod.POST,
      'connections/:id/imports',
      'Create',
    ],
    [
      'commitCryptoCsv',
      RequestMethod.POST,
      'imports/:importId/commit',
      'Create',
    ],
    [
      'listCryptoCsvImports',
      RequestMethod.GET,
      'connections/:id/imports',
      'View',
    ],
    ['rollbackCryptoCsv', RequestMethod.DELETE, 'imports/:importId', 'Delete'],
  ];
  const proto = CryptoExchangesController.prototype as any;
  const guard = new PermissionGuard(new Reflector());
  const ctx = (handler: unknown, ability: Ability) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ ability }) }),
      getHandler: () => handler,
      getClass: () => CryptoExchangesController,
    }) as any;

  it('lives under /crypto and has exactly the twelve documented handlers', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CryptoExchangesController)).toBe(
      'crypto',
    );
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    );
    expect(handlers.sort()).toEqual(routes.map(([name]) => name).sort());
  });

  it.each(routes)('%s is %s /crypto/%s', (name, verb, path) => {
    expect(Reflect.getMetadata(METHOD_METADATA, proto[name])).toBe(verb);
    expect(Reflect.getMetadata(PATH_METADATA, proto[name])).toBe(path);
  });

  it('uses the authorization + permission guards and the crypto exception filter', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CryptoExchangesController),
    ).toEqual([AuthorizationGuard, PermissionGuard]);
    expect(
      Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        CryptoExchangesController,
      ),
    ).toEqual([CryptoExchangeExceptionFilter]);
  });

  it.each(routes)(
    '%s requires %s CryptoExchange: denied without it, allowed with exactly it',
    (name, _verb, _path, action) => {
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto[name])).toEqual(
        {
          ability: action,
          subject: AbilitySubject.CryptoExchange,
        },
      );

      const wrong = new Ability([
        {
          action: action === 'View' ? 'Delete' : 'View',
          subject: AbilitySubject.CryptoExchange,
        },
        { action, subject: AbilitySubject.Customer },
      ] as any);
      expect(() => guard.canActivate(ctx(proto[name], wrong))).toThrow(
        ForbiddenException,
      );
      expect(() =>
        guard.canActivate(ctx(proto[name], new Ability([]))),
      ).toThrow(ForbiddenException);

      const exact = new Ability([
        { action, subject: AbilitySubject.CryptoExchange },
      ] as any);
      expect(guard.canActivate(ctx(proto[name], exact))).toBe(true);
    },
  );

  it('answers a manual sync with 202 and rotation with 200', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, proto.syncCryptoConnection),
    ).toBe(202);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, proto.rotateCryptoCredentials),
    ).toBe(200);
  });
});

describe('CryptoExchangesController delegation', () => {
  it('lists connections and re-registers repeatable jobs (self-heal) with them', async () => {
    const { controller, mocks } = makeController();

    const result = await controller.listConnections();

    expect(result).toEqual([view()]);
    expect(mocks.sync.selfHeal).toHaveBeenCalledWith([view()]);
  });

  it('create delegates the validated DTO and returns a view without any secret', async () => {
    const { controller, mocks } = makeController();
    const dto = (await validate(CreateCryptoConnectionDto, {
      ...createBody,
      isAdmin: true,
    })) as CreateCryptoConnectionDto;

    const result = await controller.createCryptoConnection(dto, withAccount);

    expect(dto).not.toHaveProperty('isAdmin'); // whitelist strips unknown fields
    expect(mocks.create.execute).toHaveBeenCalledWith(dto);
    expect(dto).toMatchObject(createBody);
    const json = JSON.stringify(result);
    for (const secret of [FAKE_KEY, FAKE_SECRET, FAKE_PASSPHRASE, 'CIPHER']) {
      expect(json).not.toContain(secret);
    }
  });

  it('rejects an invalid create body before it could reach the command', async () => {
    await expect(
      validate(CreateCryptoConnectionDto, {
        exchange: 'ftx',
        label: '',
        apiKey: '',
        apiSecret: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update delegates id and DTO', async () => {
    const { controller, mocks } = makeController();
    const dto = (await validate(UpdateCryptoConnectionDto, {
      label: 'Renamed',
      status: 'paused',
      accountId: null,
      extra: 1,
    })) as UpdateCryptoConnectionDto;

    await controller.updateCryptoConnection(7, dto);

    expect(mocks.update.execute).toHaveBeenCalledWith(7, dto);
    expect(dto).toMatchObject({ label: 'Renamed', status: 'paused' });
    expect(dto).not.toHaveProperty('extra');
  });

  it('rotate delegates id and DTO and never echoes the new credentials', async () => {
    const { controller, mocks } = makeController();
    const dto = (await validate(RotateCredentialsDto, {
      apiKey: FAKE_KEY,
      apiSecret: FAKE_SECRET,
      attestReadOnly: true,
    })) as RotateCredentialsDto;

    const result = await controller.rotateCryptoCredentials(7, dto);

    expect(mocks.rotate.execute).toHaveBeenCalledWith(7, dto);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });

  it('delete keeps stored data by default and purges only with deleteData=true', async () => {
    const { controller, mocks } = makeController();
    const query = async (q: object) =>
      (await validate(
        DeleteCryptoConnectionQueryDto,
        q,
        'query',
      )) as DeleteCryptoConnectionQueryDto;

    await controller.deleteCryptoConnection(7, await query({}));
    await controller.deleteCryptoConnection(
      7,
      await query({ deleteData: 'true' }),
    );
    await controller.deleteCryptoConnection(
      7,
      await query({ deleteData: 'nope' }),
    );

    expect(mocks.remove.execute).toHaveBeenNthCalledWith(1, 7, {
      deleteData: false,
    });
    expect(mocks.remove.execute).toHaveBeenNthCalledWith(2, 7, {
      deleteData: true,
    });
    expect(mocks.remove.execute).toHaveBeenNthCalledWith(3, 7, {
      deleteData: false,
    });
  });

  it('balances and sync runs delegate to their queries', async () => {
    const { controller, mocks } = makeController();
    const q = (await validate(
      GetCryptoSyncRunsQueryDto,
      { connectionId: '3', limit: '50' },
      'query',
    )) as GetCryptoSyncRunsQueryDto;

    await controller.cryptoBalances();
    await controller.cryptoSyncRuns(q);

    expect(mocks.balances.execute).toHaveBeenCalledTimes(1);
    expect(mocks.runs.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 3, limit: 50 }),
    );
  });

  it('rejects a non-numeric sync-runs limit and a limit below 1', async () => {
    for (const limit of ['abc', '0']) {
      await expect(
        validate(GetCryptoSyncRunsQueryDto, { limit }, 'query'),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('manual sync queues through the request service and answers { queued: true }', async () => {
    const { controller, mocks } = makeController();

    await expect(controller.syncCryptoConnection(7)).resolves.toEqual({
      queued: true,
    });
    expect(mocks.sync.requestManualSync).toHaveBeenCalledWith(7);
  });

  it('lets command errors propagate untouched to the exception filter', async () => {
    const { controller, mocks } = makeController();
    const failure = new KeyHasExtraPermissionsError(['Withdraw Funds']);
    mocks.create.execute.mockRejectedValueOnce(failure);

    await expect(
      controller.createCryptoConnection(createBody as any, withAccount),
    ).rejects.toBe(failure);
  });

  describe('createAccount needs Account Create too', () => {
    const noAccount = {
      ability: new Ability([
        { action: 'Create', subject: AbilitySubject.CryptoExchange },
      ]),
    };

    it('refuses createAccount:true without Account Create, before touching the service', async () => {
      const { controller, mocks } = makeController();
      expect(() =>
        controller.createCryptoConnection(createBody as any, noAccount),
      ).toThrow(ForbiddenException);
      expect(() =>
        controller.createCryptoConnection(createBody as any),
      ).toThrow(ForbiddenException);
      expect(mocks.create.execute).not.toHaveBeenCalled();
    });

    it('allows createAccount:true with Account Create, and no-account creates without it', async () => {
      const { controller, mocks } = makeController();
      await controller.createCryptoConnection(createBody as any, withAccount);
      const { createAccount: _ignored, ...plain } = createBody;
      await controller.createCryptoConnection(plain as any, noAccount);
      expect(mocks.create.execute).toHaveBeenCalledTimes(2);
    });
  });
});

describe('CryptoExchangeExceptionFilter', () => {
  it('maps KeyHasExtraPermissionsError to 422 KEY_HAS_EXTRA_PERMISSIONS with the offending permissions', () => {
    const res = mapError(
      new KeyHasExtraPermissionsError([
        'Create & Modify Orders',
        'Withdraw Funds',
      ]),
    );

    expect(res.code).toBe(422);
    expect(res.body).toEqual({
      code: 'KEY_HAS_EXTRA_PERMISSIONS',
      permissions: ['Create & Modify Orders', 'Withdraw Funds'],
      message: expect.stringContaining('read-only'),
    });
  });

  it.each([
    [ERRORS.ACCOUNT_ALREADY_MAPPED, 409],
    [ERRORS.ACCOUNT_MAPPING_CONFLICT, 409],
    [ERRORS.IN_ERROR, 409],
    [ERRORS.CONNECTION_PAUSED, 409],
    [ERRORS.ACCOUNT_NOT_ASSET, 400],
    [ERRORS.ACCOUNT_CURRENCY_MISMATCH, 400],
    [ERRORS.ACCOUNT_NOT_FOUND, 400],
    [ERRORS.CREDENTIALS_REQUIRED, 400],
  ])(
    'maps ServiceError %s to HTTP %i with the machine-readable type',
    (type, status) => {
      const res = mapError(new ServiceError(type, 'Friendly message.'));

      expect(res.code).toBe(status);
      expect(res.body).toEqual({
        errors: [
          {
            statusCode: status,
            type,
            message: 'Friendly message.',
            payload: undefined,
          },
        ],
      });
    },
  );

  it('keeps an explicit 404 from the service', () => {
    const res = mapError(
      new ServiceError(
        ERRORS.NOT_FOUND,
        'Crypto connection not found.',
        undefined,
        404,
      ),
    );
    expect(res.code).toBe(404);
    expect(res.body.errors[0].type).toBe(ERRORS.NOT_FOUND);
  });

  it('exposes only the adapter userMessage for exchange failures, never the raw upstream text', () => {
    const upstream = `EAPI:Invalid key ${FAKE_KEY} raw upstream text`;
    const cases: Array<[any, number, string]> = [
      [new ExchangeAuthError(upstream), 422, 'EXCHANGE_AUTH_FAILED'],
      [new ExchangeNetworkError(upstream), 502, 'EXCHANGE_UNREACHABLE'],
      [
        new ExchangeSchemaError(upstream, { raw: upstream }),
        502,
        'EXCHANGE_UNEXPECTED_RESPONSE',
      ],
      [new ExchangeRateLimitError(upstream), 429, 'EXCHANGE_RATE_LIMITED'],
    ];
    for (const [error, status, code] of cases) {
      const res = mapError(error);
      expect(res.code).toBe(status);
      expect(res.body).toEqual({ code, message: error.userMessage });
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('raw upstream text');
      expect(json).not.toContain(FAKE_KEY);
    }
  });

  it('forwards an exchange Retry-After on an upstream rate limit', () => {
    const res = mapError(
      new ExchangeRateLimitError('x', 'The exchange is rate limiting.', 2500),
    );
    expect(res.headers['Retry-After']).toBe('3');
  });

  it('maps the manual-sync throttle to 429 with Retry-After and the seconds in the body', () => {
    const res = mapError(new CryptoManualSyncThrottledException(48));

    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe('48');
    expect(res.body).toEqual({
      code: 'CRYPTO_SYNC_THROTTLED',
      message: expect.any(String),
      retryAfterSeconds: 48,
    });
  });

  it('leaves the 422 ATTESTATION_REQUIRED body to Nest (the filter does not catch it)', () => {
    const caught = Reflect.getMetadata(
      '__filterCatchExceptions__',
      CryptoExchangeExceptionFilter,
    ) as unknown[];
    expect(caught).toBeDefined();
    expect(caught).not.toContain(UnprocessableEntityException);
    expect(
      new UnprocessableEntityException({
        code: 'ATTESTATION_REQUIRED',
      }).getResponse(),
    ).toEqual({ code: 'ATTESTATION_REQUIRED' });
  });
});

describe('CSV import endpoints: delegation', () => {
  const file = { buffer: Buffer.from('a,b\n1,2\n'), originalname: 'x.csv' };

  it('preview passes the connection id, the file and the CLS user id', async () => {
    const { controller, mocks } = makeController();
    await controller.previewCryptoCsv(7, file);
    expect(mocks.csvPreview.execute).toHaveBeenCalledWith(
      7,
      { buffer: file.buffer, originalname: 'x.csv' },
      42,
    );
  });

  it('commit, list and rollback delegate their ids', async () => {
    const { controller, mocks } = makeController();
    await controller.commitCryptoCsv(5, file);
    expect(mocks.csvCommit.execute).toHaveBeenCalledWith(5, {
      buffer: file.buffer,
      originalname: 'x.csv',
    });
    await controller.listCryptoCsvImports(7);
    expect(mocks.csvList.execute).toHaveBeenCalledWith(7);
    await controller.rollbackCryptoCsv(5);
    expect(mocks.csvRollback.execute).toHaveBeenCalledWith(5);
  });

  it('a missing file part is CSV_FORMAT_UNRECOGNIZED before any service runs', () => {
    const { controller, mocks } = makeController();
    expect(() => controller.previewCryptoCsv(7, undefined)).toThrow(
      CsvImportError,
    );
    expect(() => controller.commitCryptoCsv(5, undefined)).toThrow(
      expect.objectContaining({ code: 'CSV_FORMAT_UNRECOGNIZED' }),
    );
    expect(mocks.csvPreview.execute).not.toHaveBeenCalled();
    expect(mocks.csvCommit.execute).not.toHaveBeenCalled();
  });

  it('commit answers 200 and the upload routes use the CSV interceptor', () => {
    const proto = CryptoExchangesController.prototype as any;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.commitCryptoCsv)).toBe(
      200,
    );
    for (const name of ['previewCryptoCsv', 'commitCryptoCsv']) {
      expect(Reflect.getMetadata('__interceptors__', proto[name])).toHaveLength(
        1,
      );
    }
    expect(
      Reflect.getMetadata('__interceptors__', proto.listCryptoCsvImports),
    ).toBeUndefined();
  });
});

describe('CryptoExchangeExceptionFilter: CSV import errors', () => {
  const codes: Array<[CsvErrorCode, number]> = [
    ['CSV_FORMAT_UNRECOGNIZED', 422],
    ['CSV_DERIVED_EXPORT_REFUSED', 422],
    ['CSV_MALFORMED', 422],
    ['CSV_DUPLICATE_FILE', 409],
    ['CSV_FILE_CHANGED', 409],
    ['CSV_NOT_ROLLBACKABLE', 409],
    ['CSV_NOT_COMMITTABLE', 409],
    ['CSV_TOO_LARGE', 413],
    ['CSV_BUSY', 503],
  ];

  it('covers every CsvErrorCode', () => {
    expect(Object.keys(CSV_ERROR_STATUS).sort()).toEqual(
      codes.map(([c]) => c).sort(),
    );
  });

  it.each(codes)(
    'maps %s to HTTP %i with a stable { code, message } body',
    (code, status) => {
      const err = new CsvImportError(code, 'Friendly message.', {
        secretRow: 'ROW-CONTENT',
        line: 3,
      });
      const res = mapError(err);
      expect(res.code).toBe(status);
      expect(res.body).toEqual({ code, message: 'Friendly message.' });
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('ROW-CONTENT');
      expect(json).not.toContain('stack');
      expect(json).not.toContain(' at ');
    },
  );

  it('CSV_BUSY carries Retry-After; other codes do not', () => {
    expect(mapError(new CsvImportError('CSV_BUSY', 'busy')).headers).toEqual({
      'Retry-After': '5',
    });
    expect(
      mapError(new CsvImportError('CSV_TOO_LARGE', 'big')).headers,
    ).toEqual({});
  });

  it('CSV_NOT_ROLLBACKABLE exposes dependentImportIds (numbers only); other codes never do', () => {
    const res = mapError(
      new CsvImportError('CSV_NOT_ROLLBACKABLE', 'Roll back later ones.', {
        dependentImportIds: [13, '14', 'x', 2.5],
      }),
    );
    expect(res.body).toEqual({
      code: 'CSV_NOT_ROLLBACKABLE',
      message: 'Roll back later ones.',
      dependentImportIds: [13, 14],
    });
    const other = mapError(
      new CsvImportError('CSV_FILE_CHANGED', 'changed', {
        dependentImportIds: [1],
      }),
    );
    expect(other.body).toEqual({
      code: 'CSV_FILE_CHANGED',
      message: 'changed',
    });
  });

  it('maps a missing import ServiceError to 404', () => {
    const res = mapError(
      new ServiceError(
        CRYPTO_CSV_IMPORT_ERRORS.NOT_FOUND,
        'CSV import not found.',
      ),
    );
    expect(res.code).toBe(404);
    expect(res.body.errors[0].type).toBe('CRYPTO_CSV_IMPORT_NOT_FOUND');
  });
});

describe('manual sync throttle end to end (real service, fake Redis)', () => {
  it('first request is accepted, the second within 60 s becomes 429 with Retry-After', async () => {
    const store = new Map<string, number>();
    const redis = {
      set: async (key: string, _v: string, _px: string, ttl: number) => {
        if (store.has(key)) return null;
        store.set(key, ttl);
        return 'OK';
      },
      pttl: async () => 41_000,
      del: async (key: string) => (store.delete(key) ? 1 : 0),
    };
    const scheduler = {
      schedule: jest.fn(),
      enqueue: jest.fn(async () => undefined),
    };
    const real = new CryptoSyncRequestService(
      {
        findById: async () => ({ id: 7, exchange: 'kraken', status: 'active' }),
      } as any,
      scheduler as any,
      { getOrThrow: () => redis } as any,
      { get: () => 'org-1' } as any,
    );
    const { controller } = makeController({
      ...makeMocks(),
      sync: real as any,
    });

    const first = await controller.syncCryptoConnection(7);
    const second = await controller.syncCryptoConnection(7).catch((e) => e);
    const res = mapError(second);

    expect(first).toEqual({ queued: true });
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe('41');
  });
});
