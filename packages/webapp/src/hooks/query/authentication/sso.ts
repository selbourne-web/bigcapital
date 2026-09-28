import { useMutation } from '@tanstack/react-query';

/** Sends the browser to start "Sign in with Microsoft"; a full navigation. */
export const MICROSOFT_SSO_START_URL = '/api/auth/sso/microsoft/start';

export class SsoExchangeError extends Error {
  constructor(
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'SsoExchangeError';
  }
}

export interface SsoExchangeResult {
  accessToken: string;
  organizationId: string;
  tenantId: number;
  userId: number;
}

/**
 * Exchanges the one-time code from /auth/sso/callback?code=... for real
 * sign-in tokens. Same shape as a normal sign-in.
 */
export function useMicrosoftSsoExchange() {
  return useMutation<SsoExchangeResult, SsoExchangeError, { code: string }>({
    mutationFn: async ({ code }) => {
      let response: Response;
      try {
        response = await fetch('/api/auth/sso/microsoft/exchange', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ code }),
        });
      } catch {
        throw new SsoExchangeError(
          'SSO_REQUEST_FAILED',
          'That could not be sent. Check your connection and try again.',
        );
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = payload?.errors?.[0];
        throw new SsoExchangeError(
          error?.type ?? 'SSO_REQUEST_FAILED',
          error?.message ?? 'Sign-in with Microsoft did not work. Try again.',
        );
      }
      return {
        accessToken: payload.access_token,
        organizationId: payload.organization_id,
        tenantId: payload.tenant_id,
        userId: payload.user_id,
      };
    },
  });
}
