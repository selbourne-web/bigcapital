import { Button, Classes, Icon, Intent, Spinner } from '@blueprintjs/core';
import { Tooltip2 as Tooltip } from '@blueprintjs/popover2';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  HIGHLIGHT_FILL,
  highlightFromDisplay,
  highlightToDisplay,
} from './highlights';
import styles from './ReceiptViewer.module.scss';
import type { Highlight, Rotation } from './highlights';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

type PdfJs = typeof import('pdfjs-dist');

// pdf.js is large, so it is only fetched the first time a PDF is opened.
let pdfjsLoader: Promise<PdfJs> | null = null;
const loadPdfJs = (): Promise<PdfJs> => {
  pdfjsLoader ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsLoader;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const PAGE_GUTTER = 24;

export interface ReceiptViewerProps {
  /** File name, shown in the header and used for downloads. */
  name: string;
  /** Object URL of the file. */
  url: string;
  kind: 'pdf' | 'image';
  onClose?: () => void;
  /** Receives the marked-up copy; the original file is never changed. */
  onSaveCopy?: (file: File) => Promise<void> | void;
}

type DisplaySize = { width: number; height: number };

const fileBaseName = (name: string) =>
  name.replace(/\.[^.]+$/, '') || 'receipt';

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });

/** Draws an image turned clockwise by `rotation` onto the canvas at `scale`. */
const drawRotatedImage = (
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  rotation: Rotation,
  scale: number,
) => {
  const turned = rotation === 90 || rotation === 270;
  const width = (turned ? image.naturalHeight : image.naturalWidth) * scale;
  const height = (turned ? image.naturalWidth : image.naturalHeight) * scale;
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);

  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(
    image,
    (-image.naturalWidth * scale) / 2,
    (-image.naturalHeight * scale) / 2,
    image.naturalWidth * scale,
    image.naturalHeight * scale,
  );
  context.restore();
};

const fillHighlights = (
  canvas: HTMLCanvasElement,
  highlights: Highlight[],
  offsetY = 0,
  height = canvas.height,
) => {
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = HIGHLIGHT_FILL;
  highlights.forEach((h) =>
    context.fillRect(
      h.x * canvas.width,
      offsetY + h.y * height,
      h.w * canvas.width,
      h.h * height,
    ),
  );
};

const printUrl = (url: string, kind: 'pdf' | 'image') => {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // Give the print dialog time to take its copy before removing the frame.
    setTimeout(() => frame.remove(), 60_000);
  };
  if (kind === 'pdf') {
    frame.src = url;
  } else {
    frame.srcdoc = `<!doctype html><title>Receipt</title><style>body{margin:0}img{max-width:100%}</style><img src="${url}" alt="">`;
  }
  document.body.appendChild(frame);
};

/**
 * Reads a receipt (PDF or image) inside a panel, with download and print in
 * the header and page, zoom, rotate and highlighter tools underneath.
 * Highlights can be saved as a marked-up copy; the original is kept as is.
 */
export function ReceiptViewer({
  name,
  url,
  kind,
  onClose,
  onSaveCopy,
}: ReceiptViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  // null means "fit the panel's width".
  const [scale, setScale] = useState<number | null>(null);
  const [fittedScale, setFittedScale] = useState(1);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [display, setDisplay] = useState<DisplaySize>({ width: 0, height: 0 });

  const [highlighting, setHighlighting] = useState(false);
  const [highlights, setHighlights] = useState<Record<number, Highlight[]>>({});
  const [drawing, setDrawing] = useState<{
    start: [number, number];
    end: [number, number];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const totalHighlights = Object.values(highlights).reduce(
    (sum, list) => sum + list.length,
    0,
  );

  // Load the file.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setLoadError(false);
    setPdf(null);
    setImage(null);
    setPage(1);
    setPageInput('1');
    setHighlights({});
    setSaved(false);

    const load = async () => {
      try {
        if (kind === 'pdf') {
          const pdfjs = await loadPdfJs();
          loaded = await pdfjs.getDocument({ url, isEvalSupported: false })
            .promise;
          if (cancelled) return;
          setPageCount(loaded.numPages);
          setPdf(loaded);
        } else {
          const img = await loadImage(url);
          if (cancelled) return;
          setPageCount(1);
          setImage(img);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    load();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [url, kind]);

  // Track the panel width so "fit width" follows it.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const observer = new ResizeObserver(([entry]) =>
      setStageWidth(entry.contentRect.width),
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Draw the current page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stageWidth || (!pdf && !image)) return undefined;
    let cancelled = false;
    const ratio = window.devicePixelRatio || 1;
    const fitWidth = Math.max(stageWidth - PAGE_GUTTER, 50);

    const draw = async () => {
      if (pdf) {
        const pdfPage = await pdf.getPage(page);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1, rotation });
        const effective = scale ?? fitWidth / base.width;
        const viewport = pdfPage.getViewport({
          scale: effective * ratio,
          rotation,
        });
        renderTaskRef.current?.cancel();
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const task = pdfPage.render({
          canvasContext: canvas.getContext('2d') as CanvasRenderingContext2D,
          viewport,
        });
        renderTaskRef.current = task;
        try {
          await task.promise;
        } catch {
          return; // Cancelled by a newer render.
        }
        if (cancelled) return;
        setFittedScale(effective);
        setDisplay({
          width: viewport.width / ratio,
          height: viewport.height / ratio,
        });
      } else if (image) {
        const turned = rotation === 90 || rotation === 270;
        const baseWidth = turned ? image.naturalHeight : image.naturalWidth;
        const effective = scale ?? fitWidth / baseWidth;
        drawRotatedImage(canvas, image, rotation, effective * ratio);
        setFittedScale(effective);
        setDisplay({
          width: canvas.width / ratio,
          height: canvas.height / ratio,
        });
      }
    };
    draw();
    return () => {
      cancelled = true;
    };
  }, [pdf, image, page, scale, rotation, stageWidth]);

  const goToPage = (target: number) => {
    const next = Math.min(Math.max(target, 1), pageCount);
    setPage(next);
    setPageInput(String(next));
  };

  const zoom = (factor: number) =>
    setScale(
      Math.min(Math.max((scale ?? fittedScale) * factor, MIN_SCALE), MAX_SCALE),
    );

  const pointerFraction = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    ] as [number, number];
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!highlighting) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerFraction(event);
    setDrawing({ start: point, end: point });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    setDrawing({ ...drawing, end: pointerFraction(event) });
  };

  const handlePointerUp = () => {
    if (!drawing) return;
    const added = highlightFromDisplay(drawing.start, drawing.end, rotation);
    setDrawing(null);
    // Ignore a click without a drag.
    if (added.w < 0.005 || added.h < 0.005) return;
    setSaved(false);
    setHighlights((previous) => ({
      ...previous,
      [page]: [...(previous[page] ?? []), added],
    }));
  };

  const undoHighlight = () => {
    setHighlights((previous) => ({
      ...previous,
      [page]: (previous[page] ?? []).slice(0, -1),
    }));
  };

  const clearHighlights = () => setHighlights({});

  /** Renders every page unrotated with its highlights into one PNG. */
  const buildMarkedUpCopy = useCallback(async (): Promise<File> => {
    const canvases: HTMLCanvasElement[] = [];

    if (pdf) {
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const pdfPage = await pdf.getPage(number);
        const viewport = pdfPage.getViewport({ scale: 2, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await pdfPage.render({
          canvasContext: canvas.getContext('2d') as CanvasRenderingContext2D,
          viewport,
        }).promise;
        fillHighlights(canvas, highlights[number] ?? []);
        canvases.push(canvas);
      }
    } else if (image) {
      const canvas = document.createElement('canvas');
      const cap = Math.min(1, 2400 / image.naturalWidth);
      drawRotatedImage(canvas, image, 0, cap);
      fillHighlights(canvas, highlights[1] ?? []);
      canvases.push(canvas);
    }

    const gap = 16;
    const sheet = document.createElement('canvas');
    sheet.width = Math.max(...canvases.map((c) => c.width));
    sheet.height =
      canvases.reduce((sum, c) => sum + c.height, 0) +
      gap * (canvases.length - 1);
    const context = sheet.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, sheet.width, sheet.height);
    let top = 0;
    canvases.forEach((c) => {
      context.drawImage(c, 0, top);
      top += c.height + gap;
    });

    const blob = await new Promise<Blob>((resolve, reject) =>
      sheet.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not save'))),
        'image/png',
      ),
    );
    return new File([blob], `${fileBaseName(name)} (marked up).png`, {
      type: 'image/png',
    });
  }, [pdf, image, highlights, name]);

  const handleSaveCopy = async () => {
    if (!onSaveCopy) return;
    setSaving(true);
    try {
      await onSaveCopy(await buildMarkedUpCopy());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const pageHighlights = (highlights[page] ?? []).map((h) =>
    highlightToDisplay(h, rotation),
  );
  const draft = drawing
    ? highlightToDisplay(
        highlightFromDisplay(drawing.start, drawing.end, rotation),
        rotation,
      )
    : null;
  const isLoading = !loadError && !pdf && !image;

  return (
    <section className={styles.viewer} aria-label={`Receipt ${name}`}>
      <header className={styles.header}>
        <span className={styles.name} title={name}>
          {name}
        </span>
        <div className={styles.headerActions}>
          <Tooltip content="Download" placement="bottom" minimal>
            <a
              className={`${Classes.BUTTON} ${Classes.MINIMAL} ${styles.headerButton}`}
              href={url}
              download={name}
              aria-label="Download"
            >
              <Icon icon="download" />
            </a>
          </Tooltip>
          <Tooltip content="Print" placement="bottom" minimal>
            <Button
              minimal
              icon="print"
              aria-label="Print"
              className={styles.headerButton}
              onClick={() => printUrl(url, kind)}
            />
          </Tooltip>
          {onClose && (
            <>
              <span className={styles.divider} aria-hidden />
              <Tooltip content="Close" placement="bottom" minimal>
                <Button
                  minimal
                  icon="cross"
                  aria-label="Close receipt"
                  className={styles.headerButton}
                  onClick={onClose}
                />
              </Tooltip>
            </>
          )}
        </div>
      </header>

      <div ref={stageRef} className={styles.stage}>
        {isLoading && (
          <div className={styles.message}>
            <Spinner size={22} />
          </div>
        )}
        {loadError && (
          <div className={styles.message} role="alert">
            This file could not be shown. You can still download it.
          </div>
        )}
        <div
          className={styles.page}
          style={{
            width: display.width || undefined,
            height: display.height || undefined,
            visibility: isLoading || loadError ? 'hidden' : 'visible',
          }}
        >
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={{ width: display.width, height: display.height }}
          />
          <div
            className={`${styles.overlay} ${highlighting ? styles.overlayActive : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDrawing(null)}
          >
            {[...pageHighlights, ...(draft ? [draft] : [])].map((h, i) => (
              <span
                // Highlights have no identity beyond their order on the page.
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                className={styles.highlight}
                style={{
                  left: `${h.x * 100}%`,
                  top: `${h.y * 100}%`,
                  width: `${h.w * 100}%`,
                  height: `${h.h * 100}%`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {totalHighlights > 0 && onSaveCopy && (
        <div className={styles.markupBar}>
          <span>
            {totalHighlights} highlight{totalHighlights === 1 ? '' : 's'}
            {saved ? ' - copy added to attachments' : ''}
          </span>
          <Button small minimal icon="undo" onClick={undoHighlight}>
            Undo
          </Button>
          <Button small minimal onClick={clearHighlights}>
            Clear
          </Button>
          <Button
            small
            intent={Intent.PRIMARY}
            loading={saving}
            disabled={saved}
            onClick={handleSaveCopy}
          >
            Save marked-up copy
          </Button>
        </div>
      )}

      <footer className={styles.toolbar} aria-label="Receipt tools">
        <input
          className={styles.pageInput}
          aria-label="Page"
          value={pageInput}
          inputMode="numeric"
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goToPage(Number(pageInput) || page)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goToPage(Number(pageInput) || page);
          }}
        />
        <span className={styles.pageCount}>/ {pageCount}</span>
        <Tool
          icon="arrow-up"
          label="Previous page"
          disabled={page <= 1}
          onClick={() => goToPage(page - 1)}
        />
        <Tool
          icon="arrow-down"
          label="Next page"
          disabled={page >= pageCount}
          onClick={() => goToPage(page + 1)}
        />
        <span className={styles.toolDivider} aria-hidden />
        <Tool icon="zoom-out" label="Zoom out" onClick={() => zoom(0.8)} />
        <Tool icon="zoom-in" label="Zoom in" onClick={() => zoom(1.25)} />
        <Tool
          icon="zoom-to-fit"
          label="Fit to width"
          active={scale === null}
          onClick={() => setScale(null)}
        />
        <span className={styles.toolDivider} aria-hidden />
        <Tool
          icon="image-rotate-right"
          label="Rotate"
          onClick={() => setRotation(((rotation + 90) % 360) as Rotation)}
        />
        <Tool
          icon="highlight"
          label={highlighting ? 'Stop highlighting' : 'Highlight'}
          active={highlighting}
          onClick={() => setHighlighting(!highlighting)}
        />
      </footer>
    </section>
  );
}

function Tool({
  icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: React.ComponentProps<typeof Button>['icon'];
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip content={label} placement="top" minimal>
      <Button
        minimal
        small
        icon={icon}
        aria-label={label}
        aria-pressed={active}
        active={active}
        disabled={disabled}
        className={styles.tool}
        onClick={onClick}
      />
    </Tooltip>
  );
}
