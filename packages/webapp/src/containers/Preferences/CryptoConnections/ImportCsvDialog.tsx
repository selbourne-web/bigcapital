import {
  Button,
  Callout,
  Classes,
  Dialog,
  FileInput,
  FormGroup,
  Intent,
} from '@blueprintjs/core';
import React, { useEffect, useId, useState } from 'react';
import { describeCryptoError } from './AddConnectionDialog';
import styles from './CryptoConnections.module.scss';
import { AppToaster } from '@/components';
import { exchangeLabel } from '@/containers/Crypto/exchanges';
import {
  CryptoApiError,
  useCommitCryptoCsv,
  usePreviewCryptoCsv,
  type CryptoConnection,
  type CryptoCsvImport,
  type CryptoCsvPreview,
} from '@/hooks/query/crypto';

/** Matches the server's upload limit. */
export const CSV_MAX_BYTES = 10 * 1024 * 1024;

/** Client-side check, so an obviously wrong file never leaves the browser. */
export const validateCsvFile = (file: File | null): string | null => {
  if (!file) return 'Choose a .csv file to import.';
  if (!/\.csv$/i.test(file.name)) {
    return 'Only .csv files can be imported.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > CSV_MAX_BYTES) {
    return 'The file is larger than the 10 MB limit. Export a shorter date range and import it in parts.';
  }
  return null;
};

const formatDate = (iso: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

export const formatDateRange = (
  from: string | null,
  to: string | null,
): string => {
  const a = formatDate(from);
  const b = formatDate(to);
  if (a && b) return a === b ? a : `${a} to ${b}`;
  return a ?? b ?? 'No dated rows';
};

const typeLabel = (type: string) => type.replace(/_/g, ' ');

interface ImportCsvDialogProps {
  isOpen: boolean;
  onClose: () => void;
  connection: CryptoConnection | null;
}

/**
 * Import an exchange CSV report: choose file, preview (nothing stored), then
 * confirm. The form unmounts on close so the chosen file never outlives it.
 */
export function ImportCsvDialog({
  isOpen,
  onClose,
  connection,
}: ImportCsvDialogProps) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={connection ? `Import CSV for ${connection.label}` : 'Import CSV'}
      className={styles.dialog}
      canOutsideClickClose={false}
      canEscapeKeyClose={!busy}
      isCloseButtonShown={!busy}
    >
      {isOpen && connection && (
        <ImportCsvForm
          connection={connection}
          onClose={onClose}
          onBusyChange={setBusy}
        />
      )}
    </Dialog>
  );
}

function ImportCsvForm({
  connection,
  onClose,
  onBusyChange,
}: {
  connection: CryptoConnection;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const uid = useId();
  const previewMutation = usePreviewCryptoCsv();
  const commitMutation = useCommitCryptoCsv();

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CryptoCsvPreview | null>(null);
  const [result, setResult] = useState<CryptoCsvImport | null>(null);
  const [failure, setFailure] = useState<CryptoApiError | null>(null);

  const isPending = previewMutation.isPending || commitMutation.isPending;
  useEffect(() => {
    onBusyChange(isPending);
    return () => onBusyChange(false);
  }, [isPending, onBusyChange]);

  const handleFileChange = (event: React.FormEvent<HTMLInputElement>) => {
    const next = event.currentTarget.files?.[0] ?? null;
    setFile(next);
    setFileError(next ? validateCsvFile(next) : null);
    // A different file invalidates any earlier preview.
    setPreview(null);
    setFailure(null);
  };

  const handlePreview = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateCsvFile(file);
    setFileError(problem);
    if (problem || !file) {
      window.requestAnimationFrame(() =>
        document.getElementById(`${uid}-file`)?.focus(),
      );
      return;
    }
    setFailure(null);
    previewMutation.mutate(
      { connectionId: connection.id, file },
      {
        onSuccess: setPreview,
        onError: (error) => {
          setPreview(null);
          setFailure(error);
        },
      },
    );
  };

  const handleConfirm = () => {
    if (!preview || !file) return;
    setFailure(null);
    commitMutation.mutate(
      { importId: preview.importId, file },
      {
        onSuccess: (done) => {
          setResult(done);
          AppToaster.show({
            message: `Imported ${done.rowsImported} rows from ${done.filename}.`,
            intent: Intent.SUCCESS,
          });
        },
        onError: setFailure,
      },
    );
  };

  const failureCallout = failure && (
    <Callout intent={Intent.DANGER} role="alert" className={styles.help}>
      {describeCryptoError(failure)}
    </Callout>
  );

  // Done: summary announced to assistive tech.
  if (result) {
    return (
      <>
        <div className={Classes.DIALOG_BODY}>
          <div role="status" aria-live="polite">
            <Callout intent={Intent.SUCCESS} icon="tick-circle">
              <p className={styles.resultLine}>
                Imported {result.rowsImported} of {result.rowCount} rows from{' '}
                {result.filename}.
              </p>
              <p className={styles.resultLine}>
                {result.rowsSkippedDuplicate} already stored and skipped,{' '}
                {result.rowsRejected} rejected. Dates:{' '}
                {formatDateRange(result.dateFrom, result.dateTo)}.
              </p>
            </Callout>
          </div>
          <p className={styles.note}>
            You can undo this from the import history of {connection.label}{' '}
            (Roll back).
          </p>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button intent={Intent.PRIMARY} onClick={onClose} autoFocus>
              Done
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={handlePreview} noValidate>
      <div className={Classes.DIALOG_BODY}>
        <Callout icon="info-sign" className={styles.help}>
          <p>
            Import a report you exported from{' '}
            {exchangeLabel(connection.exchange)} to fill in history the API
            cannot return. You will see a preview first; nothing is saved until
            you confirm.
          </p>
        </Callout>

        <FormGroup
          label="CSV file (up to 10 MB)"
          labelFor={`${uid}-file`}
          intent={fileError ? Intent.DANGER : Intent.NONE}
          helperText={fileError ?? undefined}
        >
          <FileInput
            fill
            disabled={isPending}
            text={file ? file.name : 'Choose a .csv file...'}
            hasSelection={!!file}
            inputProps={{
              id: `${uid}-file`,
              accept: '.csv,text/csv',
              'aria-invalid': !!fileError,
            }}
            onInputChange={handleFileChange}
          />
        </FormGroup>

        {preview && <PreviewSummary preview={preview} />}
        {failureCallout}
      </div>

      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          {preview ? (
            <Button
              intent={Intent.PRIMARY}
              icon="import"
              loading={commitMutation.isPending}
              disabled={preview.importable === 0 || previewMutation.isPending}
              onClick={handleConfirm}
            >
              {preview.importable === 0
                ? 'Nothing to import'
                : `Import ${preview.importable} rows`}
            </Button>
          ) : (
            <Button
              type="submit"
              intent={Intent.PRIMARY}
              loading={previewMutation.isPending}
              disabled={!file || !!fileError}
            >
              Preview
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Counts, date range and rejected lines from the server preview. No file contents. */
function PreviewSummary({ preview }: { preview: CryptoCsvPreview }) {
  const types = Object.entries(preview.byType);
  return (
    <div className={styles.preview} role="status" aria-live="polite">
      <h5 className={styles.previewTitle}>Preview of {preview.filename}</h5>
      <dl className={styles.stats}>
        <div>
          <dt>Rows in file</dt>
          <dd>{preview.rowCount}</dd>
        </div>
        <div>
          <dt>Will be imported</dt>
          <dd>{preview.importable}</dd>
        </div>
        <div>
          <dt>Already imported</dt>
          <dd>{preview.alreadyImported}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{preview.rejectedCount}</dd>
        </div>
      </dl>
      <p className={styles.rowMeta}>
        Dates: {formatDateRange(preview.dateFrom, preview.dateTo)}
        {types.length > 0 && (
          <>
            {' · '}
            {types
              .map(([type, count]) => `${count} ${typeLabel(type)}`)
              .join(', ')}
          </>
        )}
      </p>

      {preview.apiOverlap > 0 && (
        <Callout intent={Intent.WARNING} className={styles.help}>
          The exchange API already returned {preview.apiOverlap} trades in this
          date range. Both are kept for now; a later update will reconcile
          overlap with API history.
        </Callout>
      )}

      {preview.rejectedCount > 0 && (
        <div className={styles.rejected}>
          <p className={styles.rowError}>
            {preview.rejectedCount} rows will be skipped
            {preview.rejected.length < preview.rejectedCount
              ? ` (first ${preview.rejected.length} shown)`
              : ''}
            :
          </p>
          <ul>
            {preview.rejected.map((row) => (
              <li key={`${row.line}-${row.reason}`}>
                Line {row.line}: {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
