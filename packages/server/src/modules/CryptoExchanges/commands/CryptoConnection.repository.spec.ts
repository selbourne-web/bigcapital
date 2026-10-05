import { CryptoConnectionRepository } from './CryptoConnection.repository';

describe('CryptoConnectionRepository.markActive', () => {
  const make = () => {
    const calls: any[] = [];
    const builder: any = {
      findById: (id: number) => (calls.push(['findById', id]), builder),
      whereNull: (c: string) => (calls.push(['whereNull', c]), builder),
      where: (c: string, v: any) => (calls.push(['where', c, v]), builder),
      patch: async (v: any) => (calls.push(['patch', v]), 1),
    };
    const repo = new CryptoConnectionRepository((() => ({
      query: () => builder,
    })) as any);
    return { repo, calls };
  };

  it('only flips an error, non-archived row, so it cannot override a pause or a drift flip', async () => {
    const { repo, calls } = make();
    await repo.markActive(7);
    expect(calls).toContainEqual(['whereNull', 'deletedAt']);
    expect(calls).toContainEqual(['where', 'status', 'error']);
    expect(calls).toContainEqual([
      'patch',
      { status: 'active', lastError: null },
    ]);
    const patchAt = calls.findIndex((c) => c[0] === 'patch');
    expect(calls.findIndex((c) => c[0] === 'where')).toBeLessThan(patchAt);
  });
});
