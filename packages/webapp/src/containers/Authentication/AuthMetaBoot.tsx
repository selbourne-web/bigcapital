import { Spinner } from '@blueprintjs/core';
import { createContext, ReactNode, useContext } from 'react';
import styled from 'styled-components';
import { useAuthMetadata } from '@/hooks/query';

export interface AuthMetaBootState {
  isAuthMetaLoading: boolean;
  signupDisabled?: boolean;
  microsoftSsoEnabled?: boolean;
}

export interface AuthMetaBootProviderProps {
  children?: ReactNode;
}

const AuthMetaBootContext = createContext<AuthMetaBootState | undefined>(
  undefined,
);

/**
 * Boots the authentication page metadata.
 */
function AuthMetaBootProvider({
  children,
  ...props
}: AuthMetaBootProviderProps) {
  const { isLoading: isAuthMetaLoading, data: authMeta } = useAuthMetadata();

  // useAuthApiFetcher() (unauthenticated) does not camelCase responses, so
  // this reads whichever key name actually came back on the wire.
  const meta = authMeta as
    | (typeof authMeta & {
        signup_disabled?: boolean;
        microsoft_sso_enabled?: boolean;
      })
    | undefined;

  const state: AuthMetaBootState = {
    isAuthMetaLoading,
    signupDisabled: meta?.signupDisabled ?? meta?.signup_disabled,
    microsoftSsoEnabled:
      meta?.microsoftSsoEnabled ?? meta?.microsoft_sso_enabled,
  };

  if (isAuthMetaLoading) {
    return (
      <SpinnerRoot>
        <Spinner size={30} />
      </SpinnerRoot>
    );
  }
  return (
    <AuthMetaBootContext.Provider value={state} {...props}>
      {children}
    </AuthMetaBootContext.Provider>
  );
}

const useAuthMetaBoot = (): AuthMetaBootState => {
  const context = useContext(AuthMetaBootContext);
  if (!context) {
    throw new Error(
      'useAuthMetaBoot must be used within an AuthMetaBootProvider.',
    );
  }
  return context;
};

export { AuthMetaBootContext, AuthMetaBootProvider, useAuthMetaBoot };

const SpinnerRoot = styled.div`
  margin-top: 5rem;
`;
