import { Button, InputGroup, Intent } from '@blueprintjs/core';
import React, { useState } from 'react';
import { AuthSubmitButton } from './_components';
import { AppToaster } from '@/components';
import { useMfaVerifyLogin, useApplyAuthSession } from '@/hooks/query';

interface MfaChallengeFormProps {
  challengeToken: string;
  rememberMe: boolean;
  onBack: () => void;
}

/**
 * The second step of sign-in for an account with two-factor authentication:
 * a code from the authenticator app, or a recovery code if the phone is
 * unavailable.
 */
export function MfaChallengeForm({
  challengeToken,
  rememberMe,
  onBack,
}: MfaChallengeFormProps) {
  const [code, setCode] = useState('');
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);
  const applySession = useApplyAuthSession();
  const { mutate: verifyLogin, isPending } = useMfaVerifyLogin();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    verifyLogin(
      {
        challengeToken,
        ...(usingRecoveryCode ? { recoveryCode: code } : { token: code }),
      },
      {
        onSuccess: (session) => applySession(session, rememberMe),
        onError: (error) => {
          AppToaster.show({ message: error.message, intent: Intent.DANGER });
          setCode('');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit}>
      <p>
        {usingRecoveryCode
          ? 'Enter one of your recovery codes.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <InputGroup
        large
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder={usingRecoveryCode ? 'XXXX-XXXX' : '123456'}
        maxLength={usingRecoveryCode ? 9 : 6}
      />
      <AuthSubmitButton
        type="submit"
        intent={Intent.PRIMARY}
        fill
        large
        loading={isPending}
        disabled={!code}
      >
        Verify
      </AuthSubmitButton>

      <ChallengeFooter>
        <Button
          minimal
          small
          onClick={() => {
            setUsingRecoveryCode(!usingRecoveryCode);
            setCode('');
          }}
        >
          {usingRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}
        </Button>
        <Button minimal small onClick={onBack}>
          Back
        </Button>
      </ChallengeFooter>
    </form>
  );
}

function ChallengeFooter({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 12,
      }}
    >
      {children}
    </div>
  );
}
