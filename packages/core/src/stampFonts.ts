/**
 * Шрифты штампа. Превью меряет текст тем же fontkit и теми же TTF, что и
 * pdf-lib при встраивании, — поэтому кегль в превью и в PDF совпадает.
 */
import fontkit from '@pdf-lib/fontkit';
import type { Measure } from './stampStyle';
import { assetUrl, getConfig } from './config';

export const STAMP_FONT_FAMILY = 'GostSignStamp';

let buffers: Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> | null = null;

export function loadStampFontBuffers() {
  if (!buffers) {
    const custom = getConfig().loadFonts;
    buffers = custom
      ? custom()
      : Promise.all([fetchFont('fonts/PTSans-Regular.ttf'), fetchFont('fonts/PTSans-Bold.ttf')]).then(
          ([regular, bold]) => ({ regular, bold }),
        );
    buffers.catch(() => (buffers = null));
  }
  return buffers;
}

async function fetchFont(path: string): Promise<ArrayBuffer> {
  const url = assetUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Шрифт штампа недоступен: ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

let measure: Promise<Measure> | null = null;

/** Функция замера для превью; заодно регистрирует шрифт для SVG. */
export function loadPreviewMeasure(): Promise<Measure> {
  if (!measure) {
    measure = loadStampFontBuffers().then(async ({ regular, bold }) => {
      const r = fontkit.create(new Uint8Array(regular));
      const b = fontkit.create(new Uint8Array(bold));
      const faces = [
        new FontFace(STAMP_FONT_FAMILY, regular.slice(0), { weight: '400' }),
        new FontFace(STAMP_FONT_FAMILY, bold.slice(0), { weight: '700' }),
      ];
      await Promise.all(faces.map((f) => f.load()));
      faces.forEach((f) => document.fonts.add(f));
      return (text, size, isBold) => {
        const font = isBold ? b : r;
        const { glyphs } = font.layout(text);
        const units = glyphs.reduce((sum, g) => sum + g.advanceWidth, 0);
        return (units / font.unitsPerEm) * size;
      };
    });
    measure.catch(() => (measure = null));
  }
  return measure;
}
