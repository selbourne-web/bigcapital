import { ServiceError } from '@/modules/Items/ServiceError';
import { CRYPTO_CONNECTION_ERRORS as ERRORS } from '../CryptoExchanges.constants';
import {
  CRYPTO_MANUAL_SYNC_COOLDOWN_MS,
  CryptoManualSyncThrottledException,
  CryptoSyncRequestService,
} from './CryptoSyncRequest.service';

/** Minimal Redis with SET NX PX / PTTL / DEL on a controllable clock. */
class FakeRedis {
  now = 1_000_000;
  store = new Map<string, number>();
  async set(key: string, _v: string, _px: 'PX', ttl: number, _nx: 'NX') {
    const expires = this.store.get(key);
    if (expires !== undefined && expires > this.now) return null;
    this.store.set(key, this.now + ttl);
    return 'OK';
  }
  async pttl(key: string) {
    const expires = this.store.get(key);
    return expires === undefined || expires <= this.now
      ? -2
      : expires - this.now;
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

const connection = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  exchange: 'kraken',
  status: 'active',
  ...extra,
});

const setup = (
  found: Record<string, unknown> | null = connection(),
  organizationId: string | null = 'org-1',
) => {
  const redis = new FakeRedis();
  const scheduler = {
    schedule: jest.fn(async () => undefined),
    enqueue: jest.fn(async () => undefined),
  };
  const repo = { findById: jest.fn(async () => found ?? undefined) };
  const service = new CryptoSyncRequestService(
    repo as any,
    scheduler as any,
    { getOrThrow: () => redis } as any,
    { get: () => organizationId ?? undefined } as any,
  );
  return { service, redis, scheduler, repo };
};

describe('CryptoSyncRequestService.requestManualSync', () => {
  it('enqueues a manual job (never runs inline) and guards it with a per-tenant, per-connection Redis key', async () => {
    const { service, scheduler, redis } = setup();

    await service.requestManualSync(7);

    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    const [conn, org, kind, jobId] = (scheduler.enqueue as jest.Mock).mock
      .calls[0];
    expect(conn).toMatchObject({ id: 7, exchange: 'kraken' });
    expect(org).toBe('org-1');
    expect(kind).toBe('manual');
    expect(jobId).toMatch(/^crypto-sync-manual-7-[\w-]+$/);
    expect(jobId).not.toContain(':');
    expect([...redis.store.keys()]).toEqual(['crypto:manual-sync:org-1:7']);
    expect(redis.store.get('crypto:manual-sync:org-1:7')).toBe(
      redis.now + CRYPTO_MANUAL_SYNC_COOLDOWN_MS,
    );
  });

  it('answers a second request within 60 s with a throttle error carrying Retry-After seconds', async () => {
    const { service, scheduler, redis } = setup();
    await service.requestManualSync(7);
    redis.now += 12_500;

    const error = await service.requestManualSync(7).catch((e) => e);

    expect(error).toBeInstanceOf(CryptoManualSyncThrottledException);
    expect(error.getStatus()).toBe(429);
    expect(error.retryAfterSeconds).toBe(48); // ceil(47.5 s)
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts a new request once the 60 s window has passed, with a distinct job id', async () => {
    const { service, scheduler, redis } = setup();
    await service.requestManualSync(7);
    redis.now += CRYPTO_MANUAL_SYNC_COOLDOWN_MS + 1;

    await service.requestManualSync(7);

    const ids = (scheduler.enqueue as jest.Mock).mock.calls.map((c) => c[3]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps the throttle per connection', async () => {
    const { service, repo, scheduler } = setup();
    await service.requestManualSync(7);
    repo.findById.mockResolvedValueOnce(connection({ id: 8 }) as any);

    await service.requestManualSync(8);

    expect(scheduler.enqueue).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a missing or archived connection (repository hides archived rows)', async () => {
    const { service, scheduler, redis } = setup(null);

    const error = await service.requestManualSync(7).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.errorType).toBe(ERRORS.NOT_FOUND);
    expect(error.getStatus()).toBe(404);
    expect(scheduler.enqueue).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it('refuses a paused connection with 409 and does not spend the throttle', async () => {
    const { service, scheduler, redis } = setup(
      connection({ status: 'paused' }),
    );

    const error = await service.requestManualSync(7).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.errorType).toBe(ERRORS.CONNECTION_PAUSED);
    expect(error.getStatus()).toBe(409);
    expect(scheduler.enqueue).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it('allows a manual sync on an errored connection (a successful run reactivates it)', async () => {
    const { service, scheduler } = setup(connection({ status: 'error' }));

    await service.requestManualSync(7);

    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    // only active connections are (re)scheduled
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('releases the throttle when enqueueing fails so the user can retry', async () => {
    const { service, scheduler, redis } = setup();
    scheduler.enqueue.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.requestManualSync(7)).rejects.toThrow('redis down');
    expect(redis.store.size).toBe(0);

    await service.requestManualSync(7);
    expect(scheduler.enqueue).toHaveBeenCalledTimes(2);
  });

  it('re-registers the repeatable job of an active connection but survives a scheduler failure', async () => {
    const { service, scheduler } = setup();
    scheduler.schedule.mockRejectedValueOnce(new Error('boom'));

    await service.requestManualSync(7);

    expect(scheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      'org-1',
    );
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('CryptoSyncRequestService.selfHeal', () => {
  it('schedules active connections only', async () => {
    const { service, scheduler } = setup();

    await service.selfHeal([
      connection({ id: 1, status: 'active' }),
      connection({ id: 2, status: 'paused' }),
      connection({ id: 3, status: 'error' }),
      connection({ id: 4, status: 'active', exchange: 'binance' }),
    ] as any);

    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    expect(
      (scheduler.schedule as jest.Mock).mock.calls.map((c) => c[0].id),
    ).toEqual([1, 4]);
    expect((scheduler.schedule as jest.Mock).mock.calls[0][1]).toBe('org-1');
  });

  it('never rejects when the scheduler fails, keeps going, and logs no secrets', async () => {
    const { service, scheduler } = setup();
    scheduler.schedule.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(
      service.selfHeal([
        connection({ id: 1, apiKeyEncrypted: 'CIPHER-XYZ' }),
        connection({ id: 2 }),
      ] as any),
    ).resolves.toBeUndefined();

    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('1');
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).not.toContain('CIPHER-XYZ');
  });

  it('does nothing (no throw) when the tenant context has no organization id', async () => {
    const { service, scheduler } = setup(connection(), null);

    await expect(
      service.selfHeal([connection()] as any),
    ).resolves.toBeUndefined();

    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});
