import { Button, Intent, Tag } from '@blueprintjs/core';
import React from 'react';
import { describeCryptoError, exchangeLabel } from './AddConnectionDialog';
import styles from './CryptoConnections.module.scss';
import { AppToaster } from '@/components';
import {
  useSyncCryptoConnection,
  useUpdateCryptoConnection,
  type CryptoConnection,
} from '@/hooks/query/crypto';

interface ConnectionRowProps {
  connection: CryptoConnection;
  /** Name of the mapped ledger account, when it exists. */
  accountName?: string | null;
  /** True when the connection has no usable ledger account. */
  accountMissing: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onRotate: (connection: CryptoConnection) => void;
  onDelete: (connection: CryptoConnection) => void;
}

const formatLastSync = (iso: string | null) => {
  if (!iso) return 'Never synced';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'Never synced'
    : `Last synced ${date.toLocaleString()}`;
};

const STATUS_TAG: Record<string, { text: string; intent: Intent }> = {
  active: { text: 'Active', intent: Intent.SUCCESS },
  paused: { text: 'Paused', intent: Intent.NONE },
  error: { text: 'Needs attention', intent: Intent.DANGER },
};

/** One exchange connection with its status and actions. */
export function ConnectionRow({
  connection,
  accountName,
  accountMissing,
  canEdit,
  canDelete,
  onRotate,
  onDelete,
}: ConnectionRowProps) {
  const sync = useSyncCryptoConnection();
  const update = useUpdateCryptoConnection();

  const status = STATUS_TAG[connection.status] ?? {
    text: String(connection.status),
    intent: Intent.NONE,
  };
  const isError = connection.status === 'error';
  const isPaused = connection.status === 'paused';

  const showError = (error: unknown) =>
    AppToaster.show({
      message: describeCryptoError(error),
      intent: Intent.DANGER,
    });

  const handleSync = () =>
    sync.mutate(connection.id, {
      onSuccess: () =>
        AppToaster.show({
          message: `Sync started for ${connection.label}.`,
          intent: Intent.SUCCESS,
        }),
      onError: showError,
    });

  const handleTogglePause = () =>
    update.mutate(
      { id: connection.id, status: isPaused ? 'active' : 'paused' },
      { onError: showError },
    );

  return (
    <li className={styles.row} aria-label={connection.label}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <strong>{connection.label}</strong>
          <Tag minimal round>
            {exchangeLabel(connection.exchange)}
          </Tag>
          <Tag minimal round intent={status.intent}>
            {status.text}
          </Tag>
          {accountMissing && (
            <Tag minimal round intent={Intent.WARNING} icon="warning-sign">
              Account not mapped
            </Tag>
          )}
        </div>
        <p className={styles.rowMeta}>
          {connection.keyHint
            ? `Key ending ${connection.keyHint}`
            : 'Key saved'}
          {' · '}
          {formatLastSync(connection.lastSyncAt)}
          {accountName ? ` · Posts to ${accountName}` : ''}
        </p>
        {isError && connection.lastError && (
          <p className={styles.rowError} role="status">
            {connection.lastError}
          </p>
        )}
      </div>

      <div className={styles.rowActions}>
        {canEdit && isError && (
          <Button
            small
            intent={Intent.PRIMARY}
            icon="refresh"
            onClick={() => onRotate(connection)}
          >
            Reconnect
          </Button>
        )}
        {canEdit && (
          <>
            <Button
              small
              icon="updated"
              loading={sync.isPending}
              disabled={isPaused || isError}
              title={
                isPaused
                  ? 'Resume this connection to sync.'
                  : isError
                    ? 'Reconnect with a new key to sync.'
                    : undefined
              }
              onClick={handleSync}
            >
              Sync now
            </Button>
            <Button
              small
              icon={isPaused ? 'play' : 'pause'}
              loading={update.isPending}
              disabled={isError}
              onClick={handleTogglePause}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </Button>
            {!isError && (
              <Button small icon="key" onClick={() => onRotate(connection)}>
                Rotate key
              </Button>
            )}
          </>
        )}
        {canDelete && (
          <Button
            small
            minimal
            intent={Intent.DANGER}
            icon="trash"
            onClick={() => onDelete(connection)}
          >
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}
