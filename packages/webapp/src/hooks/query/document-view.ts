import { useQuery } from '@tanstack/react-query';

/** Documents a customer can open online from an email link. */
export type DocumentViewType = 'estimate' | 'credit-note';

export interface DocumentView {
  documentType: DocumentViewType;
  title: string;
  number: string;
  date?: string;
  expirationDate?: string;
  total?: string;
  companyName?: string;
  primaryColor?: string | null;
  /** The document as it prints, a complete html page. */
  html: string;
}

export const isDocumentViewType = (value: string): value is DocumentViewType =>
  value === 'estimate' || value === 'credit-note';

/** Api url of a shared document (or, with `/pdf`, its PDF). */
export const documentViewUrl = (
  type: DocumentViewType,
  linkId: string,
  suffix = '',
) => `/api/document-views/${encodeURIComponent(linkId)}/${type}${suffix}`;

// The api answers in snake_case; only the few fields the page reads are mapped.
const toDocumentView = (data: Record<string, any>): DocumentView => ({
  documentType: data.document_type,
  title: data.title,
  number: data.number,
  date: data.date,
  expirationDate: data.expiration_date,
  total: data.total,
  companyName: data.company_name,
  primaryColor: data.primary_color,
  html: data.html,
});

/**
 * Loads a shared estimate or credit note. Public: no token is sent, the link id
 * in the url is the credential.
 */
export function useGetDocumentView(type: string, linkId: string) {
  return useQuery<DocumentView, Error>({
    queryKey: ['DOCUMENT_VIEW', type, linkId],
    enabled: isDocumentViewType(type),
    retry: false,
    queryFn: async () => {
      const response = await fetch(
        documentViewUrl(type as DocumentViewType, linkId),
        { headers: { accept: 'application/json' } },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'not-found'
            : `Request failed (${response.status})`,
        );
      }
      const body = await response.json();

      return toDocumentView(body.data);
    },
  });
}
