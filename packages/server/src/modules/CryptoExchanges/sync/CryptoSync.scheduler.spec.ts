import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { CryptoSyncScheduler } from './CryptoSync.scheduler';
import { CryptoSyncConnectionSubscriber } from './CryptoSync.subscriber';
import { cryptoEvents } from '../CryptoExchanges.events';
import {
  CRYPTO_SYNC_BINANCE_QUEUE,
  CRYPTO_SYNC_KRAKEN_QUEUE,
  queueNameFor,
} from '../CryptoExchanges.constants';

class FakeQueue {
  schedulers = new Map<string, any>();
  jobs: any[] = [];
  removedJobs: string[] = [];
  upsertJobScheduler = jest.fn(async (id: string, repeat: any, tpl: any) => {
    this.schedulers.set(id, { repeat, tpl });
  });
  removeJobScheduler = jest.fn(async (id: string) =>
    this.schedulers.delete(id),
  );
  add = jest.fn(async (name: string, data: any, opts: any) => {
    if (opts?.jobId && this.jobs.some((j) => j.opts?.jobId === opts.jobId)) {
      return; // BullMQ ignores a duplicate jobId
    }
    this.jobs.push({ name, data, opts });
  });
  states = new Map<string, string>();
  getJob = jest.fn(async (id: string) => {
    const idx = this.jobs.findIndex((j) => j.opts?.jobId === id);
    if (idx < 0) return undefined;
    return {
      id,
      getState: async () => this.states.get(id) ?? 'waiting',
      remove: async () => {
        if (this.removeFails) throw new Error('job is locked');
        this.jobs.splice(idx, 1);
      },
    };
  });
  removeFails = false;
  getJobs = jest.fn(async () =>
    this.jobs.map((j) => ({
      id: j.opts?.jobId,
      data: j.data,
      remove: async () => {
        this.removedJobs.push(j.opts?.jobId);
      },
    })),
  );
}

const config = (syncIntervalMs?: number) =>
  ({
    get: (key: string) => (key === 'crypto' ? { syncIntervalMs } : undefined),
  }) as any;

const makeScheduler = (interval?: number) => {
  const kraken = new FakeQueue();
  const binance = new FakeQueue();
  const scheduler = new CryptoSyncScheduler(
    kraken as any,
    binance as any,
    config(interval),
  );
  return { scheduler, kraken, binance };
};

describe('queue names', () => {
  it('maps each supported exchange to its queue', () => {
    expect(CRYPTO_SYNC_KRAKEN_QUEUE).toBe('crypto-sync-kraken');
    expect(CRYPTO_SYNC_BINANCE_QUEUE).toBe('crypto-sync-binance');
    expect(queueNameFor('kraken')).toBe('crypto-sync-kraken');
    expect(queueNameFor('binance')).toBe('crypto-sync-binance');
    expect(() => queueNameFor('nexo')).toThrow(/nexo/);
  });
});

describe('CryptoSyncScheduler', () => {
  it('registers a repeatable incremental job with the configured interval', async () => {
    const { scheduler, kraken, binance } = makeScheduler(120000);
    await scheduler.schedule({ id: 7, exchange: 'kraken' } as any, '42');

    expect(binance.upsertJobScheduler).not.toHaveBeenCalled();
    const [id, repeat, tpl] = kraken.upsertJobScheduler.mock.calls[0];
    expect(id).toBe('crypto-sync:7');
    expect(repeat).toEqual({ every: 120000 });
    expect(tpl.data).toEqual({
      connectionId: 7,
      organizationId: '42',
      kind: 'incremental',
    });
    expect(tpl.opts.attempts).toBe(5);
    expect(tpl.opts.backoff).toEqual({ type: 'exponential', delay: 30000 });
  });

  it('defaults to 300000 ms when no interval is configured', async () => {
    const { scheduler, binance } = makeScheduler(undefined);
    await scheduler.schedule({ id: 3, exchange: 'binance' } as any, '1');
    expect(binance.upsertJobScheduler.mock.calls[0][1]).toEqual({
      every: 300000,
    });
  });

  it('is idempotent: scheduling twice leaves one scheduler', async () => {
    const { scheduler, kraken } = makeScheduler();
    const conn = { id: 7, exchange: 'kraken' } as any;
    await scheduler.schedule(conn, '42');
    await scheduler.schedule(conn, '42');
    expect(kraken.schedulers.size).toBe(1);
  });

  it('unschedule removes the repeatable on both queues and the pending jobs of that connection only', async () => {
    const { scheduler, kraken, binance } = makeScheduler();
    await scheduler.schedule({ id: 7, exchange: 'kraken' } as any, '42');
    await scheduler.enqueue(
      { id: 7, exchange: 'kraken' } as any,
      '42',
      'initial',
      'crypto-sync-start-7-initial',
    );
    await scheduler.enqueue(
      { id: 8, exchange: 'kraken' } as any,
      '42',
      'initial',
      'crypto-sync-start-8-initial',
    );

    await scheduler.unschedule(7);
    await scheduler.unschedule(7); // idempotent

    expect(kraken.schedulers.has('crypto-sync:7')).toBe(false);
    expect(kraken.removeJobScheduler).toHaveBeenCalledWith('crypto-sync:7');
    expect(binance.removeJobScheduler).toHaveBeenCalledWith('crypto-sync:7');
    expect(kraken.removedJobs).toContain('crypto-sync-start-7-initial');
    expect(kraken.removedJobs).not.toContain('crypto-sync-start-8-initial');
  });

  it('a job that cannot be removed (running) does not make unschedule fail', async () => {
    const { scheduler, kraken } = makeScheduler();
    kraken.getJobs.mockResolvedValueOnce([
      {
        id: 'x',
        data: { connectionId: 7 },
        remove: async () => {
          throw new Error('job is locked');
        },
      },
    ] as any);
    await expect(scheduler.unschedule(7)).resolves.toBeUndefined();
  });

  describe('enqueue with an existing job of the same id', () => {
    const conn = { id: 7, exchange: 'kraken' } as any;
    const seed = async (state: string) => {
      const t = makeScheduler();
      await t.scheduler.enqueue(conn, '42', 'initial', 'job-1');
      t.kraken.states.set('job-1', state);
      return t;
    };

    it.each(['failed', 'completed'])(
      'replaces a %s job so a rotation really re-syncs',
      async (state) => {
        const { scheduler, kraken } = await seed(state);
        await scheduler.enqueue(conn, '42', 'initial', 'job-1');
        expect(kraken.jobs).toHaveLength(1);
        expect(kraken.add).toHaveBeenCalledTimes(2);
        expect(kraken.jobs[0].data.kind).toBe('initial');
      },
    );

    it.each(['waiting', 'active', 'delayed', 'something-else'])(
      'leaves a %s job alone (dedupe)',
      async (state) => {
        const { scheduler, kraken } = await seed(state);
        await scheduler.enqueue(conn, '42', 'initial', 'job-1');
        expect(kraken.add).toHaveBeenCalledTimes(1);
        expect(kraken.jobs).toHaveLength(1);
      },
    );

    it('does not throw when the finished job cannot be removed (it just became locked)', async () => {
      const { scheduler, kraken } = await seed('failed');
      kraken.removeFails = true;
      await expect(
        scheduler.enqueue(conn, '42', 'initial', 'job-1'),
      ).resolves.toBeUndefined();
      expect(kraken.jobs).toHaveLength(1);
    });
  });

  it('enqueue sets the retry policy and the payload without credentials', async () => {
    const { scheduler, kraken } = makeScheduler();
    await scheduler.enqueue(
      { id: 7, exchange: 'kraken' } as any,
      '42',
      'initial',
      'job-1',
    );
    const { data, opts } = kraken.jobs[0];
    expect(data).toEqual({
      connectionId: 7,
      organizationId: '42',
      kind: 'initial',
    });
    expect(opts.jobId).toBe('job-1');
    expect(opts.attempts).toBe(5);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 30000 });
  });
});

/** A transaction whose commit/rollback the test controls. */
const makeTrx = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const executionPromise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  executionPromise.catch(() => undefined);
  return {
    trx: { executionPromise } as any,
    commit: resolve,
    rollback: () => reject(new Error('rolled back')),
  };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

describe('CryptoSyncConnectionSubscriber', () => {
  const makeSubscriber = (conn: any) => {
    const scheduler = {
      schedule: jest.fn(async () => undefined),
      unschedule: jest.fn(async () => undefined),
      enqueue: jest.fn(async () => undefined),
    };
    const connections = {
      findById: jest.fn(async () => conn),
    };
    const subscriber = new CryptoSyncConnectionSubscriber(
      scheduler as any,
      connections as any,
    );
    return { subscriber, scheduler, connections };
  };
  const active = {
    id: 7,
    exchange: 'kraken',
    status: 'active',
    deletedAt: null,
    initialSyncCompletedAt: null,
  };

  it('created: enqueues one initial job and registers the repeatable only AFTER commit', async () => {
    const { subscriber, scheduler } = makeSubscriber(active);
    const { trx, commit } = makeTrx();
    await subscriber.onCreated({
      connectionId: 7,
      organizationId: 42,
      trx,
    } as any);
    await flush();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();

    commit();
    await flush();
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(
      active,
      '42',
      'initial',
      expect.any(String),
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(active, '42');
  });

  it('created: does nothing when the transaction rolled back', async () => {
    const { subscriber, scheduler, connections } = makeSubscriber(active);
    const { trx, rollback } = makeTrx();
    await subscriber.onCreated({
      connectionId: 7,
      organizationId: 42,
      trx,
    } as any);
    rollback();
    await flush();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(connections.findById).not.toHaveBeenCalled();
  });

  it('paused / deleted: remove the repeatable after commit, nothing on rollback', async () => {
    for (const handler of ['onPaused', 'onDeleted'] as const) {
      const { subscriber, scheduler } = makeSubscriber(null);
      const a = makeTrx();
      await subscriber[handler]({
        connectionId: 7,
        organizationId: 42,
        trx: a.trx,
      } as any);
      await flush();
      expect(scheduler.unschedule).not.toHaveBeenCalled();
      a.commit();
      await flush();
      expect(scheduler.unschedule).toHaveBeenCalledWith(7);

      const b = makeSubscriber(null);
      const t = makeTrx();
      await b.subscriber[handler]({
        connectionId: 7,
        organizationId: 42,
        trx: t.trx,
      } as any);
      t.rollback();
      await flush();
      expect(b.scheduler.unschedule).not.toHaveBeenCalled();
    }
  });

  it('resumed: (re)registers the repeatable after commit', async () => {
    const { subscriber, scheduler } = makeSubscriber(active);
    const { trx, commit } = makeTrx();
    await subscriber.onResumed({
      connectionId: 7,
      organizationId: 42,
      trx,
    } as any);
    expect(scheduler.schedule).not.toHaveBeenCalled();
    commit();
    await flush();
    expect(scheduler.schedule).toHaveBeenCalledWith(active, '42');
  });

  it('credentials-rotated: (re)registers the repeatable and enqueues a run (incremental once the initial sync is done)', async () => {
    const done = { ...active, initialSyncCompletedAt: new Date() };
    const { subscriber, scheduler } = makeSubscriber(done);
    const { trx, commit } = makeTrx();
    await subscriber.onCredentialsRotated({
      connectionId: 7,
      organizationId: 42,
      trx,
    } as any);
    commit();
    await flush();
    expect(scheduler.schedule).toHaveBeenCalledWith(done, '42');
    expect(scheduler.enqueue).toHaveBeenCalledWith(
      done,
      '42',
      'incremental',
      expect.any(String),
    );
  });

  it('start jobs use a fixed id so repeated events cannot flood the queue', async () => {
    const { subscriber, scheduler } = makeSubscriber(active);
    for (let i = 0; i < 2; i++) {
      const { trx, commit } = makeTrx();
      await subscriber.onCredentialsRotated({
        connectionId: 7,
        organizationId: 42,
        trx,
      } as any);
      commit();
      await flush();
    }
    const ids = scheduler.enqueue.mock.calls.map((c: any[]) => c[3]);
    expect(new Set(ids).size).toBe(1);
  });

  it('does not schedule a connection that is archived, paused, in error or missing', async () => {
    for (const conn of [
      undefined,
      { ...active, deletedAt: new Date() },
      { ...active, status: 'paused' },
      { ...active, status: 'error' },
    ]) {
      const { subscriber, scheduler } = makeSubscriber(conn);
      const { trx, commit } = makeTrx();
      await subscriber.onCreated({
        connectionId: 7,
        organizationId: 42,
        trx,
      } as any);
      commit();
      await flush();
      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(scheduler.enqueue).not.toHaveBeenCalled();
    }
  });

  it('a failure while scheduling is logged, never thrown out of the event loop', async () => {
    const { subscriber, scheduler } = makeSubscriber(active);
    scheduler.schedule.mockRejectedValue(new Error('redis down'));
    const { trx, commit } = makeTrx();
    await subscriber.onResumed({
      connectionId: 7,
      organizationId: 42,
      trx,
    } as any);
    commit();
    await expect(flush()).resolves.toBeUndefined();
  });

  it('listens to the five connection events', () => {
    const proto = CryptoSyncConnectionSubscriber.prototype;
    const listened = [
      proto.onCreated,
      proto.onPaused,
      proto.onResumed,
      proto.onDeleted,
      proto.onCredentialsRotated,
    ].map((fn) => Reflect.getMetadata(EVENT_LISTENER_METADATA, fn)[0].event);
    expect(listened.sort()).toEqual(
      Object.values(cryptoEvents.connection).sort(),
    );
  });
});
