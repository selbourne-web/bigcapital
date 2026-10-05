import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CryptoConnection } from '../models/CryptoConnection';
import { CryptoSyncRun } from '../models/CryptoSyncRun';

export const CRYPTO_SYNC_RUNS_DEFAULT_LIMIT = 20;
export const CRYPTO_SYNC_RUNS_MAX_LIMIT = 100;

export interface CryptoSyncRunErrorView {
  code?: string;
  /** Already sanitized when stored: the adapter's userMessage, never raw exchange text. */
  message: string;
  retryable: boolean;
  at: string;
}

export interface CryptoSyncRunView {
  id: number;
  connectionId: number;
  kind: string;
  status: string;
  rangeFrom: Date | null;
  rangeTo: Date | null;
  fetchedCount: number;
  insertedCount: number;
  errors: CryptoSyncRunErrorView[] | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const parseErrors = (
  stored?: string | null,
): CryptoSyncRunErrorView[] | null => {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    // Allow-list: the stored entries also carry internals (error class, cursor).
    return parsed.map((e) => ({
      ...(e.code ? { code: String(e.code) } : {}),
      message: String(e.message ?? ''),
      retryable: e.retryable === true,
      at: String(e.at ?? ''),
    }));
  } catch {
    return null;
  }
};

export const toRunView = (run: CryptoSyncRun): CryptoSyncRunView => ({
  id: run.id,
  connectionId: run.connectionId,
  kind: run.kind,
  status: run.status,
  rangeFrom: run.rangeFrom ?? null,
  rangeTo: run.rangeTo ?? null,
  fetchedCount: run.fetchedCount,
  insertedCount: run.insertedCount,
  errors: parseErrors(run.errors),
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? null,
});

@Injectable()
export class GetCryptoSyncRunsService {
  constructor(
    @Inject(CryptoSyncRun.name)
    private readonly syncRunModel: TenantModelProxy<typeof CryptoSyncRun>,
    @Inject(CryptoConnection.name)
    private readonly connectionModel: TenantModelProxy<typeof CryptoConnection>,
  ) {}

  /** Newest runs first; runs of archived connections are hidden with them. */
  async execute(query: {
    connectionId?: number;
    limit?: number;
  }): Promise<CryptoSyncRunView[]> {
    const limit = Math.min(
      CRYPTO_SYNC_RUNS_MAX_LIMIT,
      Math.max(1, query.limit ?? CRYPTO_SYNC_RUNS_DEFAULT_LIMIT),
    );
    const builder = this.syncRunModel()
      .query()
      .whereIn(
        'connectionId',
        this.connectionModel().query().select('id').whereNull('deletedAt'),
      );
    if (query.connectionId != null) {
      builder.where('connectionId', query.connectionId);
    }
    const runs = await builder.orderBy('id', 'desc').limit(limit);
    return runs.map(toRunView);
  }
}
