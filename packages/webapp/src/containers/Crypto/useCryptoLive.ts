import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { markAllStale, setQuotes, type PriceQuote } from './priceStore';
import { CRYPTO_QUERY_KEYS } from '@/hooks/query/crypto';
import { useAuthOrganizationId, useAuthToken } from '@/hooks/state';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;

/**
 * Live crypto prices and sync notices over the `/crypto` socket namespace.
 *
 * MOUNT EXACTLY ONCE (for example in the crypto dashboard widget or a
 * provider): each mounted instance opens its own connection, and the server
 * caps connections per user.
 *
 * - Connects only while a token and an organization id exist; reconnects
 *   (new socket) when either changes; closes on unmount.
 * - `prices:tick` payloads (camelCase quote array) go to the priceStore; on
 *   disconnect every known price is marked stale (kept, not deleted) so the UI
 *   can show "reconnecting".
 * - `crypto:connection-synced` invalidates the crypto queries.
 * - Reconnect policy: socket.io's own reconnection (2s base, 30s max, jitter)
 *   covers network drops. The server's deliberate disconnects (JWT expiry) and
 *   handshake rejections (`connect_error`, e.g. `unauthorized`) are NOT retried
 *   by socket.io, so one timer retries them with exponential backoff
 *   (3s doubling up to 60s) using the current auth values. The backoff resets
 *   after a successful connect. The token is never logged.
 */
export function useCryptoLive(): void {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token || !organizationId) return undefined;

    const socket = io('/crypto', {
      path: '/socket',
      auth: { token, organizationId },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_MIN_MS;

    const scheduleManualRetry = () => {
      if (retryTimer !== undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!socket.active && !socket.connected) socket.connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    };

    socket.on('connect', () => {
      retryDelay = RETRY_MIN_MS;
    });
    socket.on('prices:tick', (quotes: unknown) => {
      if (Array.isArray(quotes)) setQuotes(quotes as PriceQuote[]);
    });
    socket.on('crypto:connection-synced', () => {
      queryClient.invalidateQueries({ queryKey: CRYPTO_QUERY_KEYS.all });
    });
    socket.on('disconnect', () => {
      markAllStale();
      // 'io server disconnect' (JWT expiry) is not auto-retried by socket.io.
      if (!socket.active) scheduleManualRetry();
    });
    socket.on('connect_error', () => {
      markAllStale();
      // Handshake rejected by the server: socket.io gives up, so back off here.
      if (!socket.active) scheduleManualRetry();
    });

    return () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socket.removeAllListeners();
      socket.close();
      markAllStale();
    };
  }, [token, organizationId, queryClient]);
}
