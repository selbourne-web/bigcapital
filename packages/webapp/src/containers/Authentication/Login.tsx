import { Intent } from '@blueprintjs/core';
import { Formik, FormikHelpers } from 'formik';
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import {
  AuthFooterLinks,
  AuthFooterLink,
  AuthInsiderCard,
} from './_components';
import { useAuthMetaBoot } from './AuthMetaBoot';
import { LoginForm } from './LoginForm';
import { MfaChallengeForm } from './MfaChallengeForm';
import { MicrosoftSignInButton } from './MicrosoftSignInButton';
import {
  LoginSchema,
  transformLoginErrorsToToasts,
  ssoErrorMessage,
  LoginValues,
} from './utils';
import type { ApiError } from 'openapi-typescript-fetch';
import { AppToaster as Toaster, FormattedMessage as T } from '@/components';
import { AuthInsider } from '@/containers/Authentication/AuthInsider';
import { useAuthLogin } from '@/hooks/query';

const initialValues: LoginValues = {
  crediential: '',
  password: '',
  keepLoggedIn: false,
};

/**
 * Login page: Microsoft sign-in when it's set up, plus email/password with a
 * two-factor step for accounts that have it turned on.
 */
export function Login() {
  const { mutateAsync: loginMutate } = useAuthLogin();
  const { microsoftSsoEnabled } = useAuthMetaBoot();
  const [challenge, setChallenge] = useState<{
    challengeToken: string;
    rememberMe: boolean;
  } | null>(null);

  useShowSsoErrorFromUrl();

  const handleSubmit = (
    values: LoginValues,
    { setSubmitting }: FormikHelpers<LoginValues>,
  ) => {
    loginMutate({
      email: values.crediential,
      password: values.password,
      rememberMe: values.keepLoggedIn,
    })
      .then((data) => {
        if (data.mfa_required && data.challenge_token) {
          setChallenge({
            challengeToken: data.challenge_token,
            rememberMe: values.keepLoggedIn,
          });
        }
      })
      .catch((response: ApiError) => {
        const toastMessages = transformLoginErrorsToToasts(response.data);

        toastMessages.forEach((toastMessage) => {
          Toaster.show(toastMessage);
        });
        setSubmitting(false);
      });
  };

  return (
    <AuthInsider>
      <AuthInsiderCard>
        {challenge ? (
          <MfaChallengeForm
            challengeToken={challenge.challengeToken}
            rememberMe={challenge.rememberMe}
            onBack={() => setChallenge(null)}
          />
        ) : (
          <>
            {microsoftSsoEnabled && (
              <>
                <MicrosoftSignInButton />
                <OrDivider>or</OrDivider>
              </>
            )}
            <Formik
              initialValues={initialValues}
              validationSchema={LoginSchema}
              onSubmit={handleSubmit}
              component={LoginForm}
            />
          </>
        )}
      </AuthInsiderCard>

      {!challenge && <LoginFooterLinks />}
    </AuthInsider>
  );
}

/** Shows a toast once if the server sent the browser back with ?ssoError=. */
function useShowSsoErrorFromUrl() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('ssoError');
    if (!reason) return;

    Toaster.show({ message: ssoErrorMessage(reason), intent: Intent.DANGER });
    params.delete('ssoError');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (query ? `?${query}` : ''),
    );
  }, []);
}

function LoginFooterLinks() {
  const { signupDisabled } = useAuthMetaBoot();

  return (
    <AuthFooterLinks>
      {!signupDisabled && (
        <AuthFooterLink>
          <T id={'dont_have_an_account'} />{' '}
          <Link to={'/auth/register'}>
            <T id={'sign_up'} />
          </Link>
        </AuthFooterLink>
      )}
      <AuthFooterLink>
        <Link to={'/auth/send_reset_password'}>
          <T id={'forgot_my_password'} />
        </Link>
      </AuthFooterLink>
    </AuthFooterLinks>
  );
}

const OrDivider = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0;
  color: #8a8a8a;
  font-size: 12px;

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #e1e1e1;
  }
`;
