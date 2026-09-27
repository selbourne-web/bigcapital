import { Button, Dialog, Intent, Spinner } from '@blueprintjs/core';
import React from 'react';
import styles from './AttachmentPreviewDialog.module.scss';
import {
  downloadBlob,
  getAttachmentPreviewKind,
  useAttachmentObjectUrl,
  useFetchAttachmentBlob,
} from '@/hooks/query/attachments';

export interface AttachmentPreviewFile {
  key: string;
  originName: string;
  mimeType: string;
  /** A local object URL of the same file (a receipt not saved yet). */
  localUrl?: string;
}

interface AttachmentPreviewDialogProps {
  file: AttachmentPreviewFile | null;
  onClose: () => void;
}

/**
 * Large view of an image or PDF attachment, with a download button. The file is
 * shown from the person's own session (nothing is public), and a PDF is framed
 * as a PDF only, never as anything the file claims to be.
 */
export function AttachmentPreviewDialog({
  file,
  onClose,
}: AttachmentPreviewDialogProps) {
  const remote = useAttachmentObjectUrl(
    file?.localUrl ? undefined : file?.key,
    file?.mimeType,
  );
  const kind = getAttachmentPreviewKind(file?.mimeType);
  const url = file?.localUrl ?? remote.url;
  const { isLoading, isError } = remote;
  const fetchBlob = useFetchAttachmentBlob();
  const [isDownloading, setDownloading] = React.useState(false);

  const handleDownload = async () => {
    if (!file) return;
    setDownloading(true);
    try {
      const blob = file.localUrl
        ? await (await fetch(file.localUrl)).blob()
        : await fetchBlob(file.key);
      downloadBlob(blob, file.originName || 'attachment');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog
      isOpen={!!file}
      onClose={onClose}
      title={file?.originName ?? 'Attachment'}
      className={styles.dialog}
      canOutsideClickClose
    >
      <div className={styles.stage}>
        {isLoading && <Spinner size={28} />}
        {isError && (
          <p className={styles.message} role="alert">
            This file could not be loaded.
          </p>
        )}
        {!kind && file && (
          <p className={styles.message}>
            This file type cannot be previewed. Use Download to open it.
          </p>
        )}
        {url && kind === 'image' && (
          <img src={url} alt={file?.originName ?? 'Attachment'} />
        )}
        {url && kind === 'pdf' && (
          <iframe src={url} title={file?.originName ?? 'Attachment'} />
        )}
      </div>
      <div className={styles.footer}>
        <Button
          icon="download"
          onClick={handleDownload}
          loading={isDownloading}
          text="Download"
        />
        <Button intent={Intent.PRIMARY} onClick={onClose} text="Close" />
      </div>
    </Dialog>
  );
}
