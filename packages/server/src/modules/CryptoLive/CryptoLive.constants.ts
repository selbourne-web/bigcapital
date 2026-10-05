import cryptoConfig from '../../common/config/crypto';

export const CRYPTO_LIVE_NAMESPACE = '/crypto';

/** Same engine path as the legacy gateway; only the namespace differs. */
export const CRYPTO_LIVE_PATH = '/socket';

/** Room every authenticated socket joins: public market prices, no tenant data. */
export const PRICES_ROOM = 'prices';

/**
 * Room of one tenant. The ONLY mapping from organization to room: the gateway
 * records `organizationId -> tenantId` at handshake (from the verified membership)
 * and the emitter targets `tenantRoom(tenantId)`.
 */
export const tenantRoom = (tenantId: number) => `tenant:${tenantId}`;

export const EVENTS = {
  PRICES_TICK: 'prices:tick',
  CONNECTION_SYNCED: 'crypto:connection-synced',
} as const;

/** Injection token for optional gateway tuning (tests inject clock, timers, limits). */
export const CRYPTO_LIVE_OPTIONS = 'CRYPTO_LIVE_OPTIONS';

export const MAX_SOCKETS_PER_USER = 10;
export const MAX_TOKEN_LENGTH = 4096;
export const MAX_ORGANIZATION_ID_LENGTH = 128;
/** socket.io `maxHttpBufferSize`; only effective when this gateway creates the shared Server. */
export const MAX_HTTP_BUFFER_SIZE = 10 * 1024;
export const DEFAULT_THROTTLE_MS = 1000;

/**
 * Browser origin allowed to open a socket: `crypto.allowedOrigin` config
 * (CRYPTO_ALLOWED_ORIGIN) or, by default, BASE_URL (the dev webapp reaches the API
 * through a proxy at BASE_URL). Empty means "no cross-origin browser".
 */
export const resolveAllowedOrigin = (
  env: NodeJS.ProcessEnv = process.env,
): string => env.CRYPTO_ALLOWED_ORIGIN || env.BASE_URL || '';

const normalizeOrigin = (value: string): string => {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
};

/**
 * CORS / Origin decision:
 *  - no Origin header -> allow (same-origin proxy, non-browser clients)
 *  - Origin equals the allowed origin -> allow
 *  - anything else -> deny; nothing configured (or `*`) -> deny every cross-origin request.
 */
export const isOriginAllowed = (
  origin: string | undefined,
  allowed: string,
): boolean => {
  if (!origin) return true;
  if (!allowed || allowed.trim() === '*') return false;
  return normalizeOrigin(origin) === normalizeOrigin(allowed);
};

/** `cors.origin` callback form: evaluated per request, never a wildcard. */
export const cryptoLiveCorsOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) => {
  const allowed = cryptoConfig().allowedOrigin || resolveAllowedOrigin();
  callback(null, isOriginAllowed(origin, allowed));
};
