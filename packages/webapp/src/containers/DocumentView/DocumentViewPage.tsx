import React, { useEffect, useRef, useState } from 'react';
import BodyClassName from 'react-body-classname';
import { Helmet } from 'react-helmet';
import { useParams } from 'react-router-dom';
import styles from './DocumentViewPage.module.scss';
import { SelbourneLogo } from '@/components/Branding/SelbourneLogo';
import {
  documentViewUrl,
  isDocumentViewType,
  useGetDocumentView,
} from '@/hooks/query/document-view';

// The printed page is 794 x 1123 px (A4 at 96 dpi); it is scaled down to fit.
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;

/**
 * Public page a customer opens from the link in an estimate or credit note
 * email: the document as it prints, with a download and a print button.
 */
export function DocumentViewPage() {
  const { documentType, linkId } = useParams<{
    documentType: string;
    linkId: string;
  }>();
  const { data, isLoading, error } = useGetDocumentView(documentType, linkId);

  if (!isDocumentViewType(documentType)) {
    return <Message title="This link is not available" />;
  }
  if (isLoading) {
    return <Message title="Loading…" />;
  }
  if (error || !data) {
    return (
      <Message
        title="This link is not available"
        text="It may have been mistyped or is no longer shared. Please ask the sender for a new link."
      />
    );
  }

  const pdfUrl = documentViewUrl(documentType, linkId, '/pdf');

  return (
    <BodyClassName className={styles.pageBody}>
      <div className={styles.page}>
        <Helmet>
          <title>
            {data.title} {data.number}
            {data.companyName ? ` | ${data.companyName}` : ''}
          </title>
        </Helmet>

        <header className={styles.bar}>
          <div className={styles.summary}>
            <h1 className={styles.title}>
              {data.title} {data.number}
            </h1>
            <p className={styles.meta}>
              {[data.companyName, data.date && `Dated ${data.date}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {data.total && <p className={styles.total}>{data.total}</p>}
          </div>

          <div className={styles.actions}>
            <a className={styles.primary} href={pdfUrl}>
              Download PDF
            </a>
            <a
              className={styles.secondary}
              href={`${pdfUrl}?inline=1`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Print
            </a>
          </div>
        </header>

        <ScaledDocument
          html={data.html}
          title={`${data.title} ${data.number}`}
        />
      </div>
    </BodyClassName>
  );
}

/**
 * The document in a sandboxed frame (no scripts, no access to this page), scaled
 * down on narrow screens so the whole page width is always visible.
 */
function ScaledDocument({ html, title }: { html: string; title: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = holder.current;
    if (!element) return undefined;

    const update = () =>
      setScale(Math.min(1, element.clientWidth / PAGE_WIDTH));
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.sheetHolder}>
      <div ref={holder}>
        <div
          className={styles.sheet}
          style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}
        >
          <iframe
            className={styles.frame}
            title={title}
            srcDoc={html}
            sandbox=""
            style={{
              width: PAGE_WIDTH,
              height: PAGE_HEIGHT,
              transform: `scale(${scale})`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Message({ title, text }: { title: string; text?: string }) {
  return (
    <BodyClassName className={styles.pageBody}>
      <div className={styles.page}>
        <div className={styles.message}>
          <SelbourneLogo width={170} />
          <h1 className={styles.title}>{title}</h1>
          {text && <p className={styles.meta}>{text}</p>}
        </div>
      </div>
    </BodyClassName>
  );
}
