import { UnrecoverableError } from 'bullmq';
import { CryptoSyncProcessor } from './CryptoSync.processor';
import {
  ExchangeAuthError,
  ExchangeNetworkError,
  ExchangeRateLimitError,
  KeyHasExtraPermissionsError,
} from '../adapters/errors';

const ORG = '4242';
const connectionRow = (over: Record<string, any> = {}) => ({
  id: 7,
  exchange: 'kraken',
  status: 'active',
  deletedAt: null,
  lastError: null,
  initialSyncCompletedAt: new Date('2026-01-01'),
  apiKeyEncrypted: 'ENC-KEY',
  apiSecretEncrypted: 'ENC-SECRET',
  ...over,
});
const run = (over: Record<string, any> = {}) => ({
  id: 99,
  connectionId: 7,
  kind: 'incremental',
  status: 'succeeded',
  fetchedCount: 3,
  insertedCount: 3,
  continuation: false,
  ...over,
});
const job = (kind: string = 'incremental', over: Record<string, any> = {}) =>
  ({ data: { connectionId: 7, organizationId: ORG, kind }, ...over }) as any;

const setup = (conn: any = connectionRow(), syncResult: any = run()) => {
  const clsStore = new Map<string, any>();
  const order: string[] = [];
  const cls = {
    set: (k: string, v: any) => {
      clsStore.set(k, v);
      order.push(`cls.set:${k}`);
    },
    get: (k: string) => clsStore.get(k),
  };
  const tenantModel = {
    query: () => ({
      findOne: async (where: any) => {
        order.push('tenant.lookup');
        return where.organizationId === ORG
          ? { id: 5, organizationId: ORG }
          : undefined;
      },
    }),
  };
  const systemUserModel = {
    query: () => ({
      findOne: (where: any) => ({
        modify: async () => {
          order.push('user.lookup');
          return where.tenantId === 5 ? { id: 77 } : undefined;
        },
      }),
    }),
  };
  const connections: any = {
    findById: jest.fn(async () => {
      order.push('connections.findById');
      return conn;
    }),
    markActive: jest.fn(async () => undefined),
  };
  const syncSeen: any[] = [];
  const syncService: any = {
    syncConnection: jest.fn(async (_id: number, _kind: string) => {
      order.push('sync');
      syncSeen.push({
        organizationId: clsStore.get('organizationId'),
        userId: clsStore.get('userId'),
      });
      if (syncResult instanceof Error) throw syncResult;
      return syncResult;
    }),
    heldAssets: jest.fn(async () => ['BTC', 'ETH']),
  };
  const scheduler: any = { enqueue: jest.fn(async () => undefined) };
  const redisCalls: any[] = [];
  const redis: any = {
    sadd: jest.fn(async (...args: any[]) => redisCalls.push(['sadd', ...args])),
    expire: jest.fn(async (...args: any[]) =>
      redisCalls.push(['expire', ...args]),
    ),
  };
  const emitter = { connectionSynced: jest.fn() };
  const processor = new CryptoSyncProcessor(
    cls as any,
    tenantModel as any,
    systemUserModel as any,
    connections,
    syncService,
    scheduler,
    { getOrThrow: () => redis } as any,
    emitter as any,
  );
  return {
    processor,
    connections,
    syncService,
    scheduler,
    redis,
    redisCalls,
    emitter,
    syncSeen,
    order,
  };
};

describe('CryptoSyncProcessor', () => {
  it('sets the tenant context (organization and active system user) before calling the sync service', async () => {
    const t = setup();
    await t.processor.process(job());

    expect(t.syncSeen).toEqual([{ organizationId: ORG, userId: 77 }]);
    expect(t.syncService.syncConnection).toHaveBeenCalledWith(7, 'incremental');
    expect(t.order.indexOf('cls.set:organizationId')).toBeLessThan(
      t.order.indexOf('connections.findById'),
    );
    expect(t.order.indexOf('cls.set:userId')).toBeLessThan(
      t.order.indexOf('sync'),
    );
  });

  describe('skipping', () => {
    const skipCases: [string, any][] = [
      ['missing', null],
      [
        'archived',
        connectionRow({
          deletedAt: new Date(),
          apiKeyEncrypted: '',
          apiSecretEncrypted: '',
        }),
      ],
      ['paused', connectionRow({ status: 'paused' })],
      ['in error', connectionRow({ status: 'error' })],
    ];
    it.each(skipCases)(
      'completes without error and without syncing when the connection is %s',
      async (_name, conn) => {
        const t = setup(conn);
        await expect(t.processor.process(job('incremental'))).resolves.toEqual(
          expect.objectContaining({ skipped: expect.any(String) }),
        );
        expect(t.syncService.syncConnection).not.toHaveBeenCalled();
        expect(t.emitter.connectionSynced).not.toHaveBeenCalled();
        expect(t.redisCalls).toEqual([]);
        expect(t.scheduler.enqueue).not.toHaveBeenCalled();
      },
    );

    it('a manual run on an error connection is allowed', async () => {
      const t = setup(connectionRow({ status: 'error' }));
      await t.processor.process(job('manual'));
      expect(t.syncService.syncConnection).toHaveBeenCalledWith(7, 'manual');
    });

    it('a manual run on a paused or archived connection is still skipped', async () => {
      for (const conn of [
        connectionRow({ status: 'paused' }),
        connectionRow({ deletedAt: new Date() }),
      ]) {
        const t = setup(conn);
        await t.processor.process(job('manual'));
        expect(t.syncService.syncConnection).not.toHaveBeenCalled();
      }
    });

    it('skips when the tenant no longer exists', async () => {
      const t = setup();
      await expect(
        t.processor.process({
          data: {
            connectionId: 7,
            organizationId: 'gone',
            kind: 'incremental',
          },
        } as any),
      ).resolves.toEqual(
        expect.objectContaining({ skipped: expect.any(String) }),
      );
      expect(t.syncService.syncConnection).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it.each([
      ['ExchangeAuthError thrown', new ExchangeAuthError()],
      [
        'KeyHasExtraPermissionsError thrown',
        new KeyHasExtraPermissionsError(['withdraw']),
      ],
    ])('%s is final: UnrecoverableError, no retry', async (_n, err) => {
      const t = setup(connectionRow(), err);
      await expect(t.processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(t.emitter.connectionSynced).not.toHaveBeenCalled();
    });

    it('an auth failure returned by the service as a failed run is final too', async () => {
      const t = setup(
        connectionRow(),
        run({
          status: 'failed',
          errors: JSON.stringify([
            {
              name: 'ExchangeAuthError',
              message: 'The exchange rejected this API key.',
              retryable: false,
            },
          ]),
        }),
      );
      await expect(t.processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(t.emitter.connectionSynced).not.toHaveBeenCalled();
      expect(t.redisCalls).toEqual([]);
    });

    it('a non-retryable ExchangeError (e.g. refused paused connection) is final', async () => {
      const { ExchangeError } = jest.requireActual('../adapters/errors');
      const t = setup(connectionRow(), new ExchangeError('x', 'y', false));
      await expect(t.processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it.each([
      ['rate limit', new ExchangeRateLimitError()],
      ['network', new ExchangeNetworkError()],
      ['unknown', new Error('boom')],
    ])(
      '%s errors are rethrown unchanged so backoff retries them',
      async (_n, err) => {
        const t = setup(connectionRow(), err);
        await expect(t.processor.process(job())).rejects.toBe(err);
        expect(t.emitter.connectionSynced).not.toHaveBeenCalled();
      },
    );

    it('a failed manual run leaves an error connection untouched', async () => {
      const t = setup(
        connectionRow({ status: 'error' }),
        new ExchangeAuthError(),
      );
      await expect(t.processor.process(job('manual'))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(t.connections.markActive).not.toHaveBeenCalled();
    });
  });

  describe('after a successful run', () => {
    it('adds the held assets to the Redis set, refreshes its TTL and notifies with ids and status only', async () => {
      const t = setup();
      await t.processor.process(job());

      expect(t.syncService.heldAssets).toHaveBeenCalledWith(7);
      expect(t.redisCalls).toEqual([
        ['sadd', 'crypto:held-assets', 'BTC', 'ETH'],
        ['expire', 'crypto:held-assets', 86400],
      ]);
      expect(t.emitter.connectionSynced).toHaveBeenCalledTimes(1);
      expect(t.emitter.connectionSynced).toHaveBeenCalledWith(
        ORG,
        7,
        'succeeded',
      );
      expect(JSON.stringify(t.emitter.connectionSynced.mock.calls)).not.toMatch(
        /BTC|ENC-/,
      );
    });

    it('a partial run with progress also counts as success', async () => {
      const t = setup(
        connectionRow(),
        run({ status: 'partial', fetchedCount: 5, continuation: false }),
      );
      await t.processor.process(job());
      expect(t.emitter.connectionSynced).toHaveBeenCalledWith(
        ORG,
        7,
        'partial',
      );
      expect(t.redisCalls.length).toBe(2);
    });

    it('a partial run without progress (schema blocked) is not a success: no assets, no notification, no continuation', async () => {
      const t = setup(
        connectionRow(),
        run({
          status: 'partial',
          fetchedCount: 0,
          insertedCount: 0,
          continuation: false,
        }),
      );
      await expect(t.processor.process(job())).resolves.toBeDefined();
      expect(t.emitter.connectionSynced).not.toHaveBeenCalled();
      expect(t.redisCalls).toEqual([]);
      expect(t.scheduler.enqueue).not.toHaveBeenCalled();
    });

    it('does not touch Redis when nothing is held', async () => {
      const t = setup();
      t.syncService.heldAssets.mockResolvedValue([]);
      await t.processor.process(job());
      expect(t.redisCalls).toEqual([]);
      expect(t.emitter.connectionSynced).toHaveBeenCalled();
    });

    it('a Redis or emitter failure does not fail (and so never retries) the finished sync', async () => {
      const t = setup();
      t.redis.sadd.mockRejectedValue(new Error('redis down'));
      t.emitter.connectionSynced.mockImplementation(() => {
        throw new Error('socket down');
      });
      await expect(t.processor.process(job())).resolves.toBeDefined();
    });
  });

  describe('continuation', () => {
    it('continuation:true enqueues exactly one next incremental job once the initial sync is complete', async () => {
      const t = setup(connectionRow(), run({ continuation: true }));
      await t.processor.process(job());
      expect(t.scheduler.enqueue).toHaveBeenCalledTimes(1);
      const [conn, org, kind, jobId] = t.scheduler.enqueue.mock.calls[0];
      expect(conn.id).toBe(7);
      expect(org).toBe(ORG);
      expect(kind).toBe('incremental');
      expect(jobId).toEqual(expect.stringContaining('7'));
    });

    it('continues as initial while initial_sync_completed_at is null', async () => {
      const t = setup(
        connectionRow({ initialSyncCompletedAt: null }),
        run({ status: 'partial', continuation: true }),
      );
      await t.processor.process(job('initial'));
      expect(t.scheduler.enqueue.mock.calls[0][2]).toBe('initial');
    });

    it('continuation:false enqueues nothing', async () => {
      const t = setup(connectionRow(), run({ continuation: false }));
      await t.processor.process(job());
      expect(t.scheduler.enqueue).not.toHaveBeenCalled();
    });

    it('the continuation job id is derived from the run, so a retried/duplicate run cannot flood the queue', async () => {
      const t = setup(connectionRow(), run({ id: 99, continuation: true }));
      await t.processor.process(job());
      await t.processor.process(job());
      const ids = t.scheduler.enqueue.mock.calls.map((c: any[]) => c[3]);
      expect(new Set(ids).size).toBe(1);
    });

    it('a manual continuation stays manual-free: next slice is initial/incremental, never manual', async () => {
      const t = setup(connectionRow(), run({ continuation: true }));
      await t.processor.process(job('manual'));
      expect(t.scheduler.enqueue.mock.calls[0][2]).not.toBe('manual');
    });
  });

  describe('reconnect rule', () => {
    it('a successful manual run on an error connection sets it back to active and clears last_error', async () => {
      const t = setup(
        connectionRow({
          status: 'error',
          lastError: 'The exchange rejected this API key.',
        }),
      );
      await t.processor.process(job('manual'));
      expect(t.connections.markActive).toHaveBeenCalledWith(7);
    });

    it('a manual run on an active connection does not rewrite it', async () => {
      const t = setup();
      await t.processor.process(job('manual'));
      expect(t.connections.markActive).not.toHaveBeenCalled();
    });

    it('a non-manual success never resets status', async () => {
      const t = setup(connectionRow({ status: 'active' }));
      await t.processor.process(job('incremental'));
      expect(t.connections.markActive).not.toHaveBeenCalled();
    });

    it('a manual partial run WITH fetched records (maybe schema-blocked, drift flip) does not touch the status', async () => {
      const t = setup(
        connectionRow({ status: 'error' }),
        run({ status: 'partial', fetchedCount: 5, insertedCount: 5 }),
      );
      await t.processor.process(job('manual'));
      expect(t.connections.markActive).not.toHaveBeenCalled();
    });

    it('a manual partial run without progress does not reset the error state', async () => {
      const t = setup(
        connectionRow({ status: 'error' }),
        run({ status: 'partial', fetchedCount: 0, insertedCount: 0 }),
      );
      await t.processor.process(job('manual'));
      expect(t.connections.markActive).not.toHaveBeenCalled();
    });
  });
});
