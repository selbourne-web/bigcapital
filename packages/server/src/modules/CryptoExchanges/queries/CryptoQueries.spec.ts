import { FAKE_KEY, FAKE_SECRET, FAKE_PASSPHRASE } from '../commands/testFakes';
import { GetCryptoBalancesService } from './GetCryptoBalances.service';
import { GetCryptoConnectionsService } from './GetCryptoConnections.service';
import { GetCryptoSyncRunsService } from './GetCryptoSyncRuns.service';
import { AdapterRegistry } from '../adapters/AdapterRegistry';

type Call = [string, unknown[]];

/**
 * Chainable stand-in for an Objection query builder: every method returns the
 * builder, awaiting it yields `result`, and each call is recorded.
 */
const builder = (result: unknown, calls: Call[]) => {
  const proxy: any = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') {
          return (resolve: any, reject: any) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          calls.push([String(prop), args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
};

/** A model whose successive `query()` calls resolve to `results` in order. */
const fakeModel = (...results: unknown[]) => {
  const calls: Call[][] = [];
  const model = () => ({
    query: () => {
      const queryCalls: Call[] = [];
      calls.push(queryCalls);
      return builder(results[calls.length - 1], queryCalls);
    },
  });
  return { model: model as any, calls };
};

const names = (calls: Call[]) => calls.map(([n]) => n);

describe('GetCryptoConnectionsService', () => {
  const registry = {
    get: jest.fn(() => ({ historyCoverage: { level: 'partial', note: 'n' } })),
  };

  it('lists non-archived connections as allow-listed views without any secret or ciphertext', async () => {
    const row = {
      id: 3,
      exchange: 'kraken',
      label: 'Kraken - Trading',
      status: 'active',
      keyHint: '7731',
      accountId: 12,
      lastSyncAt: new Date('2026-10-05T10:00:00Z'),
      lastError: null,
      createdAt: new Date('2026-10-01T10:00:00Z'),
      keyExpiresAt: new Date('2027-01-05T00:00:00Z'),
      apiKeyEncrypted: `CIPHER-${FAKE_KEY}`,
      apiSecretEncrypted: `CIPHER-${FAKE_SECRET}`,
      passphraseEncrypted: `CIPHER-${FAKE_PASSPHRASE}`,
      syncCursor: 'opaque',
      keyVersion: 1,
    };
    const { model, calls } = fakeModel([row]);

    const views = await new GetCryptoConnectionsService(
      model,
      registry as any,
    ).execute();

    expect(views).toEqual([
      {
        id: 3,
        exchange: 'kraken',
        label: 'Kraken - Trading',
        status: 'active',
        mode: 'api',
        keyHint: '7731',
        accountId: 12,
        lastSyncAt: row.lastSyncAt,
        lastError: null,
        createdAt: row.createdAt,
        keyExpiresAt: new Date('2027-01-05T00:00:00Z'),
        historyCoverage: { level: 'partial', note: 'n' },
      },
    ]);
    expect(registry.get).toHaveBeenCalledWith('kraken');
    const json = JSON.stringify(views);
    for (const secret of [FAKE_KEY, FAKE_SECRET, FAKE_PASSPHRASE, 'CIPHER']) {
      expect(json).not.toContain(secret);
    }
    expect(calls[0]).toContainEqual(['whereNull', ['deletedAt']]);
  });

  it('lists a csv_only (nexo) row with historyCoverage null next to an api row, using the REAL adapter registry', async () => {
    const nexo = {
      id: 4,
      exchange: 'nexo',
      label: 'Nexo',
      status: 'active',
      mode: 'csv_only',
      keyHint: null,
      accountId: null,
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
    };
    const kraken = { id: 5, exchange: 'kraken', label: 'K', status: 'active' };
    const { model } = fakeModel([nexo, kraken]);

    const views = await new GetCryptoConnectionsService(
      model,
      new AdapterRegistry(),
    ).execute();

    expect(views[0]).toMatchObject({
      id: 4,
      exchange: 'nexo',
      mode: 'csv_only',
      historyCoverage: null,
    });
    expect(views[1]).toMatchObject({ id: 5, mode: 'api' });
    expect(views[1].historyCoverage).toEqual(
      new AdapterRegistry().get('kraken').historyCoverage,
    );
  });
});

describe('GetCryptoBalancesService', () => {
  const conn = (id: number, accountId: number | null) => ({
    id,
    accountId,
    status: 'active',
  });
  const snap = (
    id: number,
    connectionId: number,
    asset: string,
    free: string,
    locked: string,
    capturedAt: string,
  ) => ({
    id,
    connectionId,
    asset,
    free,
    locked,
    capturedAt: new Date(capturedAt),
  });

  const run = async (
    connections: any[],
    snapshots: any[],
    latestIds: any[],
  ) => {
    const connectionsModel = fakeModel(connections);
    const snapshotsModel = fakeModel(latestIds, snapshots);
    const service = new GetCryptoBalancesService(
      connectionsModel.model,
      snapshotsModel.model,
    );
    const view = await service.execute();
    return { view, connectionsModel, snapshotsModel };
  };

  it('returns the latest snapshot per (connection, asset), excluding zero rows, as decimal strings', async () => {
    const { view } = await run(
      [conn(1, 12)],
      [
        // older BTC row must lose to the newer one even if the query returned both
        snap(1, 1, 'BTC', '0.50000000', '0', '2026-10-05T09:00:00Z'),
        snap(5, 1, 'BTC', '0.75000000', '0.10000000', '2026-10-05T10:00:00Z'),
        snap(6, 1, 'ETH', '2.00000000', '0.00000000', '2026-10-05T10:00:00Z'),
        // asset gone: latest row is zero -> excluded
        snap(7, 1, 'DOGE', '0.00000000', '0.00000000', '2026-10-05T10:00:00Z'),
        snap(2, 1, 'DOGE', '100', '0', '2026-10-05T09:00:00Z'),
      ],
      [{ id: 5 }, { id: 6 }, { id: 7 }],
    );

    expect(view).toEqual({
      connections: [
        {
          connectionId: 1,
          accountId: 12,
          balances: [
            { asset: 'BTC', free: '0.75000000', locked: '0.10000000' },
            { asset: 'ETH', free: '2.00000000', locked: '0.00000000' },
          ],
          capturedAt: new Date('2026-10-05T10:00:00Z'),
        },
      ],
    });
  });

  it('returns an unmapped connection with accountId null and a connection without snapshots with empty balances', async () => {
    const { view } = await run(
      [conn(1, null), conn(2, 9)],
      [snap(1, 1, 'BTC', '1', '0', '2026-10-05T10:00:00Z')],
      [{ id: 1 }],
    );

    expect(view.connections[0]).toMatchObject({
      connectionId: 1,
      accountId: null,
      balances: [{ asset: 'BTC', free: '1', locked: '0' }],
    });
    expect(view.connections[1]).toEqual({
      connectionId: 2,
      accountId: 9,
      balances: [],
      capturedAt: null,
    });
  });

  it('queries only non-archived connections and only their latest snapshot ids (max id per connection+asset)', async () => {
    const { connectionsModel, snapshotsModel } = await run(
      [conn(1, 12), conn(2, null)],
      [],
      [{ id: 11 }, { id: 12 }],
    );

    expect(connectionsModel.calls[0]).toContainEqual([
      'whereNull',
      ['deletedAt'],
    ]);
    const latest = snapshotsModel.calls[0];
    expect(latest).toContainEqual(['whereIn', ['connectionId', [1, 2]]]);
    expect(latest).toContainEqual(['groupBy', ['connectionId', 'asset']]);
    expect(names(latest)).toContain('max');
    expect(snapshotsModel.calls[1]).toContainEqual([
      'whereIn',
      ['id', [11, 12]],
    ]);
  });

  it('does not touch the snapshot table when there are no connections', async () => {
    const { view, snapshotsModel } = await run([], [], []);

    expect(view).toEqual({ connections: [] });
    expect(snapshotsModel.calls).toHaveLength(0);
  });
});

describe('GetCryptoSyncRunsService', () => {
  const runRow = {
    id: 4,
    connectionId: 3,
    kind: 'manual',
    status: 'partial',
    rangeFrom: null,
    rangeTo: null,
    fetchedCount: 10,
    insertedCount: 8,
    errors: JSON.stringify([
      {
        name: 'ExchangeNetworkError',
        message: 'Could not reach the exchange.',
        retryable: true,
        at: '2026-10-05T10:00:00.000Z',
        code: 'X',
        cursor: 'internal-cursor',
      },
    ]),
    startedAt: new Date('2026-10-05T10:00:00Z'),
    finishedAt: new Date('2026-10-05T10:01:00Z'),
  };

  const make = (rows: unknown[]) => {
    const runs = fakeModel(rows);
    const conns = fakeModel([]);
    return {
      service: new GetCryptoSyncRunsService(runs.model, conns.model),
      runs,
      conns,
    };
  };

  it('defaults to 20 runs, newest first, restricted to non-archived connections', async () => {
    const { service, runs, conns } = make([runRow]);

    const result = await service.execute({});

    expect(runs.calls[0]).toContainEqual(['limit', [20]]);
    expect(runs.calls[0]).toContainEqual(['orderBy', ['id', 'desc']]);
    expect(names(runs.calls[0])).toContain('whereIn');
    expect(conns.calls[0]).toContainEqual(['whereNull', ['deletedAt']]);
    expect(result).toEqual([
      {
        id: 4,
        connectionId: 3,
        kind: 'manual',
        status: 'partial',
        rangeFrom: null,
        rangeTo: null,
        fetchedCount: 10,
        insertedCount: 8,
        errors: [
          {
            code: 'X',
            message: 'Could not reach the exchange.',
            retryable: true,
            at: '2026-10-05T10:00:00.000Z',
          },
        ],
        startedAt: runRow.startedAt,
        finishedAt: runRow.finishedAt,
      },
    ]);
  });

  it('caps the limit at 100 and filters by connection id', async () => {
    const { service, runs } = make([]);

    await service.execute({ connectionId: 3, limit: 5000 });

    expect(runs.calls[0]).toContainEqual(['limit', [100]]);
    expect(runs.calls[0]).toContainEqual(['where', ['connectionId', 3]]);
  });

  it('raises a limit below 1 to 1 and tolerates unparsable stored errors', async () => {
    const { service, runs } = make([{ ...runRow, errors: 'not json' }]);

    const result = await service.execute({ limit: 0 });

    expect(runs.calls[0]).toContainEqual(['limit', [1]]);
    expect(result[0].errors).toBeNull();
  });
});
