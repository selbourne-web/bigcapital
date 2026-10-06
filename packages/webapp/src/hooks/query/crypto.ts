import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useAuthOrganizationId, useAuthToken } from '../state';

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
 * stored in storage, logged, or copied into an error object. Callers should
 * hold them in local form state only and may call `mutation.reset()` after
 * use so react-query does not retain `variables` on the mutation observer.
 */

export const CRYPTO_QUERY_KEYS = {
  all: ['crypto'] as const,
  connections: ['crypto', 'connections'] as const,
  balances: ['crypto', 'balances'] as const,
  syncRuns: (connectionId?: number, limit?: number) =>
    ['crypto', 'sync-runs', connectionId ?? null, limit ?? null] as const,
  syncRunsAll: ['crypto', 'sync-runs'] as const,
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure from the crypto API. Carries only status, a stable code, a
 * message and a few typed extras; never request bodies or credentials.
 * Codes include ATTESTATION_REQUIRED, KEY_HAS_EXTRA_PERMISSIONS,
 * EXCHANGE_AUTH_FAILED, CRYPTO_SYNC_THROTTLED, CRYPTO_CONNECTION_PAUSED,
 * CRYPTO_CONNECTION_IN_ERROR, NETWORK_ERROR, REQUEST_FAILED ...
 */
export class CryptoApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly permissions?: string[];
  readonly retryAfterSeconds?: number;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    permissions?: string[];
    retryAfterSeconds?: number;
  }) {
    super(init.message);
    this.name = 'CryptoApiError';
    this.status = init.status;
    this.code = init.code;
    this.permissions = init.permissions;
    this.retryAfterSeconds = init.retryAfterSeconds;
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
    retryAfterSeconds,
  });
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Auth = { token?: string | null; organizationId?: string | null };

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
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`/api/crypto${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
    throw parseCryptoError(
      response.status,
      payload,
      response.headers.get('Retry-After'),
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const useCryptoAuth = (): Auth => {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();
  return { token, organizationId };
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
    queryKey: CRYPTO_QUERY_KEYS.connections,
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
    queryKey: CRYPTO_QUERY_KEYS.balances,
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
    queryKey: CRYPTO_QUERY_KEYS.syncRuns(connectionId, limit),
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

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useInvalidateCrypto() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: CRYPTO_QUERY_KEYS.all });
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
      client.invalidateQueries({ queryKey: CRYPTO_QUERY_KEYS.syncRunsAll }),
  });
}
