import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthToken } from '../../state';
import { authenticationKeys } from './query-keys';

/** A failure the person can act on; `type` is the server's error type. */
export class MfaError extends Error {
  constructor(
    public readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'MfaError';
  }
}

const request = async (
  path: string,
  token: string | null | undefined,
  body?: Record<string, unknown>,
) => {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`/api/auth/mfa/${path}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new MfaError(
      'MFA_REQUEST_FAILED',
      'That could not be sent. Check your connection and try again.',
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.errors?.[0];
    throw new MfaError(
      error?.type ?? 'MFA_REQUEST_FAILED',
      error?.message ?? 'That did not work. Please try again.',
    );
  }
  return payload;
};

export interface MfaSetupResult {
  secret: string;
  otpauthUrl: string;
}

/** Starts two-factor setup: a fresh secret, not active until confirmed. */
export function useMfaSetup() {
  const token = useAuthToken();

  return useMutation<MfaSetupResult, MfaError, void>({
    mutationFn: async () => {
      const data = await request('setup', token);
      return { secret: data.secret, otpauthUrl: data.otpauth_url };
    },
  });
}

/** Confirms setup with a code; returns one-time recovery codes. */
export function useMfaEnable() {
  const token = useAuthToken();
  const queryClient = useQueryClient();

  return useMutation<string[], MfaError, { token: string }>({
    mutationFn: async ({ token: code }) => {
      const data = await request('enable', token, { token: code });
      return data.recovery_codes ?? [];
    },
    // The signed-in account (and its `mfaEnabled` flag) is cached under
    // authenticationKeys.account() - without this, the Security page keeps
    // showing "Set up two-factor authentication" on every revisit until
    // that stale cache happens to be refetched some other way.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authenticationKeys.account() });
    },
  });
}

/** Turns two-factor authentication off (requires a currently valid code). */
export function useMfaDisable() {
  const token = useAuthToken();
  const queryClient = useQueryClient();

  return useMutation<void, MfaError, { token: string }>({
    mutationFn: async ({ token: code }) => {
      await request('disable', token, { token: code });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authenticationKeys.account() });
    },
  });
}

export interface MfaVerifyLoginResult {
  accessToken: string;
  organizationId: string;
  tenantId: number;
  userId: number;
}

/** Finishes a sign-in that was held for two-factor authentication. */
export function useMfaVerifyLogin() {
  return useMutation<
    MfaVerifyLoginResult,
    MfaError,
    { challengeToken: string; token?: string; recoveryCode?: string }
  >({
    mutationFn: async (values) => {
      const data = await request('verify-login', undefined, {
        challenge_token: values.challengeToken,
        token: values.token,
        recovery_code: values.recoveryCode,
      });
      return {
        accessToken: data.access_token,
        organizationId: data.organization_id,
        tenantId: data.tenant_id,
        userId: data.user_id,
      };
    },
  });
}
