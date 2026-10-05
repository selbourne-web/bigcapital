import { DeleteAccount } from './DeleteAccount.service';
import { ServiceError } from '../Items/ServiceError';
import { ERRORS } from './constants';

const makeService = (connection?: { id: number; label: string } | null) => {
  const deleted: number[] = [];
  const accountModel = () => ({
    query: () => ({
      findById: (id: number) => ({
        throwIfNotFound: async () => ({ id, predefined: false }),
        deleteIfNoRelations: async () => {
          deleted.push(id);
        },
      }),
      whereIn: () => ({ patch: async () => 0 }),
    }),
  });
  const connectionQueries: unknown[][] = [];
  const connectionModel = () => ({
    query: () => {
      const builder: any = {
        where: (...args: unknown[]) => {
          connectionQueries.push(args);
          return builder;
        },
        whereNull: (...args: unknown[]) => {
          connectionQueries.push(args);
          return builder;
        },
        first: async () => connection ?? undefined,
      };
      return builder;
    },
  });
  const uow = { withTransaction: async (work) => work({}) };
  const events = { emitAsync: jest.fn(async () => []) };
  const validator = { throwErrorIfAccountPredefined: jest.fn() };
  const service = new DeleteAccount(
    accountModel as any,
    events as any,
    uow as any,
    validator as any,
    connectionModel as any,
  );
  return { service, deleted, events, connectionQueries };
};

describe('DeleteAccount crypto connection guard', () => {
  it('blocks deleting an account mapped to a crypto connection with a friendly error', async () => {
    const { service, deleted, events, connectionQueries } = makeService({
      id: 3,
      label: 'Kraken - Trading',
    });

    const error = await service.deleteAccount(10).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.errorType).toBe(ERRORS.ACCOUNT_MAPPED_TO_CRYPTO_CONNECTION);
    expect(error.message).toBe(
      'This account is mapped to crypto connection Kraken - Trading',
    );
    expect(deleted).toEqual([]);
    expect(events.emitAsync).not.toHaveBeenCalled();
    // archived (soft-deleted) connections must not block
    expect(connectionQueries).toContainEqual(['deletedAt']);
    expect(connectionQueries).toContainEqual(['accountId', 10]);
  });

  it('deletes normally when no connection maps the account', async () => {
    const { service, deleted } = makeService(null);
    await service.deleteAccount(10);
    expect(deleted).toEqual([10]);
  });

  it('deletes normally when the crypto module is not registered', async () => {
    const service = new DeleteAccount(
      (() => ({
        query: () => ({
          findById: () => ({
            throwIfNotFound: async () => ({ id: 10 }),
            deleteIfNoRelations: async () => 1,
          }),
          whereIn: () => ({ patch: async () => 0 }),
        }),
      })) as any,
      { emitAsync: async () => [] } as any,
      { withTransaction: async (work) => work({}) } as any,
      { throwErrorIfAccountPredefined: () => undefined } as any,
      undefined,
    );
    await expect(service.deleteAccount(10)).resolves.toBeUndefined();
  });
});
