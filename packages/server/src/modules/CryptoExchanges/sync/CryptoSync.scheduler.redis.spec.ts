import { randomBytes } from 'crypto';
import { Queue } from 'bullmq';
import { CryptoSyncScheduler } from './CryptoSync.scheduler';
import { cryptoScheduleId } from '../CryptoExchanges.constants';

/**
 * Regression for the self-heal loop: BullMQ 5.25.6's upsertJobScheduler always
 * overrides and, with no prevMillis, queues the next run for NOW and resets the
 * cadence. Runs the real BullMQ against the dev Redis; skipped unless
 * TEST_REDIS=1. Uses a throw-away Redis DB index and a unique key prefix, and
 * deletes only its own keys.
 */
const describeRedis = process.env.TEST_REDIS === '1' ? describe : describe.skip;

describeRedis('CryptoSyncScheduler against real BullMQ', () => {
  const prefix = `crypto-test-${randomBytes(6).toString('hex')}`;
  const connection = {
    host: process.env.REDIS_HOST || '::1',
    port: Number(process.env.REDIS_PORT) || 6379,
    db: Number(process.env.TEST_REDIS_DB) || 14,
  };
  const INTERVAL = 600_000;
  let kraken: Queue;
  let binance: Queue;
  let cryptoCom: Queue;
  let cryptoComApp: Queue;
  let scheduler: CryptoSyncScheduler;
  const conn = { id: 7, exchange: 'kraken' } as any;
  const schedulerId = cryptoScheduleId('42', 7);

  const nextRun = async () => {
    const client = await kraken.client;
    return client.zscore(`${prefix}:${kraken.name}:repeat`, schedulerId);
  };
  const pendingCount = async () => {
    const counts = await kraken.getJobCounts('wait', 'delayed', 'prioritized');
    return counts.wait + counts.delayed + counts.prioritized;
  };

  beforeAll(() => {
    kraken = new Queue('crypto-sync-kraken', { connection, prefix });
    binance = new Queue('crypto-sync-binance', { connection, prefix });
    cryptoCom = new Queue('crypto-sync-crypto_com', { connection, prefix });
    cryptoComApp = new Queue('crypto-sync-crypto_com_app', {
      connection,
      prefix,
    });
    scheduler = new CryptoSyncScheduler(
      kraken,
      binance,
      cryptoCom,
      cryptoComApp,
      {
        get: (key: string) =>
          key === 'crypto' ? { syncIntervalMs: INTERVAL } : undefined,
      } as any,
    );
  });

  afterAll(async () => {
    await kraken.obliterate({ force: true });
    await binance.obliterate({ force: true });
    await cryptoCom.obliterate({ force: true });
    await cryptoComApp.obliterate({ force: true });
    await kraken.close();
    await binance.close();
    await cryptoCom.close();
    await cryptoComApp.close();
  });

  it('creates the scheduler once, and repeated schedule() calls add no job and do not move the next run', async () => {
    await scheduler.schedule(conn, '42');
    expect(await nextRun()).not.toBeNull();
    expect(await pendingCount()).toBe(1);

    // Steady state, as the worker leaves it: next run one interval away.
    await kraken.upsertJobScheduler(
      schedulerId,
      { every: INTERVAL },
      { name: 'crypto-sync', data: {}, opts: { prevMillis: Date.now() } },
    );
    const next = Number(await nextRun());
    const pending = await pendingCount();
    expect(next).toBeGreaterThan(Date.now() + INTERVAL / 2);

    for (let i = 0; i < 5; i++) {
      await scheduler.schedule(conn, '42');
    }

    expect(await pendingCount()).toBe(pending);
    expect(Number(await nextRun())).toBe(next);
  });

  it('documents the BullMQ behaviour the guard avoids: a raw upsert pulls the next run to now (an immediate sync)', async () => {
    const steady = Number(await nextRun());
    await kraken.upsertJobScheduler(
      schedulerId,
      { every: INTERVAL },
      { name: 'crypto-sync', data: {} },
    );
    expect(Number(await nextRun())).toBeLessThan(steady - INTERVAL / 2);
  });

  it('removes the scheduler on unschedule and then schedules again', async () => {
    await scheduler.unschedule('42', 7);
    expect(await nextRun()).toBeNull();
    await scheduler.schedule(conn, '42');
    expect(await nextRun()).not.toBeNull();
  });
});
