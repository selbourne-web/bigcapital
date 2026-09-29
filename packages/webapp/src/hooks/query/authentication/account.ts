import { fetchAuthedAccount, type AuthedAccount } from '@bigcapital/sdk-ts';
import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { useApiFetcher } from '../../useRequest';
import { authenticationKeys } from './query-keys';

/** The signed-in Bigcapital account (name, email, sign-in method, 2FA status). */
export function useAuthedAccount(
  props?: Omit<UseQueryOptions<AuthedAccount, Error>, 'queryKey' | 'queryFn'>,
) {
  // Without this, the fetcher leaves the response snake_case (its default),
  // so `account.mfaEnabled`/`account.ssoProvider` would read as undefined
  // even though the server sent `mfa_enabled`/`sso_provider` correctly.
  const fetcher = useApiFetcher({ enableCamelCaseTransform: true });

  return useQuery({
    ...props,
    queryKey: authenticationKeys.account(),
    queryFn: () => fetchAuthedAccount(fetcher),
  });
}
