import { Button, Icon, Intent, Spinner } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React, { useRef, useState } from 'react';
import styles from './ExpenseReceiptAutofill.module.scss';
import type { ExpenseFormValues } from './types';
import type { AttachmentPreviewFile } from '@/components/Attachments/AttachmentPreviewDialog';
import { AppToaster } from '@/components';
import { ReceiptViewer } from '@/components/Attachments/ReceiptViewer/ReceiptViewer';
import {
  getAttachmentPreviewKind,
  useAttachmentObjectUrl,
  useUploadAttachments,
} from '@/hooks/query/attachments';

// The form keeps attachments in camelCase or snake_case depending on whether
// the attachments popover has touched them.
const toPreviewFile = (
  attachment: Record<string, any>,
): AttachmentPreviewFile => ({
  key: attachment.key,
  originName: attachment.originName ?? attachment.origin_name ?? 'Receipt',
  mimeType: attachment.mimeType ?? attachment.mime_type ?? '',
});

/**
 * Uploads a marked-up copy and adds it to the expense's attachments; it is
 * kept once the expense is saved. The original receipt is left as it was.
 */
export const useAttachMarkedUpCopy = () => {
  const { setFieldValue, values } = useFormikContext<ExpenseFormValues>();
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const { mutateAsync: uploadAttachment } = useUploadAttachments();

  return async (copy: File) => {
    const form = new FormData();
    form.append('file', copy);
    form.append('internalKey', Date.now().toString());
    try {
      const uploaded = await uploadAttachment(form);
      setFieldValue('attachments', [
        ...(valuesRef.current.attachments ?? []),
        {
          key: uploaded.key,
          originName: copy.name,
          size: copy.size,
          mimeType: copy.type,
        },
      ]);
      AppToaster.show({
        intent: Intent.SUCCESS,
        message:
          'The marked-up copy was added to the attachments. Save the expense to keep it.',
      });
    } catch (error) {
      AppToaster.show({
        intent: Intent.DANGER,
        message: 'The marked-up copy could not be saved. Please try again.',
      });
      throw error;
    }
  };
};

function SavedReceiptViewer({
  file,
  onClose,
}: {
  file: AttachmentPreviewFile;
  onClose: () => void;
}) {
  const { url, kind, isLoading, isError } = useAttachmentObjectUrl(
    file.key,
    file.mimeType,
  );
  const attachCopy = useAttachMarkedUpCopy();

  if (isLoading) {
    return (
      <div className={styles.status}>
        <Spinner size={18} /> Loading the receipt…
      </div>
    );
  }
  if (isError || !url || !kind) {
    return (
      <div className={styles.status} role="alert">
        <Icon icon="error" intent={Intent.DANGER} /> The receipt could not be
        loaded.
      </div>
    );
  }
  return (
    <ReceiptViewer
      name={file.originName}
      url={url}
      kind={kind}
      onClose={onClose}
      onSaveCopy={attachCopy}
    />
  );
}

/**
 * Left panel of a saved expense: its receipt shown in full, with download,
 * print, zoom, rotate and highlighter tools.
 */
export function ExpenseReceiptPreview() {
  const { values } = useFormikContext<ExpenseFormValues>();
  const [open, setOpen] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const files = ((values.attachments ?? []) as Array<Record<string, any>>)
    .map(toPreviewFile)
    .filter((file) => file.key && getAttachmentPreviewKind(file.mimeType));
  const selected =
    files.find((file) => file.key === selectedKey) ?? files[0] ?? null;

  if (!open) {
    return (
      <aside className={`${styles.panel} ${styles.panelCollapsed}`}>
        <Button
          minimal
          icon="chevron-right"
          title="Open receipt"
          aria-label="Open receipt"
          onClick={() => setOpen(true)}
        />
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Receipt">
      <div className={styles.body}>
        {files.length > 1 && (
          <div className={styles.fileTabs} role="tablist">
            {files.map((file) => (
              <button
                key={file.key}
                type="button"
                role="tab"
                aria-selected={file.key === selected?.key}
                className={styles.fileTab}
                onClick={() => setSelectedKey(file.key)}
                title={file.originName}
              >
                {file.originName}
              </button>
            ))}
          </div>
        )}
        {selected ? (
          <SavedReceiptViewer
            key={selected.key}
            file={selected}
            onClose={() => setOpen(false)}
          />
        ) : (
          <>
            <div className={styles.header}>
              <h2 className={styles.title}>
                <Icon icon="paperclip" /> Receipt
              </h2>
              <Button
                minimal
                icon="chevron-left"
                title="Close receipt"
                aria-label="Close receipt"
                onClick={() => setOpen(false)}
              />
            </div>
            <p className={styles.note}>
              No receipt is attached to this expense. Use Attachments below to
              add one (images and PDFs show here).
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
