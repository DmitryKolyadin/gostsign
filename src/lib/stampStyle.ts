/**
 * Внешний вид штампа: сериализуемая модель стиля, пресеты и единый движок
 * раскладки. Результат `layoutStamp` — список примитивов в пунктах PDF
 * (начало координат — левый нижний угол штампа). Его рисуют и PDF-рендер,
 * и SVG-превью, поэтому превью совпадает с итоговым документом.
 */

export type FieldId = 'title' | 'serial' | 'owner' | 'validity' | 'signedAt' | 'extra';
export type PresetId = 'classic' | 'gost' | 'minimal' | 'compact';
export type StampLayout = 'text' | 'image-left' | 'image-top';

export interface StampImage {
  /** PNG в виде data URL. */
  dataUrl: string;
  width: number;
  height: number;
  /** Доля ширины (image-left) или высоты (image-top) штампа под картинку. */
  ratio: number;
}

export interface StampStyle {
  version: 1;
  preset: PresetId | 'custom';
  colors: {
    accent: string;
    title: string;
    text: string;
    /** null — прозрачный фон. */
    background: string | null;
  };
  border: {
    width: number;
    radius: number;
    double: boolean;
    accentBar: boolean;
  };
  layout: StampLayout;
  align: 'left' | 'center';
  fields: { id: FieldId; enabled: boolean }[];
  titleText: string;
  extraLines: string[];
  image: StampImage | null;
  maxFontSize: number;
}

export const FIELD_LABELS: Record<FieldId, string> = {
  title: 'Заголовок',
  serial: 'Серийный номер сертификата',
  owner: 'Владелец',
  validity: 'Срок действия',
  signedAt: 'Дата подписания',
  extra: 'Дополнительные строки',
};

const DEFAULT_TITLE = 'Документ подписан электронной подписью';

const fields = (...on: FieldId[]): StampStyle['fields'] => {
  const all: FieldId[] = ['title', 'serial', 'owner', 'validity', 'signedAt', 'extra'];
  return [...on, ...all.filter((f) => !on.includes(f))].map((id) => ({ id, enabled: on.includes(id) }));
};

export const PRESETS: Record<PresetId, { name: string; size: [number, number]; style: StampStyle }> = {
  classic: {
    name: 'Классический',
    size: [190, 66],
    style: {
      version: 1,
      preset: 'classic',
      colors: { accent: '#213354', title: '#213354', text: '#1a1a1a', background: '#ffffff' },
      border: { width: 0.8, radius: 0, double: false, accentBar: true },
      layout: 'text',
      align: 'left',
      fields: fields('title', 'serial', 'owner', 'validity'),
      titleText: DEFAULT_TITLE,
      extraLines: [],
      image: null,
      maxFontSize: 9,
    },
  },
  gost: {
    name: 'ГОСТ-рамка',
    size: [200, 74],
    style: {
      version: 1,
      preset: 'gost',
      colors: { accent: '#1f3c88', title: '#1f3c88', text: '#1f3c88', background: '#ffffff' },
      border: { width: 1.2, radius: 4, double: true, accentBar: false },
      layout: 'text',
      align: 'center',
      fields: fields('title', 'serial', 'owner', 'validity'),
      titleText: 'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
      extraLines: [],
      image: null,
      maxFontSize: 9,
    },
  },
  minimal: {
    name: 'Минимал',
    size: [190, 60],
    style: {
      version: 1,
      preset: 'minimal',
      colors: { accent: '#555555', title: '#1a1a1a', text: '#444444', background: null },
      border: { width: 0, radius: 0, double: false, accentBar: false },
      layout: 'text',
      align: 'left',
      fields: fields('title', 'owner', 'serial', 'validity'),
      titleText: 'Подписано ЭП',
      extraLines: [],
      image: null,
      maxFontSize: 9,
    },
  },
  compact: {
    name: 'Компактный',
    size: [160, 44],
    style: {
      version: 1,
      preset: 'compact',
      colors: { accent: '#2f6b46', title: '#2f6b46', text: '#1a1a1a', background: '#ffffff' },
      border: { width: 0.6, radius: 3, double: false, accentBar: false },
      layout: 'text',
      align: 'left',
      fields: fields('owner', 'serial'),
      titleText: DEFAULT_TITLE,
      extraLines: [],
      image: null,
      maxFontSize: 8,
    },
  },
};

export const DEFAULT_STYLE = PRESETS.classic.style;

export function stampDefaultSize(style: StampStyle): [number, number] {
  return style.preset === 'custom' ? PRESETS.classic.size : PRESETS[style.preset].size;
}

/* ------------------------------------------------------------------ */
/* Строки                                                              */
/* ------------------------------------------------------------------ */

export interface StampData {
  serialNumber: string;
  ownerName: string;
  validFrom: Date;
  validTo: Date;
}

export interface StampLine {
  text: string;
  bold: boolean;
}

function two(n: number) {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function resolveLines(style: StampStyle, data: StampData | null, signedAt: Date): StampLine[] {
  const out: StampLine[] = [];
  for (const f of style.fields) {
    if (!f.enabled) continue;
    switch (f.id) {
      case 'title':
        if (style.titleText.trim()) out.push({ text: style.titleText.trim(), bold: true });
        break;
      case 'serial':
        out.push({ text: `Сертификат: ${data?.serialNumber ?? '—'}`, bold: false });
        break;
      case 'owner':
        out.push({ text: `Владелец: ${data?.ownerName ?? '—'}`, bold: false });
        break;
      case 'validity':
        out.push({
          text: data
            ? `Действителен с ${formatDate(data.validFrom)} по ${formatDate(data.validTo)}`
            : 'Действителен с —',
          bold: false,
        });
        break;
      case 'signedAt':
        out.push({
          text: `Дата подписания: ${formatDate(signedAt)} ${two(signedAt.getHours())}:${two(signedAt.getMinutes())}`,
          bold: false,
        });
        break;
      case 'extra':
        for (const l of style.extraLines) if (l.trim()) out.push({ text: l.trim(), bold: false });
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Раскладка                                                           */
/* ------------------------------------------------------------------ */

export const MIN_FONT_SIZE = 5;
const PAD_X = 6;
const PAD_Y = 5;
const LINE_HEIGHT = 1.35;

export type Measure = (text: string, size: number, bold: boolean) => number;

export type StampOp =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'text'; x: number; y: number; size: number; bold: boolean; color: string; text: string; width: number }
  | { t: 'image'; x: number; y: number; w: number; h: number };

export interface StampLayoutResult {
  fontSize: number;
  ops: StampOp[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Возвращает null, если реквизиты не влезают читаемым кеглем. */
export function layoutStamp(
  style: StampStyle,
  lines: StampLine[],
  width: number,
  height: number,
  measure: Measure,
): StampLayoutResult | null {
  const ops: StampOp[] = [];
  const { border, colors } = style;
  const bw = border.width;

  // подложка и рамка
  const inset = Math.max(0.4, bw / 2);
  const frame = { x: inset, y: inset, w: width - inset * 2, h: height - inset * 2 };
  if (colors.background || bw > 0) {
    ops.push({
      t: 'rect',
      ...frame,
      r: border.radius,
      fill: colors.background ?? undefined,
      stroke: bw > 0 ? colors.accent : undefined,
      lw: bw,
    });
  }
  let content: Box = { x: 0, y: 0, w: width, h: height };
  if (bw > 0 && border.double) {
    const d = bw * 2 + 1;
    ops.push({
      t: 'rect',
      x: frame.x + d,
      y: frame.y + d,
      w: frame.w - d * 2,
      h: frame.h - d * 2,
      r: Math.max(0, border.radius - d),
      stroke: colors.accent,
      lw: Math.max(0.3, bw / 2),
    });
    content = { x: d, y: d, w: width - d * 2, h: height - d * 2 };
  }
  if (border.accentBar) {
    ops.push({ t: 'rect', x: 1.6, y: 1.6, w: 2, h: height - 3.2, r: 0, fill: colors.accent });
    content = { ...content, x: content.x + 3, w: content.w - 3 };
  }

  // картинка
  let text: Box = { x: content.x + PAD_X, y: content.y + PAD_Y, w: content.w - PAD_X * 2, h: content.h - PAD_Y * 2 };
  const img = style.image;
  if (img && style.layout !== 'text') {
    const aspect = img.width / img.height;
    if (style.layout === 'image-left') {
      const slot = { x: text.x, y: text.y, w: text.w * img.ratio, h: text.h };
      const box = fitInto(slot, aspect);
      ops.push({ t: 'image', ...box });
      text = { ...text, x: slot.x + slot.w + PAD_X, w: text.w - slot.w - PAD_X };
    } else {
      const slotH = text.h * img.ratio;
      const slot = { x: text.x, y: text.y + text.h - slotH, w: text.w, h: slotH };
      const box = fitInto(slot, aspect);
      ops.push({ t: 'image', ...box });
      text = { ...text, h: text.h - slotH - 2 };
    }
  }

  if (!lines.length) return { fontSize: 0, ops };
  if (text.w <= 0 || text.h <= 0) return null;

  // кегль
  let size = 0;
  let widths: number[] = [];
  for (let s = style.maxFontSize; s >= MIN_FONT_SIZE; s -= 0.25) {
    if (s * LINE_HEIGHT * lines.length > text.h) continue;
    widths = lines.map((l) => measure(l.text, s, l.bold));
    if (Math.max(...widths) > text.w) continue;
    size = s;
    break;
  }
  if (!size) return null;

  const lineHeight = size * LINE_HEIGHT;
  const blockHeight = lineHeight * lines.length;
  let y = text.y + (text.h + blockHeight) / 2 - lineHeight + size * 0.25;
  lines.forEach((l, i) => {
    const x = style.align === 'center' ? text.x + (text.w - widths[i]) / 2 : text.x;
    ops.push({
      t: 'text',
      x,
      y,
      size,
      bold: l.bold,
      color: l.bold ? colors.title : colors.text,
      text: l.text,
      width: widths[i],
    });
    y -= lineHeight;
  });
  return { fontSize: size, ops };
}

function fitInto(slot: Box, aspect: number): Box {
  let w = slot.w;
  let h = w / aspect;
  if (h > slot.h) {
    h = slot.h;
    w = h * aspect;
  }
  return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h };
}

/* ------------------------------------------------------------------ */
/* Хранение, импорт и экспорт                                          */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'gostsign.stampStyle';
const HEX = /^#[0-9a-f]{6}$/i;

/** Проверяет и нормализует произвольный JSON; бросает Error с понятным текстом. */
export function parseStyle(raw: unknown): StampStyle {
  const s = raw as Partial<StampStyle> | null;
  if (!s || typeof s !== 'object' || s.version !== 1) {
    throw new Error('Это не профиль штампа ГостSign (ожидается version: 1)');
  }
  const base = DEFAULT_STYLE;
  const color = (v: unknown, fb: string) => (typeof v === 'string' && HEX.test(v) ? v : fb);
  const num = (v: unknown, fb: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
  const ids = Object.keys(FIELD_LABELS) as FieldId[];
  const seen = new Set<FieldId>();
  const fieldList = (Array.isArray(s.fields) ? s.fields : [])
    .filter((f) => f && ids.includes(f.id) && !seen.has(f.id) && seen.add(f.id))
    .map((f) => ({ id: f.id, enabled: !!f.enabled }));
  for (const id of ids) if (!seen.has(id)) fieldList.push({ id, enabled: false });
  const img = s.image;
  return {
    version: 1,
    preset: s.preset && (s.preset === 'custom' || s.preset in PRESETS) ? s.preset : 'custom',
    colors: {
      accent: color(s.colors?.accent, base.colors.accent),
      title: color(s.colors?.title, base.colors.title),
      text: color(s.colors?.text, base.colors.text),
      background: s.colors?.background === null ? null : color(s.colors?.background, '#ffffff'),
    },
    border: {
      width: num(s.border?.width, base.border.width, 0, 4),
      radius: num(s.border?.radius, 0, 0, 20),
      double: !!s.border?.double,
      accentBar: !!s.border?.accentBar,
    },
    layout: s.layout === 'image-left' || s.layout === 'image-top' ? s.layout : 'text',
    align: s.align === 'center' ? 'center' : 'left',
    fields: fieldList,
    titleText: typeof s.titleText === 'string' ? s.titleText.slice(0, 120) : base.titleText,
    extraLines: Array.isArray(s.extraLines)
      ? s.extraLines.filter((l): l is string => typeof l === 'string').slice(0, 4).map((l) => l.slice(0, 120))
      : [],
    image:
      img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/png;base64,') &&
      img.width > 0 && img.height > 0
        ? { dataUrl: img.dataUrl, width: img.width, height: img.height, ratio: num(img.ratio, 0.3, 0.1, 0.7) }
        : null,
    maxFontSize: num(s.maxFontSize, 9, MIN_FONT_SIZE, 14),
  };
}

export function loadStyle(): StampStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parseStyle(JSON.parse(raw));
  } catch {
    /* повреждённый профиль — молча откатываемся на классику */
  }
  return DEFAULT_STYLE;
}

export function saveStyle(style: StampStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* приватный режим или переполнение — не критично */
  }
}
