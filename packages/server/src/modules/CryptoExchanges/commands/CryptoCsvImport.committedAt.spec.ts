import { CryptoCsvImportRepository } from './CryptoCsvImport.repository';

/**
 * markCommitted writes committed_at from the app clock as
 * max(now, newest committed_at of the connection + 1ms). A tiny chainable
 * stand-in for the model query records the patch.
 */
const harness = (rows: Array<{ connectionId: number; committedAt: Date }>) => {
  const patches: any[] = [];
  const query = () => {
    let connectionId: number | undefined;
    let aggregate = false;
    const q: any = {
      select: () => q,
      findById: () => q,
      where: (_c: string, v: number) => ((connectionId = v), q),
      max: () => ((aggregate = true), q),
      first: () => q,
      patch: async (v: any) => patches.push(v),
      then: (res: any, rej: any) =>
        Promise.resolve(
          aggregate
            ? {
                newest:
                  rows
                    .filter((r) => r.connectionId === connectionId)
                    .map((r) => r.committedAt)
                    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
              }
            : { connectionId: 7 },
        ).then(res, rej),
    };
    return q;
  };
  const repo: any = new CryptoCsvImportRepository(
    (() => ({ query })) as any,
    (() => ({})) as any,
  );
  return { repo, patches };
};

describe('CryptoCsvImportRepository.markCommitted', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, 0, 0) + ms);

  it('uses the app clock when nothing is newer', async () => {
    const { repo, patches } = harness([]);
    repo.now = () => t(500);
    await repo.markCommitted(1, {}, {} as any);
    expect(patches[0].committedAt).toEqual(t(500));
    expect(patches[0]).toMatchObject({ status: 'committed', error: null });
  });

  it('two commits in the same millisecond are strictly increasing', async () => {
    const rows: any[] = [];
    const { repo, patches } = harness(rows);
    repo.now = () => t(500);
    await repo.markCommitted(1, {}, {} as any);
    rows.push({ connectionId: 7, committedAt: patches[0].committedAt });
    await repo.markCommitted(2, {}, {} as any);
    expect(patches[1].committedAt).toEqual(t(501));
  });

  it('a clock step back still orders after the previous commit', async () => {
    const { repo, patches } = harness([
      { connectionId: 7, committedAt: t(10_000) },
    ]);
    repo.now = () => t(0);
    await repo.markCommitted(1, {}, {} as any);
    expect(patches[0].committedAt).toEqual(t(10_001));
  });

  it('ignores other connections and keeps the clock when it is ahead', async () => {
    const { repo, patches } = harness([
      { connectionId: 8, committedAt: t(99_000) },
      { connectionId: 7, committedAt: t(100) },
    ]);
    repo.now = () => t(500);
    await repo.markCommitted(1, {}, {} as any);
    expect(patches[0].committedAt).toEqual(t(500));
  });
});
