import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { StampPlacement } from '../lib/pdfSign';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  pdfBytes: Uint8Array;
  pageIndex: number;
  onPagesLoaded: (sizes: { width: number; height: number }[]) => void;
  placement: StampPlacement | null;
  onPlacementChange: (p: StampPlacement) => void;
  stampLines: string[];
  occupied: [number, number, number, number][];
  overlapWarning: boolean;
}

const VIEW_WIDTH = 620;

export function PdfPreview({
  pdfBytes,
  pageIndex,
  onPagesLoaded,
  placement,
  onPlacementChange,
  stampLines,
  occupied,
  overlapWarning,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; orig: StampPlacement } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    let task: pdfjsLib.PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        task = pdfjsLib.getDocument({ data: pdfBytes.slice() });
        const doc = await task.promise;
        if (cancelled) return;
        const sizes: { width: number; height: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          sizes.push({ width: vp.width, height: vp.height });
        }
        onPagesLoaded(sizes);

        const page = await doc.getPage(Math.min(pageIndex + 1, doc.numPages));
        const base = page.getViewport({ scale: 1 });
        const s = VIEW_WIDTH / base.width;
        const viewport = page.getViewport({ scale: s * window.devicePixelRatio });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${VIEW_WIDTH}px`;
        canvas.style.height = `${base.height * s}px`;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        setScale(s);
        setPageSize({ width: base.width, height: base.height });
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
      task?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes, pageIndex]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !placement) return;
      const dx = (e.clientX - d.sx) / scale;
      const dy = (e.clientY - d.sy) / scale;
      if (d.mode === 'move') {
        onPlacementChange({
          ...d.orig,
          x: clamp(d.orig.x + dx, 0, pageSize.width - d.orig.width),
          y: clamp(d.orig.y - dy, 0, pageSize.height - d.orig.height),
        });
      } else {
        // ручка в правом нижнем углу: тянем вправо-вниз, верхняя грань на месте
        const top = d.orig.y + d.orig.height;
        const width = clamp(d.orig.width + dx, 100, pageSize.width - d.orig.x);
        const height = clamp(d.orig.height + dy, 36, top);
        onPlacementChange({ ...d.orig, width, height, y: top - height });
      }
    };
    const onUp = () => (drag.current = null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [placement, scale, pageSize, onPlacementChange]);

  const start = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!placement) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: placement };
  };

  const toPx = (r: [number, number, number, number]) => ({
    left: r[0] * scale,
    top: (pageSize.height - r[3]) * scale,
    width: (r[2] - r[0]) * scale,
    height: (r[3] - r[1]) * scale,
  });

  return (
    <div className="preview">
      {error && <div className="notice notice--error">Не удалось отрисовать страницу: {error}</div>}
      <div className="preview__paper" style={{ width: VIEW_WIDTH }}>
        <canvas ref={canvasRef} className="preview__canvas" />
        {occupied.map((r, i) => (
          <div key={i} className="stampbox stampbox--taken" style={toPx(r)}>
            <span>подпись уже здесь</span>
          </div>
        ))}
        {placement && (
          <div
            ref={boxRef}
            className={'stampbox stampbox--active' + (overlapWarning ? ' stampbox--bad' : '')}
            style={toPx([
              placement.x,
              placement.y,
              placement.x + placement.width,
              placement.y + placement.height,
            ])}
            onPointerDown={start('move')}
          >
            <div className="stampbox__inner">
              {stampLines.map((l, i) => (
                <div key={i} className={i === 0 ? 'stampbox__title' : 'stampbox__line'}>
                  {l}
                </div>
              ))}
            </div>
            <div className="stampbox__handle" onPointerDown={start('resize')} />
          </div>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
