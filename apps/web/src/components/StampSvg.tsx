import { useEffect, useState } from 'react';
import { layoutStamp, type Measure, type StampLine, type StampStyle } from '../lib/stampStyle';
import { STAMP_FONT_FAMILY, loadPreviewMeasure } from '../lib/stampFonts';

interface Props {
  style: StampStyle;
  lines: StampLine[];
  /** Размер штампа в пунктах PDF. */
  width: number;
  height: number;
  className?: string;
}

/** Рисует штамп по тем же примитивам, что уходят в PDF. */
export function StampSvg({ style, lines, width, height, className }: Props) {
  const [measure, setMeasure] = useState<Measure | null>(null);
  useEffect(() => {
    let alive = true;
    loadPreviewMeasure().then((m) => alive && setMeasure(() => m), () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!measure) return <svg className={className} viewBox={`0 0 ${width} ${height}`} />;

  const layout = layoutStamp(style, lines, width, height, measure);
  const flip = (y: number, h = 0) => height - y - h;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height="100%"
    >
      {!layout && (
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={8} fill="#9a3324">
          Реквизиты не помещаются
        </text>
      )}
      {layout?.ops.map((op, i) => {
        if (op.t === 'rect') {
          return (
            <rect
              key={i}
              x={op.x}
              y={flip(op.y, op.h)}
              width={op.w}
              height={op.h}
              rx={op.r}
              fill={op.fill ?? 'none'}
              stroke={op.stroke ?? 'none'}
              strokeWidth={op.lw}
            />
          );
        }
        if (op.t === 'image') {
          return (
            <image
              key={i}
              href={style.image!.dataUrl}
              x={op.x}
              y={flip(op.y, op.h)}
              width={op.w}
              height={op.h}
              preserveAspectRatio="none"
            />
          );
        }
        return (
          <text
            key={i}
            x={op.x}
            y={flip(op.y)}
            fontFamily={STAMP_FONT_FAMILY}
            fontWeight={op.bold ? 700 : 400}
            fontSize={op.size}
            fill={op.color}
            textLength={op.width}
            lengthAdjust="spacingAndGlyphs"
          >
            {op.text}
          </text>
        );
      })}
    </svg>
  );
}
