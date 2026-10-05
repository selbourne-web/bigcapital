import { DeleteCryptoConnectionService } from './DeleteCryptoConnection.service';
import { cryptoEvents } from '../CryptoExchanges.events';
import {
  FakeAudit,
  FakeEvents,
  FakeRepo,
  FakeUow,
  expectNoSecrets,
  fakeCls,
} from './testFakes';

const setup = () => {
  const repo = new FakeRepo();
  const uow = new FakeUow();
  const audit = new FakeAudit();
  const events = new FakeEvents();
  const service = new DeleteCryptoConnectionService(
    repo as any,
    uow as any,
    audit as any,
    events as any,
    fakeCls(),
  );
  return { repo, uow, audit, events, service };
};

describe('DeleteCryptoConnectionService', () => {
  it('archives the connection (credentials wiped, data kept) by default', async () => {
    const t = setup();
    const c = t.repo.seed({ accountId: 11, apiKeyEncrypted: 'ciphertext' });

    await t.service.execute(c.id);

    expect(t.repo.calls).toEqual([`archive@${t.uow.trxs[0].id}`]);
    const row = t.repo.rows.get(c.id);
    expect(row.apiKeyEncrypted).toBe('');
    expect(row.apiSecretEncrypted).toBe('');
    expect(row.accountId).toBeNull();
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(await t.repo.findById(c.id)).toBeUndefined();
  });

  it('hard deletes (cascading raw data) only when deleteData is true', async () => {
    const t = setup();
    const c = t.repo.seed({});

    await t.service.execute(c.id, { deleteData: true });

    expect(t.repo.calls).toEqual([`hardDelete@${t.uow.trxs[0].id}`]);
    expect(t.repo.rows.has(c.id)).toBe(false);
  });

  it('treats a non-true deleteData as false', async () => {
    const t = setup();
    const c = t.repo.seed({});
    await t.service.execute(c.id, { deleteData: 'yes' as any });
    expect(t.repo.calls[0]).toMatch(/^archive/);
  });

  it('audits (no secrets) and emits crypto.connection.deleted', async () => {
    const t = setup();
    const c = t.repo.seed({ apiKeyEncrypted: 'ciphertext' });

    await t.service.execute(c.id, { deleteData: true });

    expect(t.audit.rows[0]).toMatchObject({
      action: 'deleted',
      subject: 'CryptoExchange',
      subjectId: c.id,
      trx: t.uow.trxs[0],
    });
    expect(t.audit.rows[0].metadata).toEqual({
      exchange: 'kraken',
      label: 'Kraken - Trading',
      deleteData: true,
    });
    expect(t.events.emitted).toEqual([
      {
        name: cryptoEvents.connection.deleted,
        payload: { connectionId: c.id, organizationId: 7, trx: t.uow.trxs[0] },
      },
    ]);
    expect(cryptoEvents.connection.deleted).toBe('crypto.connection.deleted');
    expectNoSecrets(t.audit.rows);
    expect(JSON.stringify(t.audit.rows)).not.toContain('ciphertext');
  });

  it('404s for an unknown or already deleted connection', async () => {
    const t = setup();
    const c = t.repo.seed({ deletedAt: new Date() });
    await expect(t.service.execute(c.id)).rejects.toMatchObject({
      errorType: 'CRYPTO_CONNECTION_NOT_FOUND',
    });
  });

  it('rolls back when the audit row cannot be written', async () => {
    const t = setup();
    const c = t.repo.seed({});
    t.audit.failWith = new Error('audit down');
    await expect(t.service.execute(c.id)).rejects.toThrow('audit down');
    expect(t.uow.trxs[0].rolledBack).toBe(true);
  });
});
