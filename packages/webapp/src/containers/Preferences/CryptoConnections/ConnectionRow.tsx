import { Button, Icon, Intent, Tag } from '@blueprintjs/core';
import React, { useState } from 'react';
import { describeCryptoError } from './AddConnectionDialog';
import styles from './CryptoConnections.module.scss';
import { ImportCsvDialog } from './ImportCsvDialog';
import { ImportHistory } from './ImportHistory';
import { AppToaster } from '@/components';
import {
  exchangeLabel,
  supportsCsvImport,
} from '@/containers/Crypto/exchanges';
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
  /** Create permission: uploading a CSV. */
  canImport?: boolean;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 14;

/** "Key expires <date>" text with a warning flag within 14 days of expiry or once past. */
export const describeKeyExpiry = (
  iso: string | null,
  now: number = Date.now(),
): { text: string; warn: boolean } | null => {
  if (!iso) return null;
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const warn = time - now <= EXPIRY_WARNING_DAYS * DAY_MS;
  const when = date.toLocaleDateString();
  return {
    text: time < now ? `Key expired ${when}` : `Key expires ${when}`,
    warn,
  };
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
  canImport = false,
  onRotate,
  onDelete,
}: ConnectionRowProps) {
  const sync = useSyncCryptoConnection();
  const update = useUpdateCryptoConnection();
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const csvCapable = supportsCsvImport(connection.exchange);

  const status = STATUS_TAG[connection.status] ?? {
    text: String(connection.status),
    intent: Intent.NONE,
  };
  const expiry = describeKeyExpiry(connection.keyExpiresAt);
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
        {expiry && (
          <p
            className={expiry.warn ? styles.rowError : styles.rowMeta}
            role={expiry.warn ? 'status' : undefined}
          >
            {expiry.warn && (
              <Icon icon="warning-sign" size={12} aria-hidden="true" />
            )}{' '}
            {expiry.text}
            {expiry.warn ? '. Rotate the key to keep syncing.' : ''}
          </p>
        )}
        {connection.historyCoverage?.level === 'partial' && (
          <p className={styles.rowMeta}>
            History limited
            {connection.historyCoverage.note
              ? `: ${connection.historyCoverage.note.replace(/\.+$/, '')}`
              : ''}
            .
          </p>
        )}
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
        {csvCapable && canImport && (
          <Button
            small
            icon="import"
            aria-label={`Import CSV for ${connection.label}`}
            onClick={() => setImportOpen(true)}
          >
            Import CSV
          </Button>
        )}
        {csvCapable && (
          <Button
            small
            minimal
            icon="history"
            aria-label={`${historyOpen ? 'Hide' : 'Show'} import history for ${connection.label}`}
            aria-expanded={historyOpen}
            aria-controls={`csv-history-${connection.id}`}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {historyOpen ? 'Hide import history' : 'Import history'}
          </Button>
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

      {csvCapable && historyOpen && (
        <div id={`csv-history-${connection.id}`} className={styles.rowFull}>
          <ImportHistory connectionId={connection.id} canRollback={canDelete} />
        </div>
      )}
      {csvCapable && (
        <ImportCsvDialog
          isOpen={importOpen}
          onClose={() => setImportOpen(false)}
          connection={connection}
        />
      )}
    </li>
  );
}
