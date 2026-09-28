import {
  Button,
  Icon,
  InputGroup,
  Intent,
  Spinner,
  Tag,
} from '@blueprintjs/core';
import * as FF from 'fp-ts/function';
import QRCode from 'qrcode';
import React, { useEffect, useState } from 'react';
import styles from './Security.module.scss';
import type { WithDashboardActionsProps } from '@/containers/Dashboard/withDashboardActions';
import { AppToaster, Card } from '@/components';
import { CLASSES } from '@/constants/classes';
import { withDashboardActions } from '@/containers/Dashboard/withDashboardActions';
import {
  useAuthedAccount,
  useMfaSetup,
  useMfaEnable,
  useMfaDisable,
} from '@/hooks/query';

type SecurityPreferencesProps = Pick<
  WithDashboardActionsProps,
  'changePreferencesPageTitle'
>;

/**
 * Security preferences: sign-in method and two-factor authentication (TOTP),
 * the fallback for password sign-in when Microsoft sign-in isn't used.
 */
function SecurityPreferences({
  // #withDashboardActions
  changePreferencesPageTitle,
}: SecurityPreferencesProps) {
  useEffect(() => {
    changePreferencesPageTitle('Security');
  }, [changePreferencesPageTitle]);

  const { data: account, isLoading } = useAuthedAccount();

  return (
    <div className={CLASSES.PREFERENCES_PAGE_INSIDE_CONTENT}>
      <Card className={styles.card}>
        <h4>Sign-in method</h4>
        {!isLoading && (
          <p className={styles.status}>
            {account?.ssoProvider === 'microsoft' ? (
              <>
                <Icon icon="tick-circle" intent={Intent.SUCCESS} />
                Signed in with Microsoft
              </>
            ) : (
              <>
                <Icon icon="key" />
                Email and password
              </>
            )}
          </p>
        )}
      </Card>

      {!isLoading && <TwoFactorCard mfaEnabled={!!account?.mfaEnabled} />}
    </div>
  );
}

function TwoFactorCard({ mfaEnabled }: { mfaEnabled: boolean }) {
  return (
    <Card className={styles.card}>
      <h4>Two-factor authentication</h4>
      <p className={styles.note}>
        Used as the fallback whenever you sign in with a password instead of
        Microsoft.
      </p>
      {mfaEnabled ? <TurnOffMfa /> : <SetUpMfa />}
    </Card>
  );
}

/**
 * Renders the setup key as a scannable QR code (drawn entirely in the
 * browser; the secret never leaves this page to produce it). Authenticator
 * apps that can't scan still have the manual key and link shown alongside.
 */
function MfaQrCode({ otpauthUrl }: { otpauthUrl: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);

    QRCode.toDataURL(otpauthUrl, { width: 176, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  if (failed) return null;

  return (
    <div className={styles.qrCode}>
      {dataUrl ? (
        <img src={dataUrl} alt="Scan this in your authenticator app" />
      ) : (
        <Spinner size={40} />
      )}
    </div>
  );
}

function SetUpMfa() {
  const {
    mutate: startSetup,
    data: setup,
    isPending: isStarting,
  } = useMfaSetup();
  const { mutate: enable, isPending: isEnabling } = useMfaEnable();
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (recoveryCodes) {
    return (
      <>
        <p className={styles.status}>
          <Icon icon="tick-circle" intent={Intent.SUCCESS} />
          Two-factor authentication is on.
        </p>
        <p className={styles.note}>
          Save these recovery codes somewhere safe. Each one signs you in once,
          if you lose access to your authenticator app. They will not be shown
          again.
        </p>
        <div className={styles.recoveryCodes}>
          {recoveryCodes.map((recoveryCode) => (
            <span key={recoveryCode}>{recoveryCode}</span>
          ))}
        </div>
      </>
    );
  }

  if (!setup) {
    return (
      <Button
        intent={Intent.PRIMARY}
        loading={isStarting}
        onClick={() => startSetup()}
      >
        Set up two-factor authentication
      </Button>
    );
  }

  const handleEnable = () => {
    enable(
      { token: code },
      {
        onSuccess: (codes) => {
          setRecoveryCodes(codes);
          AppToaster.show({
            message: 'Two-factor authentication is now on.',
            intent: Intent.SUCCESS,
          });
        },
        onError: (error) => {
          AppToaster.show({ message: error.message, intent: Intent.DANGER });
          setCode('');
        },
      },
    );
  };

  return (
    <>
      <p className={styles.note}>
        Scan this with an authenticator app (Microsoft Authenticator, Google
        Authenticator, Authy, ...), then enter the 6-digit code it shows.
      </p>
      <MfaQrCode otpauthUrl={setup.otpauthUrl} />
      <p className={styles.note}>Can't scan? Enter this key manually:</p>
      <div className={styles.secret}>
        <code>{setup.secret}</code>
        <Button
          minimal
          small
          icon="clipboard"
          title="Copy"
          onClick={() => navigator.clipboard?.writeText(setup.secret)}
        />
      </div>
      <a
        className={styles.otpauthLink}
        href={setup.otpauthUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open in an authenticator app on this device
      </a>
      <InputGroup
        large
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="123456"
        maxLength={6}
      />
      <div className={styles.actions}>
        <Button
          intent={Intent.PRIMARY}
          loading={isEnabling}
          disabled={code.length !== 6}
          onClick={handleEnable}
        >
          Enable
        </Button>
      </div>
    </>
  );
}

function TurnOffMfa() {
  const { mutate: disable, isPending } = useMfaDisable();
  const [code, setCode] = useState('');
  const [isOff, setIsOff] = useState(false);

  if (isOff) {
    return (
      <p className={styles.status}>
        <Icon icon="disable" />
        Two-factor authentication is off.
      </p>
    );
  }

  const handleDisable = () => {
    disable(
      { token: code },
      {
        onSuccess: () => {
          setIsOff(true);
          AppToaster.show({
            message: 'Two-factor authentication is now off.',
            intent: Intent.SUCCESS,
          });
        },
        onError: (error) => {
          AppToaster.show({ message: error.message, intent: Intent.DANGER });
          setCode('');
        },
      },
    );
  };

  return (
    <>
      <p className={styles.status}>
        <Tag intent={Intent.SUCCESS} minimal round>
          On
        </Tag>
      </p>
      <p className={styles.note}>Enter a current code to turn it off.</p>
      <InputGroup
        large
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="123456"
        maxLength={6}
      />
      <div className={styles.actions}>
        <Button
          intent={Intent.DANGER}
          loading={isPending}
          disabled={code.length !== 6}
          onClick={handleDisable}
        >
          Turn off
        </Button>
      </div>
    </>
  );
}

export const Security = FF.pipe(SecurityPreferences, withDashboardActions);
