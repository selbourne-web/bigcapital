import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { getCookie } from '../../utils';
import { useAuthOrganizationId, useAuthToken } from '../state';
import { useApiFetcherOnError } from '../useApiFetcherOnError';
import { accountsKeys } from './accounts/query-keys';

/*
 * Crypto exchange connections: raw-fetch hooks.
 *
 * Wire format (verified in the server's CryptoExchanges.wire.spec.ts and the
 * Task 9 report): success bodies are snake_case (global SerializeInterceptor)
 * and are mapped by hand below; request bodies accept camelCase (the
 * interceptor camelizes input), so requests are sent in camelCase; error
 * bodies are camelCase and come in two shapes (see `parseCryptoError`).
 *
 * SECRETS: apiKey / apiSecret / passphrase are only ever function arguments
 * of the create / rotate mutations. They are never part of a query key, never
 * written to the react-query cache (responses never contain them), never
 * stored in storage, logged, or copied into an error object. The create and
 * rotate mutations use `gcTime: 0` so react-query drops the mutation (and its
 * `variables`) as soon as it has no observers. Callers should hold secrets in
 * local form state only and may also call `mutation.reset()` after use.
 *
 * 401 responses go through the app's `useApiFetcherOnError` (session expired
 * + logout), exactly like the SDK fetcher hooks; `CryptoApiError.status` is
 * also exposed for callers.
 */

export const CRYPTO_QUERY_KEYS = {
  all: ['crypto'] as const,
  // Keys carry the organization id so cached data never leaks across orgs.
  connections: (org?: string | null) =>
    ['crypto', org ?? null, 'connections'] as const,
  balances: (org?: string | null) =>
    ['crypto', org ?? null, 'balances'] as const,
  syncRuns: (org?: string | null, connectionId?: number, limit?: number) =>
    [
      'crypto',
      org ?? null,
      'sync-runs',
      connectionId ?? null,
      limit ?? null,
    ] as const,
  syncRunsAll: (org?: string | null) =>
    ['crypto', org ?? null, 'sync-runs'] as const,
  csvImports: (org?: string | null, connectionId?: number) =>
    ['crypto', org ?? null, 'csv-imports', connectionId ?? null] as const,
  csvImportsAll: (org?: string | null) =>
    ['crypto', org ?? null, 'csv-imports'] as const,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CryptoConnectionStatus = 'active' | 'paused' | 'error' | string;

export interface CryptoConnection {
  id: number;
  exchange: string;
  label: string;
  status: CryptoConnectionStatus;
  /** Last characters of the API key, for recognition only. */
  keyHint: string;
  accountId: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** ISO time the exchange says this key expires (e.g. Crypto.com App keys), or null. */
  keyExpiresAt: string | null;
  /** How much history the exchange API can return. */
  historyCoverage: CryptoHistoryCoverage;
}

export interface CryptoHistoryCoverage {
  level: 'full' | 'partial';
  note?: string;
}

export interface CryptoBalanceItem {
  asset: string;
  /** Decimal string. */
  free: string;
  /** Decimal string. */
  locked: string;
}

export interface CryptoConnectionBalances {
  connectionId: number;
  accountId: number | null;
  balances: CryptoBalanceItem[];
  capturedAt: string | null;
}

export interface CryptoBalancesResponse {
  connections: CryptoConnectionBalances[];
}

export interface CryptoSyncRunError {
  code?: string;
  message: string;
  retryable: boolean;
  at: string;
}

export interface CryptoSyncRun {
  id: number;
  connectionId: number;
  kind: string;
  status: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  fetchedCount: number;
  insertedCount: number;
  errors: CryptoSyncRunError[] | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type CryptoCsvImportStatus =
  | 'previewed'
  | 'committed'
  | 'rolled_back'
  | 'failed'
  | string;

/** One row of a connection's CSV import history. */
export interface CryptoCsvImport {
  id: number;
  connectionId: number;
  reportType: string;
  filename: string;
  rowCount: number;
  rowsImported: number;
  rowsSkippedDuplicate: number;
  rowsRejected: number;
  dateFrom: string | null;
  dateTo: string | null;
  status: CryptoCsvImportStatus;
  createdAt: string;
  committedAt: string | null;
}

/** What importing a CSV would do; nothing is stored until it is committed. */
export interface CryptoCsvPreview {
  importId: number;
  connectionId: number;
  exchange: string;
  reportType: string;
  filename: string;
  rowCount: number;
  /** Rows that would be written now. */
  importable: number;
  alreadyImported: number;
  rejectedCount: number;
  /** First rejected rows only (line number and reason, never cell contents). */
  rejected: Array<{ line: number; reason: string }>;
  byType: Record<string, number>;
  dateFrom: string | null;
  dateTo: string | null;
  /** API trade records already stored inside the file's date range. */
  apiOverlap: number;
}

export interface PreviewCryptoCsvInput {
  connectionId: number;
  file: File;
}

export interface CommitCryptoCsvInput {
  importId: number;
  /** Must be the very file that was previewed. */
  file: File;
}

export interface RollbackCryptoCsvInput {
  importId: number;
}

export interface CreateCryptoConnectionInput {
  exchange: string;
  label: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  accountId?: number;
  createAccount?: boolean;
  attestReadOnly?: boolean;
}

export interface UpdateCryptoConnectionInput {
  id: number;
  label?: string;
  status?: 'active' | 'paused';
  accountId?: number | null;
}

export interface RotateCryptoCredentialsInput {
  id: number;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  attestReadOnly?: boolean;
}

export interface DeleteCryptoConnectionInput {
  id: number;
  deleteData?: boolean;
}

// ---------------------------------------------------------------------------
// Mappers (one per shape; pure)
// ---------------------------------------------------------------------------

type Raw = Record<string, any>;

const mapHistoryCoverage = (
  raw: Raw | null | undefined,
): CryptoHistoryCoverage =>
  raw && raw.level === 'partial'
    ? {
        level: 'partial',
        ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
      }
    : { level: 'full' };

export const mapCryptoConnection = (raw: Raw): CryptoConnection => ({
  id: Number(raw.id),
  exchange: String(raw.exchange ?? ''),
  label: String(raw.label ?? ''),
  status: raw.status,
  keyHint: String(raw.key_hint ?? ''),
  accountId: raw.account_id ?? null,
  lastSyncAt: raw.last_sync_at ?? null,
  lastError: raw.last_error ?? null,
  createdAt: raw.created_at,
  keyExpiresAt: raw.key_expires_at ?? null,
  historyCoverage: mapHistoryCoverage(raw.history_coverage),
});

export const mapCryptoBalances = (raw: Raw): CryptoBalancesResponse => ({
  connections: ((raw?.connections ?? []) as Raw[]).map((c) => ({
    connectionId: Number(c.connection_id),
    accountId: c.account_id ?? null,
    balances: ((c.balances ?? []) as Raw[]).map((b) => ({
      asset: String(b.asset),
      free: String(b.free ?? '0'),
      locked: String(b.locked ?? '0'),
    })),
    capturedAt: c.captured_at ?? null,
  })),
});

export const mapCryptoSyncRun = (raw: Raw): CryptoSyncRun => ({
  id: Number(raw.id),
  connectionId: Number(raw.connection_id),
  kind: raw.kind,
  status: raw.status,
  rangeFrom: raw.range_from ?? null,
  rangeTo: raw.range_to ?? null,
  fetchedCount: Number(raw.fetched_count ?? 0),
  insertedCount: Number(raw.inserted_count ?? 0),
  errors: Array.isArray(raw.errors)
    ? (raw.errors as Raw[]).map((e) => ({
        ...(e.code ? { code: String(e.code) } : {}),
        message: String(e.message ?? ''),
        retryable: !!e.retryable,
        at: e.at,
      }))
    : null,
  startedAt: raw.started_at ?? null,
  finishedAt: raw.finished_at ?? null,
});

export const mapCryptoCsvImport = (raw: Raw): CryptoCsvImport => ({
  id: Number(raw.id),
  connectionId: Number(raw.connection_id),
  reportType: String(raw.report_type ?? ''),
  filename: String(raw.filename ?? ''),
  rowCount: Number(raw.row_count ?? 0),
  rowsImported: Number(raw.rows_imported ?? 0),
  rowsSkippedDuplicate: Number(raw.rows_skipped_duplicate ?? 0),
  rowsRejected: Number(raw.rows_rejected ?? 0),
  dateFrom: raw.date_from ?? null,
  dateTo: raw.date_to ?? null,
  status: raw.status,
  createdAt: raw.created_at,
  committedAt: raw.committed_at ?? null,
});

export const mapCryptoCsvPreview = (raw: Raw): CryptoCsvPreview => ({
  importId: Number(raw.import_id),
  connectionId: Number(raw.connection_id),
  exchange: String(raw.exchange ?? ''),
  reportType: String(raw.report_type ?? ''),
  filename: String(raw.filename ?? ''),
  rowCount: Number(raw.row_count ?? 0),
  importable: Number(raw.importable ?? 0),
  alreadyImported: Number(raw.already_imported ?? 0),
  rejectedCount: Number(raw.rejected_count ?? 0),
  rejected: ((raw.rejected ?? []) as Raw[]).map((r) => ({
    line: Number(r.line),
    reason: String(r.reason ?? ''),
  })),
  byType: Object.fromEntries(
    Object.entries((raw.by_type ?? {}) as Raw).map(([k, v]) => [k, Number(v)]),
  ),
  dateFrom: raw.date_from ?? null,
  dateTo: raw.date_to ?? null,
  apiOverlap: Number(raw.api_overlap ?? 0),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure from the crypto API. Carries only status, a stable code, a
 * message and a few typed extras; never request bodies or credentials.
 * ATTESTATION_REQUIRED also carries `permissions` and `warnings` (no secrets).
 * Codes include ATTESTATION_REQUIRED, KEY_HAS_EXTRA_PERMISSIONS,
 * EXCHANGE_AUTH_FAILED, CRYPTO_SYNC_THROTTLED, CRYPTO_CONNECTION_PAUSED,
 * CRYPTO_CONNECTION_IN_ERROR, NETWORK_ERROR, REQUEST_FAILED ...
 */
export class CryptoApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly permissions?: string[];
  readonly warnings?: string[];
  readonly retryAfterSeconds?: number;
  /** CSV_NOT_ROLLBACKABLE: later imports that must be rolled back first. */
  readonly dependentImportIds?: number[];

  constructor(init: {
    status: number;
    code: string;
    message: string;
    permissions?: string[];
    warnings?: string[];
    retryAfterSeconds?: number;
    dependentImportIds?: number[];
  }) {
    super(init.message);
    this.name = 'CryptoApiError';
    this.status = init.status;
    this.code = init.code;
    this.permissions = init.permissions;
    this.warnings = init.warnings;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.dependentImportIds = init.dependentImportIds;
  }
}

const DEFAULT_ERROR_MESSAGE =
  'The request could not be completed. Please try again.';

/**
 * Builds a CryptoApiError from a response status, parsed body (any shape) and
 * the Retry-After header. Handles the flat camelCase filter shape
 * `{code, message, permissions?, retryAfterSeconds?}`, the ServiceError shape
 * `{errors:[{statusCode,type,message}]}`, and class-validator bodies.
 */
export const parseCryptoError = (
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): CryptoApiError => {
  const b = (body && typeof body === 'object' ? body : {}) as Raw;
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined;

  const code: string =
    (typeof b.code === 'string' && b.code) ||
    (typeof first?.type === 'string' && first.type) ||
    'REQUEST_FAILED';

  let message: string = DEFAULT_ERROR_MESSAGE;
  if (typeof b.message === 'string' && b.message) message = b.message;
  else if (Array.isArray(b.message) && typeof b.message[0] === 'string')
    message = b.message[0];
  else if (typeof first?.message === 'string' && first.message)
    message = first.message;

  const permissions = Array.isArray(b.permissions)
    ? b.permissions.filter((p: unknown): p is string => typeof p === 'string')
    : undefined;

  const warnings = Array.isArray(b.warnings)
    ? b.warnings.filter((w: unknown): w is string => typeof w === 'string')
    : undefined;

  // Error bodies bypass the serializer: camelCase on the wire.
  const dependentRaw = b.dependentImportIds ?? b.dependent_import_ids;
  const dependentImportIds = Array.isArray(dependentRaw)
    ? dependentRaw.filter(
        (id: unknown): id is number =>
          typeof id === 'number' && Number.isFinite(id),
      )
    : undefined;

  let retryAfterSeconds: number | undefined;
  if (typeof b.retryAfterSeconds === 'number') {
    retryAfterSeconds = b.retryAfterSeconds;
  } else if (retryAfterHeader && Number.isFinite(Number(retryAfterHeader))) {
    retryAfterSeconds = Number(retryAfterHeader);
  }

  return new CryptoApiError({
    status,
    code,
    message,
    permissions,
    warnings,
    retryAfterSeconds,
    dependentImportIds,
  });
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Auth = {
  token?: string | null;
  organizationId?: string | null;
  onError?: (error: unknown) => void;
};

async function cryptoRequest(
  auth: Auth,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.organizationId)
    headers['organization-id'] = String(auth.organizationId);
  const locale = getCookie('locale');
  if (locale) headers['Accept-Language'] = locale;
  // FormData: the browser sets the multipart content-type (with boundary).
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`/api/crypto${path}`, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : isForm
            ? (body as FormData)
            : JSON.stringify(body),
    });
  } catch {
    // Deliberately no cause: the request body may hold credentials.
    throw new CryptoApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'The server could not be reached. Check your connection.',
    });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      auth.onError?.({ status: 401, data: payload });
    }
    throw parseCryptoError(
      response.status,
      payload,
      response.headers.get('Retry-After'),
    );
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new CryptoApiError({
      status: response.status,
      code: 'INVALID_RESPONSE',
      message: 'The server sent an unexpected response. Please try again.',
    });
  }
}

const useCryptoAuth = (): Auth => {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();
  const onError = useApiFetcherOnError();
  return { token, organizationId, onError };
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type QueryOptions<T> = Omit<
  UseQueryOptions<T, CryptoApiError>,
  'queryKey' | 'queryFn'
>;

export function useCryptoConnections(
  options?: QueryOptions<CryptoConnection[]>,
) {
  const auth = useCryptoAuth();
  return useQuery<CryptoConnection[], CryptoApiError>({
    ...options,
    queryKey: CRYPTO_QUERY_KEYS.connections(auth.organizationId),
    queryFn: async () =>
      ((await cryptoRequest(auth, 'GET', '/connections')) as Raw[]).map(
        mapCryptoConnection,
      ),
  });
}

export function useCryptoBalances(
  options?: QueryOptions<CryptoBalancesResponse>,
) {
  const auth = useCryptoAuth();
  return useQuery<CryptoBalancesResponse, CryptoApiError>({
    ...options,
    queryKey: CRYPTO_QUERY_KEYS.balances(auth.organizationId),
    queryFn: async () =>
      mapCryptoBalances(await cryptoRequest(auth, 'GET', '/balances')),
  });
}

export function useCryptoSyncRuns(
  connectionId?: number,
  limit?: number,
  options?: QueryOptions<CryptoSyncRun[]>,
) {
  const auth = useCryptoAuth();
  return useQuery<CryptoSyncRun[], CryptoApiError>({
    ...options,
    queryKey: CRYPTO_QUERY_KEYS.syncRuns(
      auth.organizationId,
      connectionId,
      limit,
    ),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (connectionId !== undefined)
        params.set('connectionId', String(connectionId));
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      return (
        (await cryptoRequest(
          auth,
          'GET',
          `/sync-runs${qs ? `?${qs}` : ''}`,
        )) as Raw[]
      ).map(mapCryptoSyncRun);
    },
  });
}

export function useCryptoCsvImports(
  connectionId: number,
  options?: QueryOptions<CryptoCsvImport[]>,
) {
  const auth = useCryptoAuth();
  return useQuery<CryptoCsvImport[], CryptoApiError>({
    ...options,
    queryKey: CRYPTO_QUERY_KEYS.csvImports(auth.organizationId, connectionId),
    queryFn: async () =>
      (
        (await cryptoRequest(
          auth,
          'GET',
          `/connections/${connectionId}/imports`,
        )) as Raw[]
      ).map(mapCryptoCsvImport),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useInvalidateCrypto() {
  const client = useQueryClient();
  // A connection change can create or re-map Chart-of-Accounts accounts
  // server-side, so the accounts list must be refetched too.
  return () => {
    client.invalidateQueries({ queryKey: CRYPTO_QUERY_KEYS.all });
    client.invalidateQueries({ queryKey: accountsKeys.all() });
  };
}

/**
 * Creates a connection. A first attempt without `attestReadOnly` may fail with
 * `CryptoApiError.code === 'ATTESTATION_REQUIRED'`; the form then shows the
 * attestation checkbox and resubmits with `attestReadOnly: true`.
 * `KEY_HAS_EXTRA_PERMISSIONS` carries `permissions`.
 */
export function useCreateCryptoConnection() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCrypto();
  return useMutation<
    CryptoConnection,
    CryptoApiError,
    CreateCryptoConnectionInput
  >({
    mutationFn: async (input) =>
      mapCryptoConnection(
        await cryptoRequest(auth, 'POST', '/connections', input),
      ),
    gcTime: 0, // never retain secret variables
    onSuccess: invalidate,
  });
}

export function useUpdateCryptoConnection() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCrypto();
  return useMutation<
    CryptoConnection,
    CryptoApiError,
    UpdateCryptoConnectionInput
  >({
    mutationFn: async ({ id, ...patch }) =>
      mapCryptoConnection(
        await cryptoRequest(auth, 'PATCH', `/connections/${id}`, patch),
      ),
    onSuccess: invalidate,
  });
}

export function useRotateCryptoCredentials() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCrypto();
  return useMutation<
    CryptoConnection,
    CryptoApiError,
    RotateCryptoCredentialsInput
  >({
    mutationFn: async ({ id, ...credentials }) =>
      mapCryptoConnection(
        await cryptoRequest(
          auth,
          'POST',
          `/connections/${id}/credentials`,
          credentials,
        ),
      ),
    gcTime: 0, // never retain secret variables
    onSuccess: invalidate,
  });
}

export function useDeleteCryptoConnection() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCrypto();
  return useMutation<void, CryptoApiError, DeleteCryptoConnectionInput>({
    mutationFn: async ({ id, deleteData }) => {
      await cryptoRequest(
        auth,
        'DELETE',
        `/connections/${id}${deleteData ? '?deleteData=true' : ''}`,
      );
    },
    onSuccess: invalidate,
  });
}

/**
 * Queues a manual sync (202 `{queued:true}`). A 429 surfaces as
 * `CryptoApiError` with `retryAfterSeconds`; 409 codes
 * CRYPTO_CONNECTION_PAUSED / CRYPTO_CONNECTION_IN_ERROR for blocked states.
 */
export function useSyncCryptoConnection() {
  const auth = useCryptoAuth();
  const client = useQueryClient();
  return useMutation<{ queued: boolean }, CryptoApiError, number>({
    mutationFn: async (id) => {
      const res = await cryptoRequest(auth, 'POST', `/connections/${id}/sync`);
      return { queued: !!res?.queued };
    },
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: CRYPTO_QUERY_KEYS.syncRunsAll(auth.organizationId),
      }),
  });
}

// ---------------------------------------------------------------------------
// CSV import (preview -> commit -> optional rollback)
// ---------------------------------------------------------------------------

const csvForm = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return form;
};

/** Refetch what a committed or rolled-back import changes. */
function useInvalidateCsvImport() {
  const client = useQueryClient();
  const { organizationId } = useCryptoAuth();
  return () => {
    client.invalidateQueries({
      queryKey: CRYPTO_QUERY_KEYS.csvImportsAll(organizationId),
    });
    client.invalidateQueries({
      queryKey: CRYPTO_QUERY_KEYS.balances(organizationId),
    });
    client.invalidateQueries({
      queryKey: CRYPTO_QUERY_KEYS.connections(organizationId),
    });
  };
}

/** Uploads the file and returns what importing it would do. Stores nothing. */
export function usePreviewCryptoCsv() {
  const auth = useCryptoAuth();
  const client = useQueryClient();
  return useMutation<CryptoCsvPreview, CryptoApiError, PreviewCryptoCsvInput>({
    mutationFn: async ({ connectionId, file }) =>
      mapCryptoCsvPreview(
        await cryptoRequest(
          auth,
          'POST',
          `/connections/${connectionId}/imports`,
          csvForm(file),
        ),
      ),
    gcTime: 0,
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: CRYPTO_QUERY_KEYS.csvImportsAll(auth.organizationId),
      }),
  });
}

/** Commits a previewed import by re-sending the same file. */
export function useCommitCryptoCsv() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCsvImport();
  return useMutation<CryptoCsvImport, CryptoApiError, CommitCryptoCsvInput>({
    mutationFn: async ({ importId, file }) =>
      mapCryptoCsvImport(
        await cryptoRequest(
          auth,
          'POST',
          `/imports/${importId}/commit`,
          csvForm(file),
        ),
      ),
    gcTime: 0,
    onSuccess: invalidate,
  });
}

/** Rolls back a committed import. 409 CSV_NOT_ROLLBACKABLE carries `dependentImportIds`. */
export function useRollbackCryptoCsv() {
  const auth = useCryptoAuth();
  const invalidate = useInvalidateCsvImport();
  return useMutation<CryptoCsvImport, CryptoApiError, RollbackCryptoCsvInput>({
    mutationFn: async ({ importId }) =>
      mapCryptoCsvImport(
        await cryptoRequest(auth, 'DELETE', `/imports/${importId}`),
      ),
    onSuccess: invalidate,
    // A refused rollback may mean the list is stale.
    onError: invalidate,
  });
}
