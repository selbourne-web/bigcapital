import { Button, Icon, Spinner } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React, { useState } from 'react';
import styles from './ExpenseReceiptAutofill.module.scss';
import type { ExpenseFormValues } from './types';
import { AttachmentPreviewDialog } from '@/components/Attachments/AttachmentPreviewDialog';
import type { AttachmentPreviewFile } from '@/components/Attachments/AttachmentPreviewDialog';
import {
  getAttachmentPreviewKind,
  useAttachmentObjectUrl,
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
 * Small preview of a saved receipt; a click opens the large view.
 */
function ReceiptThumbnail({
  file,
  onOpen,
}: {
  file: AttachmentPreviewFile;
  onOpen: (file: AttachmentPreviewFile) => void;
}) {
  const { url, kind, isLoading, isError } = useAttachmentObjectUrl(
    file.key,
    file.mimeType,
  );

  return (
    <div>
      <button
        type="button"
        className={styles.thumb}
        onClick={() => onOpen(file)}
        aria-label={`Open a larger view of ${file.originName}`}
      >
        {isLoading && <Spinner size={22} />}
        {isError && <span className={styles.status}>Could not load.</span>}
        {url && kind === 'image' && <img src={url} alt="" />}
        {url && kind === 'pdf' && <iframe src={url} title="" tabIndex={-1} />}
        {url && <span className={styles.thumbHint}>Click to enlarge</span>}
      </button>
      <div className={styles.fileName}>{file.originName}</div>
    </div>
  );
}

/**
 * Left panel of a saved expense: the receipts attached to it, as thumbnails
 * that open a larger view.
 */
export function ExpenseReceiptPreview() {
  const { values } = useFormikContext<ExpenseFormValues>();
  const [open, setOpen] = useState(true);
  const [enlarged, setEnlarged] = useState<AttachmentPreviewFile | null>(null);

  const files = ((values.attachments ?? []) as Array<Record<string, any>>)
    .map(toPreviewFile)
    .filter((file) => file.key && getAttachmentPreviewKind(file.mimeType));

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
      <div className={styles.body}>
        {files.length > 0 ? (
          <div className={styles.thumbs}>
            {files.map((file) => (
              <ReceiptThumbnail
                key={file.key}
                file={file}
                onOpen={setEnlarged}
              />
            ))}
          </div>
        ) : (
          <p className={styles.note}>
            No receipt is attached to this expense. Use Attachments below to add
            one (images and PDFs show here).
          </p>
        )}
      </div>
      <AttachmentPreviewDialog
        file={enlarged}
        onClose={() => setEnlarged(null)}
      />
    </aside>
  );
}
