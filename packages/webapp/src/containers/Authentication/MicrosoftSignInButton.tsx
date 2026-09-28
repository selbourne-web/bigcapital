import { Button } from '@blueprintjs/core';
import React from 'react';
import { MICROSOFT_SSO_START_URL } from '@/hooks/query';

/**
 * "Sign in with Microsoft": a full-page navigation to the server, which
 * redirects on to Microsoft. Only rendered when the server says it's set up
 * (see useAuthMetaBoot).
 */
export function MicrosoftSignInButton() {
  return (
    <Button
      fill
      large
      icon={<MicrosoftLogo />}
      onClick={() => {
        window.location.href = MICROSOFT_SSO_START_URL;
      }}
    >
      Sign in with Microsoft
    </Button>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="1" width="6.5" height="6.5" fill="#F25022" />
      <rect x="8.5" y="1" width="6.5" height="6.5" fill="#7FBA00" />
      <rect x="1" y="8.5" width="6.5" height="6.5" fill="#00A4EF" />
      <rect x="8.5" y="8.5" width="6.5" height="6.5" fill="#FFB900" />
    </svg>
  );
}
