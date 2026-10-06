import {
  Button,
  Callout,
  Checkbox,
  Classes,
  Dialog,
  FormGroup,
  HTMLSelect,
  InputGroup,
  Intent,
} from '@blueprintjs/core';
import React, { useEffect, useId, useState } from 'react';
import {
  AccountPicker,
  CREATE_ACCOUNT_VALUE,
  type PickableAccount,
} from './AccountPicker';
import styles from './CryptoConnections.module.scss';
import { AppToaster } from '@/components';
import {
  CryptoApiError,
  useCreateCryptoConnection,
  useRotateCryptoCredentials,
  type CryptoConnection,
} from '@/hooks/query/crypto';

export const CRYPTO_EXCHANGES = [
  {
    value: 'kraken',
    label: 'Kraken',
    help: [
      'In Kraken, open Settings > Security > API and choose Create API key.',
      'Tick only "Query funds" (add "Query ledger entries" and "Query closed orders & trades" if you want history). Leave every trading, deposit and withdrawal permission off.',
    ],
  },
  {
    value: 'binance',
    label: 'Binance',
    help: [
      'In Binance, open Account > API Management and choose Create API (system generated).',
      'Enable "Enable Reading" only. Leave Spot & Margin Trading, Withdrawals, Futures and Internal Transfer off, and restrict the key to this server’s IP address if you can.',
    ],
  },
] as const;

export const exchangeLabel = (value: string) =>
  CRYPTO_EXCHANGES.find((exchange) => exchange.value === value)?.label ?? value;

/** Turns a crypto API failure into a sentence for the person. */
export const describeCryptoError = (error: unknown): string => {
  if (!(error instanceof CryptoApiError)) {
    return 'Something went wrong. Please try again.';
  }
  switch (error.code) {
    case 'KEY_HAS_EXTRA_PERMISSIONS':
      return (
        'This API key can do more than read data' +
        (error.permissions?.length
          ? ` (${error.permissions.join(', ')})`
          : '') +
        '. Create a read-only key and try again.'
      );
    case 'EXCHANGE_AUTH_FAILED':
      return 'The exchange rejected this API key. Check the key, secret and permissions.';
    case 'CRYPTO_SYNC_THROTTLED':
      return error.retryAfterSeconds
        ? `A sync was requested a moment ago. Try again in ${error.retryAfterSeconds} seconds.`
        : 'A sync was requested a moment ago. Try again shortly.';
    case 'ATTESTATION_REQUIRED':
      return 'The exchange cannot confirm this key is read-only. Confirm it below to continue.';
    case 'NETWORK_ERROR':
    case 'INVALID_RESPONSE':
    default:
      return error.message;
  }
};

interface AddConnectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: PickableAccount[];
  accountsLoading?: boolean;
  /** When set the dialog rotates this connection's credentials (Reconnect). */
  rotate?: CryptoConnection | null;
}

/**
 * Add a connection, or rotate the credentials of an existing one. The form is
 * unmounted on close, so its state (including secrets) never outlives it.
 */
export function AddConnectionDialog({
  isOpen,
  onClose,
  accounts,
  accountsLoading,
  rotate,
}: AddConnectionDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={
        rotate
          ? `${rotate.status === 'error' ? 'Reconnect' : 'Rotate key for'} ${rotate.label}`
          : 'Add exchange connection'
      }
      className={styles.dialog}
      canOutsideClickClose={false}
    >
      {isOpen && (
        <ConnectionForm
          onClose={onClose}
          accounts={accounts}
          accountsLoading={accountsLoading}
          rotate={rotate ?? null}
        />
      )}
    </Dialog>
  );
}

interface FormErrors {
  label?: string;
  apiKey?: string;
  apiSecret?: string;
  attest?: string;
}

function ConnectionForm({
  onClose,
  accounts,
  accountsLoading,
  rotate,
}: Omit<AddConnectionDialogProps, 'isOpen'> & {
  rotate: CryptoConnection | null;
}) {
  const uid = useId();
  const create = useCreateCryptoConnection();
  const rotation = useRotateCryptoCredentials();
  const mutation = rotate ? rotation : create;

  const [exchange, setExchange] = useState<string>(CRYPTO_EXCHANGES[0].value);
  const [label, setLabel] = useState('');
  // Secrets live only in this form's state and are wiped after every submit
  // (the one exception: kept for the attestation retry, below).
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [accountChoice, setAccountChoice] = useState(CREATE_ACCOUNT_VALUE);
  const [needsAttestation, setNeedsAttestation] = useState(false);
  const [attested, setAttested] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<CryptoApiError | null>(null);

  // Drop the mutation's retained variables when the form goes away.
  const { reset: resetCreate } = create;
  const { reset: resetRotation } = rotation;
  useEffect(
    () => () => {
      resetCreate();
      resetRotation();
    },
    [resetCreate, resetRotation],
  );

  const activeExchange = rotate ? rotate.exchange : exchange;
  const help = CRYPTO_EXCHANGES.find((e) => e.value === activeExchange)?.help;

  const clearSecrets = () => {
    setApiKey('');
    setApiSecret('');
    setPassphrase('');
  };

  const focusField = (id: string) =>
    window.requestAnimationFrame(() => document.getElementById(id)?.focus());

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const next: FormErrors = {};
    if (!rotate && !label.trim()) next.label = 'Give this connection a name.';
    if (!apiKey.trim()) next.apiKey = 'Paste the read-only API key.';
    if (!apiSecret.trim()) next.apiSecret = 'Paste the API secret.';
    if (needsAttestation && !attested) {
      next.attest = 'Confirm the key is read-only to continue.';
    }
    setErrors(next);
    if (next.label) return focusField(`${uid}-label`);
    if (next.apiKey) return focusField(`${uid}-key`);
    if (next.apiSecret) return focusField(`${uid}-secret`);
    if (next.attest) return focusField(`${uid}-attest`);

    setFailure(null);
    const credentials = {
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
      ...(needsAttestation && attested ? { attestReadOnly: true } : {}),
    };

    const onSuccess = () => {
      clearSecrets();
      mutation.reset();
      AppToaster.show({
        message: rotate ? 'Credentials updated.' : 'Connection added.',
        intent: Intent.SUCCESS,
      });
      onClose();
    };
    const onError = (error: CryptoApiError) => {
      if (error.code === 'ATTESTATION_REQUIRED') {
        // Keep what was typed so the person only has to tick the box.
        setNeedsAttestation(true);
      } else {
        clearSecrets();
        setAttested(false);
      }
      setFailure(error);
    };

    if (rotate) {
      rotation.mutate(
        { id: rotate.id, ...credentials },
        { onSuccess, onError },
      );
    } else {
      create.mutate(
        {
          exchange,
          label: label.trim(),
          ...credentials,
          ...(accountChoice === CREATE_ACCOUNT_VALUE
            ? { createAccount: true }
            : { accountId: Number(accountChoice) }),
        },
        { onSuccess, onError },
      );
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className={Classes.DIALOG_BODY}>
        {help && (
          <Callout
            icon="info-sign"
            className={styles.help}
            title="Create a read-only key"
          >
            {help.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>
              Selbourne Financial only ever reads balances and history. Keys
              with trading or withdrawal rights are refused.
            </p>
          </Callout>
        )}

        {!rotate && (
          <>
            <FormGroup label="Exchange" labelFor={`${uid}-exchange`}>
              <HTMLSelect
                id={`${uid}-exchange`}
                fill
                value={exchange}
                onChange={(event) => setExchange(event.currentTarget.value)}
                options={CRYPTO_EXCHANGES.map((e) => ({
                  value: e.value,
                  label: e.label,
                }))}
              />
            </FormGroup>

            <FormGroup
              label="Name"
              labelFor={`${uid}-label`}
              intent={errors.label ? Intent.DANGER : Intent.NONE}
              helperText={errors.label}
            >
              <InputGroup
                id={`${uid}-label`}
                value={label}
                maxLength={120}
                placeholder={`${exchangeLabel(exchange)} - Trading`}
                intent={errors.label ? Intent.DANGER : Intent.NONE}
                aria-invalid={!!errors.label}
                aria-required
                onChange={(event) => setLabel(event.currentTarget.value)}
              />
            </FormGroup>
          </>
        )}

        <FormGroup
          label="API key"
          labelFor={`${uid}-key`}
          intent={errors.apiKey ? Intent.DANGER : Intent.NONE}
          helperText={errors.apiKey}
        >
          <InputGroup
            id={`${uid}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            intent={errors.apiKey ? Intent.DANGER : Intent.NONE}
            aria-invalid={!!errors.apiKey}
            aria-required
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        </FormGroup>

        <FormGroup
          label="API secret"
          labelFor={`${uid}-secret`}
          intent={errors.apiSecret ? Intent.DANGER : Intent.NONE}
          helperText={errors.apiSecret}
        >
          <InputGroup
            id={`${uid}-secret`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiSecret}
            intent={errors.apiSecret ? Intent.DANGER : Intent.NONE}
            aria-invalid={!!errors.apiSecret}
            aria-required
            onChange={(event) => setApiSecret(event.currentTarget.value)}
          />
        </FormGroup>

        <FormGroup
          label="Passphrase (optional)"
          labelFor={`${uid}-passphrase`}
          helperText="Only if your exchange issued one with the key."
        >
          <InputGroup
            id={`${uid}-passphrase`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
          />
        </FormGroup>

        {!rotate && (
          <AccountPicker
            id={`${uid}-account`}
            accounts={accounts}
            loading={accountsLoading}
            value={accountChoice}
            onChange={setAccountChoice}
          />
        )}

        {needsAttestation && (
          <FormGroup
            intent={errors.attest ? Intent.DANGER : Intent.NONE}
            helperText={errors.attest}
          >
            <Checkbox
              id={`${uid}-attest`}
              checked={attested}
              aria-invalid={!!errors.attest}
              label="I confirm this API key is read-only (no trading, no withdrawals). The exchange does not let us verify that."
              onChange={(event) => setAttested(event.currentTarget.checked)}
            />
          </FormGroup>
        )}

        <div aria-live="polite">
          {failure && (
            <Callout
              intent={
                failure.code === 'ATTESTATION_REQUIRED'
                  ? Intent.WARNING
                  : Intent.DANGER
              }
              role="alert"
            >
              {describeCryptoError(failure)}
            </Callout>
          )}
        </div>
      </div>

      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            intent={Intent.PRIMARY}
            loading={mutation.isPending}
          >
            {rotate ? 'Save key' : 'Add connection'}
          </Button>
        </div>
      </div>
    </form>
  );
}
