import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useAuthOrganizationId, useAuthToken } from '../../state';
import { attachmentsKeys } from './query-keys';

/** Kinds of file the app shows inline; everything else is downloaded. */
export type AttachmentPreviewKind = 'image' | 'pdf';

export const getAttachmentPreviewKind = (
  mimeType?: string | null,
): AttachmentPreviewKind | null => {
  if (mimeType === 'application/pdf') return 'pdf';
  // SVG is left out: it can carry script, and it is not a receipt format.
  if (mimeType?.startsWith('image/') && mimeType !== 'image/svg+xml') {
    return 'image';
  }
  return null;
};

/**
 * Returns a function that reads an attachment through the API (which streams it
 * from storage) with the person's own session. The storage server is not
 * reachable from the browser in every setup, so files are never fetched from it
 * directly.
 */
export function useFetchAttachmentBlob() {
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();

  return useCallback(
    async (key: string): Promise<Blob> => {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (organizationId) headers['organization-id'] = String(organizationId);

      const response = await fetch(
        `/api/attachments/${encodeURIComponent(key)}`,
        { headers },
      );
      if (!response.ok) {
        throw new Error('The attachment could not be loaded.');
      }
      return response.blob();
    },
    [token, organizationId],
  );
}

/**
 * An object URL for showing an attachment in an image or a PDF frame. The file
 * is fetched once per key and cached; the URL is released when no longer used.
 */
export function useAttachmentObjectUrl(
  key: string | undefined,
  mimeType?: string | null,
) {
  const fetchBlob = useFetchAttachmentBlob();
  const kind = getAttachmentPreviewKind(mimeType);

  const {
    data: blob,
    isLoading,
    isError,
  } = useQuery({
    queryKey: [...attachmentsKeys.all(), 'file', key],
    queryFn: () => fetchBlob(key as string),
    enabled: !!key && !!kind,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    // A blob type that is not what was expected is not shown.
    const expected =
      kind === 'pdf'
        ? blob.type === 'application/pdf'
        : blob.type.startsWith('image/');
    const objectUrl = expected ? URL.createObjectURL(blob) : null;
    setUrl(objectUrl);

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blob, kind]);

  return { url, kind, isLoading, isError };
}

/** Saves a blob as a file with the given name. */
export const downloadBlob = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};
