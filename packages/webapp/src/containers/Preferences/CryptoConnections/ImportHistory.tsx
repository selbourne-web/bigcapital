import {
  Alert,
  Button,
  Callout,
  Intent,
  Spinner,
  Tag,
} from '@blueprintjs/core';
import React, { useState } from 'react';
import { describeCryptoError } from './AddConnectionDialog';
import styles from './CryptoConnections.module.scss';
import { formatDateRange } from './ImportCsvDialog';
import { AppToaster } from '@/components';
import {
  CryptoApiError,
  useCryptoCsvImports,
  useRollbackCryptoCsv,
  type CryptoCsvImport,
} from '@/hooks/query/crypto';

const STATUS_TAG: Record<string, { text: string; intent: Intent }> = {
  committed: { text: 'Imported', intent: Intent.SUCCESS },
  rolled_back: { text: 'Rolled back', intent: Intent.NONE },
  failed: { text: 'Failed', intent: Intent.DANGER },
};

interface ImportHistoryProps {
  connectionId: number;
  /** Rolling back needs the Delete permission. */
  canRollback: boolean;
}

/** CSV import history of one connection with a confirmed Roll back action. */
export function ImportHistory({
  connectionId,
  canRollback,
}: ImportHistoryProps) {
  const query = useCryptoCsvImports(connectionId);
  const rollback = useRollbackCryptoCsv();
  const [target, setTarget] = useState<CryptoCsvImport | null>(null);
  const [failure, setFailure] = useState<CryptoApiError | null>(null);

  // Previews that were never confirmed are not history.
  const imports = (query.data ?? []).filter(
    (item) => item.status !== 'previewed',
  );

  const handleConfirm = () => {
    if (!target) return;
    const current = target;
    setFailure(null);
    rollback.mutate(
      { importId: current.id },
      {
        onSuccess: () => {
          AppToaster.show({
            message: `Rolled back ${current.filename}.`,
            intent: Intent.SUCCESS,
          });
          setTarget(null);
        },
        onError: (error) => {
          setFailure(error);
          setTarget(null);
        },
      },
    );
  };

  const failureText = failure ? describeCryptoError(failure) : '';
  // Only name dependents the server message does not already list.
  const dependents = (failure?.dependentImportIds ?? [])
    .filter((id) => !new RegExp('\\b' + id + '\\b').test(failureText))
    .map((id) => {
      const found = imports.find((item) => item.id === id);
      return found ? `${found.filename} (#${id})` : `#${id}`;
    });

  return (
    <div
      className={styles.history}
      role="region"
      aria-label="CSV import history"
    >
      {query.isLoading && (
        <div className={styles.loading} role="status" aria-label="Loading">
          <Spinner size={18} />
        </div>
      )}

      {query.isError && (
        <Callout intent={Intent.DANGER} role="alert">
          {describeCryptoError(query.error)}{' '}
          <Button small minimal onClick={() => query.refetch()}>
            Retry
          </Button>
        </Callout>
      )}

      {failure && (
        <Callout
          intent={Intent.WARNING}
          role="alert"
          className={styles.help}
          icon="warning-sign"
        >
          {failureText}
          {dependents.length > 0 && (
            <> Later imports: {dependents.join(', ')}.</>
          )}
        </Callout>
      )}

      {query.data && imports.length === 0 && (
        <p className={styles.rowMeta}>No CSV imports yet.</p>
      )}

      {imports.length > 0 && (
        <ul className={styles.historyList}>
          {imports.map((item) => {
            const status = STATUS_TAG[item.status] ?? {
              text: String(item.status),
              intent: Intent.NONE,
            };
            return (
              <li key={item.id} className={styles.historyItem}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <strong>{item.filename}</strong>
                    <Tag minimal round intent={status.intent}>
                      {status.text}
                    </Tag>
                  </div>
                  <p className={styles.rowMeta}>
                    {item.rowsImported} imported · {item.rowsSkippedDuplicate}{' '}
                    skipped · {item.rowsRejected} rejected ·{' '}
                    {formatDateRange(item.dateFrom, item.dateTo)}
                    {item.committedAt
                      ? ` · Imported ${new Date(item.committedAt).toLocaleString()}`
                      : ''}
                  </p>
                </div>
                {canRollback && item.status === 'committed' && (
                  <Button
                    small
                    minimal
                    intent={Intent.DANGER}
                    icon="undo"
                    aria-label={`Roll back ${item.filename}`}
                    onClick={() => {
                      setFailure(null);
                      setTarget(item);
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Alert
        isOpen={!!target}
        intent={Intent.DANGER}
        icon="undo"
        cancelButtonText="Cancel"
        confirmButtonText="Roll back import"
        loading={rollback.isPending}
        canEscapeKeyCancel={!rollback.isPending}
        onCancel={() => setTarget(null)}
        onConfirm={handleConfirm}
      >
        <p>
          Roll back <strong>{target?.filename}</strong>? The{' '}
          {target?.rowsImported} rows this file added are removed. Rows from
          other imports and from the exchange API are not touched.
        </p>
      </Alert>
    </div>
  );
}
