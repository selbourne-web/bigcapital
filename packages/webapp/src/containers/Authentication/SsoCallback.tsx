import { Spinner } from '@blueprintjs/core';
import React, { useEffect, useRef } from 'react';
import { Redirect, useLocation } from 'react-router-dom';
import { AuthInsiderCard } from './_components';
import { AuthInsider } from '@/containers/Authentication/AuthInsider';
import { useApplyAuthSession, useMicrosoftSsoExchange } from '@/hooks/query';

/**
 * Lands here after Microsoft sign-in: exchanges the one-time code for real
 * tokens, then falls through to the app (or back to login on failure).
 */
export function SsoCallback() {
  const location = useLocation();
  const applySession = useApplyAuthSession();
  const { mutate: exchange, isSuccess, isError } = useMicrosoftSsoExchange();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = new URLSearchParams(location.search).get('code');
    if (!code) return;

    exchange(
      { code },
      { onSuccess: (session) => applySession(session, false) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isSuccess) {
    return <Redirect to="/" />;
  }
  if (isError || !new URLSearchParams(location.search).get('code')) {
    return <Redirect to="/auth/login?ssoError=failed" />;
  }
  return (
    <AuthInsider>
      <AuthInsiderCard textAlign="center">
        <Spinner size={30} />
      </AuthInsiderCard>
    </AuthInsider>
  );
}
