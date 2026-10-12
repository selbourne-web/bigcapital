import {
  Button,
  Callout,
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
import { describeCryptoError } from './AddConnectionDialog';
import styles from './CryptoConnections.module.scss';
import { AppToaster } from '@/components';
import {
  CSV_ONLY_EXCHANGES,
  exchangeLabel,
} from '@/containers/Crypto/exchanges';
import {
  useCreateCsvOnlyConnection,
  type CryptoApiError,
} from '@/hooks/query/crypto';

interface AddCsvOnlyConnectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: PickableAccount[];
  accountsLoading?: boolean;
}

/**
 * Add a connection that has no API key: it is updated only by importing CSV
 * reports. The form is unmounted on close so its state never outlives it.
 */
export function AddCsvOnlyConnectionDialog({
  isOpen,
  onClose,
  accounts,
  accountsLoading,
}: AddCsvOnlyConnectionDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Add CSV-only connection"
      className={styles.dialog}
      canOutsideClickClose={false}
      canEscapeKeyClose={!busy}
      isCloseButtonShown={!busy}
    >
      {isOpen && (
        <CsvOnlyForm
          onClose={onClose}
          onBusyChange={setBusy}
          accounts={accounts}
          accountsLoading={accountsLoading}
        />
      )}
    </Dialog>
  );
}

function CsvOnlyForm({
  onClose,
  onBusyChange,
  accounts,
  accountsLoading,
}: Omit<AddCsvOnlyConnectionDialogProps, 'isOpen'> & {
  onBusyChange: (busy: boolean) => void;
}) {
  const uid = useId();
  const create = useCreateCsvOnlyConnection();
  const [exchange, setExchange] = useState<string>(CSV_ONLY_EXCHANGES[0].value);
  const [label, setLabel] = useState('');
  const [accountChoice, setAccountChoice] = useState(CREATE_ACCOUNT_VALUE);
  const [labelError, setLabelError] = useState<string | undefined>();
  const [failure, setFailure] = useState<CryptoApiError | null>(null);

  const isPending = create.isPending;
  useEffect(() => {
    onBusyChange(isPending);
    return () => onBusyChange(false);
  }, [isPending, onBusyChange]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // Pending guard: a double Enter must not create two connections.
    if (create.isPending) return;
    if (!label.trim()) {
      setLabelError('Give this connection a name.');
      window.requestAnimationFrame(() =>
        document.getElementById(`${uid}-label`)?.focus(),
      );
      return;
    }
    setLabelError(undefined);
    setFailure(null);
    create.mutate(
      {
        exchange,
        label: label.trim(),
        ...(accountChoice === CREATE_ACCOUNT_VALUE
          ? { createAccount: true }
          : { accountId: Number(accountChoice) }),
      },
      {
        onSuccess: () => {
          AppToaster.show({
            message: 'CSV-only connection added.',
            intent: Intent.SUCCESS,
          });
          onClose();
        },
        onError: setFailure,
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className={Classes.DIALOG_BODY}>
        <Callout
          icon="info-sign"
          className={styles.help}
          title="No API key needed"
        >
          <p>
            This connection is updated only when you import reports you export
            from {exchangeLabel(exchange)}. Use &quot;Import CSV&quot; on the
            connection afterwards; you will see a preview before anything is
            saved.
          </p>
        </Callout>

        <FormGroup label="Exchange" labelFor={`${uid}-exchange`}>
          <HTMLSelect
            id={`${uid}-exchange`}
            fill
            value={exchange}
            onChange={(event) => setExchange(event.currentTarget.value)}
            options={CSV_ONLY_EXCHANGES.map((e) => ({
              value: e.value,
              label: e.label,
            }))}
          />
        </FormGroup>

        <FormGroup
          label="Name"
          labelFor={`${uid}-label`}
          intent={labelError ? Intent.DANGER : Intent.NONE}
          helperText={
            labelError ? (
              <span id={`${uid}-label-error`}>{labelError}</span>
            ) : undefined
          }
        >
          <InputGroup
            id={`${uid}-label`}
            value={label}
            maxLength={100}
            placeholder={`${exchangeLabel(exchange)} - Reports`}
            intent={labelError ? Intent.DANGER : Intent.NONE}
            aria-invalid={!!labelError}
            aria-describedby={labelError ? `${uid}-label-error` : undefined}
            aria-required
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </FormGroup>

        <AccountPicker
          id={`${uid}-account`}
          accounts={accounts}
          loading={accountsLoading}
          value={accountChoice}
          onChange={setAccountChoice}
          helperText="Records imported from CSV reports are linked to this asset account."
        />

        {failure && (
          <Callout intent={Intent.DANGER} role="alert">
            {describeCryptoError(failure)}
          </Callout>
        )}
      </div>

      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            intent={Intent.PRIMARY}
            loading={create.isPending}
          >
            Add connection
          </Button>
        </div>
      </div>
    </form>
  );
}
