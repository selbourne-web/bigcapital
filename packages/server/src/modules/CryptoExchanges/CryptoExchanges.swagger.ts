/**
 * Swagger examples of the crypto API. SUCCESS bodies are snake_case: the global
 * SerializeInterceptor converts every success response (pinned in
 * CryptoExchanges.wire.spec.ts). ERROR bodies written by the controller's
 * exception filter bypass that interceptor and are camelCase `{ code, message, ... }`
 * (ServiceError bodies keep the app-wide `{ errors: [...] }` shape).
 */
export const ERROR_NOTE =
  ' Error body is camelCase (written by the crypto exception filter, not converted).';

const connection = {
  id: 1,
  exchange: 'kraken',
  label: 'Kraken - Trading',
  status: 'active',
  mode: 'api',
  key_hint: '7731',
  account_id: 12,
  last_sync_at: '2026-10-05T10:00:00.000Z',
  last_error: null,
  created_at: '2026-10-01T09:00:00.000Z',
  key_expires_at: null,
  // present on the list response only
  history_coverage: { level: 'full' },
};

export const EXAMPLES = {
  connection,
  connections: [
    connection,
    {
      ...connection,
      id: 2,
      exchange: 'binance',
      label: 'Binance',
      account_id: null,
    },
  ],
  balances: {
    connections: [
      {
        connection_id: 1,
        account_id: 12,
        balances: [{ asset: 'BTC', free: '0.75000000', locked: '0.10000000' }],
        captured_at: '2026-10-05T10:00:00.000Z',
      },
      { connection_id: 2, account_id: null, balances: [], captured_at: null },
    ],
  },
  syncRuns: [
    {
      id: 4,
      connection_id: 1,
      kind: 'manual',
      status: 'failed',
      range_from: null,
      range_to: null,
      fetched_count: 10,
      inserted_count: 8,
      errors: [
        {
          code: 'AUTH',
          message: 'The exchange rejected this API key.',
          retryable: false,
          at: '2026-10-05T10:00:00.000Z',
        },
      ],
      started_at: '2026-10-05T10:00:00.000Z',
      finished_at: '2026-10-05T10:01:00.000Z',
    },
  ],
  queued: { queued: true },
  serviceError: (type: string, message: string, statusCode: number) => ({
    errors: [{ statusCode, type, message }],
  }),
  keyHasExtraPermissions: {
    code: 'KEY_HAS_EXTRA_PERMISSIONS',
    permissions: ['Create & Modify Orders', 'Withdraw Funds'],
    message:
      'This API key can do more than read data (for example trade or withdraw). Create a read-only key and try again.',
  },
  attestationRequired: {
    code: 'ATTESTATION_REQUIRED',
    permissions: ['fiat.deposit:write'],
    warnings: [],
  },
  exchangeAuth: {
    code: 'EXCHANGE_AUTH_FAILED',
    message:
      'The exchange rejected this API key. Check the key, secret and permissions.',
  },
  throttled: {
    code: 'CRYPTO_SYNC_THROTTLED',
    message: 'A sync was requested a moment ago. Try again shortly.',
    retryAfterSeconds: 48,
  },
};

/** `@ApiResponse` options with an example. */
export const res = (status: number, description: string, example: unknown) => ({
  status,
  description,
  schema: { example },
});
