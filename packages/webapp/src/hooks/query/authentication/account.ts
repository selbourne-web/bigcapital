import { fetchAuthedAccount, type AuthedAccount } from '@bigcapital/sdk-ts';
import { useQuery, UseQueryOptions } from '@tanstack/react-query';
import { useApiFetcher } from '../../useRequest';
import { authenticationKeys } from './query-keys';

/** The signed-in Bigcapital account (name, email, sign-in method, 2FA status). */
export function useAuthedAccount(
  props?: Omit<UseQueryOptions<AuthedAccount, Error>, 'queryKey' | 'queryFn'>,
) {
  const fetcher = useApiFetcher();

  return useQuery({
    ...props,
    queryKey: authenticationKeys.account(),
    queryFn: () => fetchAuthedAccount(fetcher),
  });
}
