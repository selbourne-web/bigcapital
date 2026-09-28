import {
  signin,
  signup,
  signupConfirm,
  sendResetPassword,
  resetPassword,
  fetchAuthMeta,
  resendSignupConfirm,
  type AuthSigninResponse,
  type AuthSigninBody,
  type AuthSignupBody,
  type AuthSignupVerifyBody,
  type AuthSendResetPasswordBody,
  type AuthResetPasswordBody,
  type AuthMetaResponse,
} from '@bigcapital/sdk-ts';
import {
  useMutation,
  useQuery,
  UseMutationOptions,
  UseQueryOptions,
} from '@tanstack/react-query';
import { batch } from 'react-redux';
import { setCookie } from '../../../utils';
import {
  useSetAuthToken,
  useSetAuthUserId,
  useSetOrganizationId,
} from '../../state';
import { useAuthApiFetcher, useApiFetcher } from '../../useRequest';
import { authenticationKeys } from './query-keys';

/** The tokens a completed sign-in returns, however it got there (password,
 * two-factor challenge, or Microsoft). */
export interface AuthSession {
  accessToken: string;
  organizationId: string;
  tenantId: number;
  userId: number;
}

/** Saves the session to cookies. */
export function setAuthSessionCookies(
  session: AuthSession,
  rememberMe = false,
): void {
  const expiry = rememberMe ? 30 : 1;
  setCookie('token', session.accessToken ?? '', expiry);
  setCookie('authenticated_user_id', String(session.userId ?? ''), expiry);
  setCookie('organization_id', session.organizationId ?? '', expiry);
  setCookie('tenant_id', String(session.tenantId ?? ''), expiry);
}

/** @deprecated kept for callers still passing the raw snake_case response. */
export function setAuthLoginCookies(
  data: AuthSigninResponse,
  rememberMe = false,
): void {
  setAuthSessionCookies(
    {
      // @ts-ignore - the wire response is snake_case; the SDK type is not.
      accessToken: data.access_token ?? '',
      // @ts-ignore
      organizationId: data.organization_id ?? '',
      // @ts-ignore
      tenantId: data.tenant_id,
      // @ts-ignore
      userId: data.user_id,
    },
    rememberMe,
  );
}

/** What /auth/signin returns: either tokens, or a two-factor challenge to
 * resolve at POST /auth/mfa/verify-login before any tokens are issued. */
export interface AuthSigninOrChallengeResponse {
  // Present when sign-in is complete (the wire response is snake_case).
  access_token?: string;
  organization_id?: string;
  tenant_id?: number;
  user_id?: number;
  // Present instead, when two-factor authentication is required.
  mfa_required?: true;
  challenge_token?: string;
}

export function useAuthLogin(
  props?: UseMutationOptions<
    AuthSigninOrChallengeResponse,
    Error,
    AuthSigninBody
  >,
) {
  const fetcher = useAuthApiFetcher();
  const setAuthToken = useSetAuthToken();
  const setOrganizationId = useSetOrganizationId();
  const setUserId = useSetAuthUserId();

  return useMutation({
    ...props,
    mutationFn: (values: AuthSigninBody) =>
      signin(
        fetcher,
        values,
      ) as unknown as Promise<AuthSigninOrChallengeResponse>,
    onSuccess: (data, variables, context, mutation) => {
      // A two-factor challenge carries no tokens yet; nothing to store until
      // POST /auth/mfa/verify-login completes it.
      if (!data.mfa_required) {
        setAuthLoginCookies(data as AuthSigninResponse, variables?.rememberMe);
        batch(() => {
          setAuthToken(data.access_token ?? '');
          setOrganizationId(data.organization_id ?? '');
          setUserId(String(data.user_id ?? ''));
        });
      }
      props?.onSuccess?.(data, variables, context, mutation);
    },
  });
}

/** Applies a completed session (two-factor or Microsoft sign-in) the same
 * way a normal password sign-in does. */
export function useApplyAuthSession() {
  const setAuthToken = useSetAuthToken();
  const setOrganizationId = useSetOrganizationId();
  const setUserId = useSetAuthUserId();

  return (session: AuthSession, rememberMe = false) => {
    setAuthSessionCookies(session, rememberMe);
    batch(() => {
      setAuthToken(session.accessToken);
      setOrganizationId(session.organizationId);
      setUserId(String(session.userId));
    });
  };
}

export function useAuthRegister(
  props?: UseMutationOptions<unknown, Error, AuthSignupBody>,
) {
  const fetcher = useAuthApiFetcher();

  return useMutation({
    ...props,
    mutationFn: (values: AuthSignupBody) => signup(fetcher, values),
  });
}

export function useAuthSendResetPassword(
  props?: UseMutationOptions<unknown, Error, AuthSendResetPasswordBody>,
) {
  const fetcher = useAuthApiFetcher();

  return useMutation({
    ...props,
    mutationFn: (values: AuthSendResetPasswordBody) =>
      sendResetPassword(fetcher, values),
  });
}

export function useAuthResetPassword(
  props?: UseMutationOptions<
    unknown,
    Error,
    [token: string, values: AuthResetPasswordBody]
  >,
) {
  const fetcher = useAuthApiFetcher();

  return useMutation({
    ...props,
    mutationFn: ([token, values]: [string, AuthResetPasswordBody]) =>
      resetPassword(fetcher, token, values),
  });
}

export function useAuthMetadata(
  props?: Omit<
    UseQueryOptions<AuthMetaResponse, Error>,
    'queryKey' | 'queryFn'
  >,
) {
  const fetcher = useAuthApiFetcher();

  return useQuery({
    ...props,
    queryKey: authenticationKeys.metadata(),
    queryFn: () => fetchAuthMeta(fetcher),
  });
}

export function useAuthSignUpVerifyResendMail(
  props?: UseMutationOptions<void, Error, void>,
) {
  const fetcher = useApiFetcher();

  return useMutation({
    ...props,
    mutationFn: () => resendSignupConfirm(fetcher),
  });
}

export function useAuthSignUpVerify(
  props?: UseMutationOptions<unknown, Error, AuthSignupVerifyBody>,
) {
  const fetcher = useAuthApiFetcher();

  return useMutation({
    ...props,
    mutationFn: (values: AuthSignupVerifyBody) =>
      signupConfirm(fetcher, values),
  });
}
