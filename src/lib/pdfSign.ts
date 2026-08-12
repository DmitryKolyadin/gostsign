/**
 * Ядро проекта: incremental update PDF со словарём подписи и штампом,
 * с плейсхолдером /Contents и точным /ByteRange.
 *
 * Исходные байты документа НИКОГДА не меняются — только дописываются новые.
 * Поэтому ранее поставленные подписи остаются валидными.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { CADESCOM } from './cades';

export const PLACEHOLDER_BES = 32 * 1024;
export const PLACEHOLDER_T = 64 * 1024;

export interface StampData {
  serialNumber: string;
  ownerName: string;
  validFrom: Date;
  validTo: Date;
}

export interface StampPlacement {
  pageIndex: number;
  /** Координаты в пунктах PDF, начало отсчёта — левый нижний угол страницы. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrepareOptions {
  stamp: StampData;
  placement: StampPlacement | null;
  useTsa: boolean;
  signerName: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
}

export interface PreparedPdf {
  /** Полный файл с плейсхолдером. */
  bytes: Uint8Array;
  /** Смещение символа `<` в /Contents. */
  contentsStart: number;
  /** Смещение сразу после `>`. */
  contentsEnd: number;
  /** Размер плейсхолдера в байтах подписи. */
  placeholderBytes: number;
  /** Байты, покрытые /ByteRange — именно они уходят в плагин. */
  dataToSign: Uint8Array;
  fieldName: string;
}

export class PdfSignError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PdfSignError';
    this.hint = hint;
  }
}

const enc = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: string, from: number): number {
  const n = enc.encode(needle);
  outer: for (let i = from; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

/** Строка PDF в UTF-16BE hex — единственный надёжный способ для кириллицы. */
function pdfTextString(value: string): string {
  let hex = 'FEFF';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function two(n: number) {
  return String(n).padStart(2, '0');
}

export function formatDate(d: Date): string {
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** /M — дата подписания в формате PDF. */
function pdfDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = two(Math.floor(Math.abs(off) / 60));
  const om = two(Math.abs(off) % 60);
  return (
    `D:${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}${sign}${oh}'${om}'`
  );
}

/* ------------------------------------------------------------------ */
/* Штамп по ГОСТ Р 7.0.97-2016, п. 5.23                                */
/* ------------------------------------------------------------------ */

export const MIN_STAMP_WIDTH = 120;
export const MIN_STAMP_HEIGHT = 44;
export const MIN_FONT_SIZE = 5;
export const DEFAULT_STAMP_WIDTH = 190;
export const DEFAULT_STAMP_HEIGHT = 66;

export function stampLines(data: StampData): string[] {
  return [
    'Документ подписан электронной подписью',
    `Сертификат: ${data.serialNumber}`,
    `Владелец: ${data.ownerName}`,
    `Действителен с ${formatDate(data.validFrom)} по ${formatDate(data.validTo)}`,
  ];
}

/** Подбирает кегль так, чтобы все реквизиты влезли и не наезжали друг на друга. */
export function fitStampFontSize(
  lines: string[],
  width: number,
  height: number,
  measure: (text: string, size: number) => number,
): number {
  const padX = 6;
  const padY = 5;
  for (let size = 9; size >= MIN_FONT_SIZE; size -= 0.25) {
    const lineHeight = size * 1.35;
    if (padY * 2 + lineHeight * lines.length > height) continue;
    const maxWidth = Math.max(...lines.map((l) => measure(l, size)));
    if (maxWidth > width - padX * 2) continue;
    return size;
  }
  return 0;
}

function buildStampContent(
  lines: string[],
  regular: PDFFont,
  bold: PDFFont,
  width: number,
  height: number,
): string {
  const size = fitStampFontSize(lines, width, height, (t, s) => regular.widthOfTextAtSize(t, s));
  if (!size) {
    throw new PdfSignError(
      'Штамп слишком мал: реквизиты не помещаются читаемым кеглем',
      `Увеличьте прямоугольник штампа (минимум ${MIN_STAMP_WIDTH}×${MIN_STAMP_HEIGHT} пт).`,
    );
  }
  const padX = 6;
  const lineHeight = size * 1.35;
  const blockHeight = lineHeight * lines.length;
  let y = (height + blockHeight) / 2 - lineHeight + size * 0.25;

  const ops: string[] = [];
  ops.push('q');
  // подложка и рамка
  ops.push('1 1 1 rg');
  ops.push(`0.4 0.4 ${(width - 0.8).toFixed(2)} ${(height - 0.8).toFixed(2)} re f`);
  ops.push('0.13 0.20 0.33 RG');
  ops.push('0.8 w');
  ops.push(`0.4 0.4 ${(width - 0.8).toFixed(2)} ${(height - 0.8).toFixed(2)} re S`);
  ops.push('0.13 0.20 0.33 rg');
  ops.push(`1.6 1.6 2 ${(height - 3.2).toFixed(2)} re f`);

  ops.push('BT');
  lines.forEach((line, i) => {
    const font = i === 0 ? bold : regular;
    const alias = i === 0 ? '/FB' : '/FR';
    ops.push(`${alias} ${size.toFixed(2)} Tf`);
    ops.push(i === 0 ? '0.13 0.20 0.33 rg' : '0.10 0.10 0.10 rg');
    ops.push(`1 0 0 1 ${(padX + 3).toFixed(2)} ${y.toFixed(2)} Tm`);
    ops.push(`${font.encodeText(line).toString()} Tj`);
    y -= lineHeight;
  });
  ops.push('ET');
  ops.push('Q');
  return ops.join('\n');
}

/* ------------------------------------------------------------------ */
/* Разбор существующих подписей                                        */
/* ------------------------------------------------------------------ */

export interface ExistingSignature {
  fieldName: string;
  pageIndex: number | null;
  rect: [number, number, number, number] | null;
  signedAt: string | null;
  signerName: string | null;
  subFilter: string | null;
}

export function readExistingSignatures(doc: PDFDocument): ExistingSignature[] {
  const out: ExistingSignature[] = [];
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return out;
  const fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return out;

  const pageRefs = doc.getPages().map((p) => doc.context.getObjectRef(p.node));

  for (let i = 0; i < fields.size(); i++) {
    const field = fields.lookup(i, PDFDict);
    if (!field) continue;
    const ft = field.get(PDFName.of('FT'));
    if (!(ft instanceof PDFName) || ft.asString() !== '/Sig') continue;

    const name = field.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString);
    const rectArr = field.lookupMaybe(PDFName.of('Rect'), PDFArray);
    const rect = rectArr
      ? ([0, 1, 2, 3].map((k) => (rectArr.lookup(k, PDFNumber)?.asNumber() ?? 0)) as [
          number,
          number,
          number,
          number,
        ])
      : null;

    const pRef = field.get(PDFName.of('P'));
    let pageIndex: number | null = null;
    if (pRef instanceof PDFRef) {
      const idx = pageRefs.findIndex((r) => r?.tag === pRef.tag);
      pageIndex = idx >= 0 ? idx : null;
    }

    const sig = field.lookupMaybe(PDFName.of('V'), PDFDict);
    const sub = sig?.get(PDFName.of('SubFilter'));
    out.push({
      fieldName: name ? decodePdfString(name) : `(поле ${i + 1})`,
      pageIndex,
      rect,
      signedAt: sig ? decodeMaybeString(sig.get(PDFName.of('M'))) : null,
      signerName: sig ? decodeMaybeString(sig.get(PDFName.of('Name'))) : null,
      subFilter: sub instanceof PDFName ? sub.asString() : null,
    });
  }
  return out;
}

function decodePdfString(s: PDFString | PDFHexString): string {
  const raw = s.decodeText();
  return raw;
}

function decodeMaybeString(o: PDFObject | undefined): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return null;
}

/** Прямоугольники уже занятых полей подписи на странице. */
export function occupiedRects(
  signatures: ExistingSignature[],
  pageIndex: number,
): [number, number, number, number][] {
  return signatures
    .filter((s) => s.pageIndex === pageIndex && s.rect)
    .map((s) => s.rect!) as [number, number, number, number][];
}

export function rectsOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
}

/** Ищет свободное место для нового штампа, не пересекая существующие. */
export function findFreeSpot(
  taken: [number, number, number, number][],
  pageWidth: number,
  pageHeight: number,
  w: number,
  h: number,
): { x: number; y: number } {
  const margin = 28;
  const step = h + 10;
  for (let y = margin; y + h < pageHeight - margin; y += step) {
    for (const x of [margin, pageWidth - w - margin]) {
      if (x < 0) continue;
      const candidate: [number, number, number, number] = [x, y, x + w, y + h];
      if (!taken.some((t) => rectsOverlap(candidate, t))) return { x, y };
    }
  }
  return { x: margin, y: margin };
}

/* ------------------------------------------------------------------ */
/* Фаза 1 — заготовка                                                  */
/* ------------------------------------------------------------------ */

interface Emitted {
  ref: PDFRef;
  obj: PDFObject | null;
  raw?: Uint8Array;
}

function serializeObject(e: Emitted): Uint8Array {
  const header = enc.encode(`${e.ref.objectNumber} ${e.ref.generationNumber} obj\n`);
  let body: Uint8Array;
  if (e.raw) {
    body = e.raw;
  } else {
    const size = e.obj!.sizeInBytes();
    body = new Uint8Array(size);
    e.obj!.copyBytesInto(body, 0);
  }
  return concat([header, body, enc.encode('\nendobj\n')]);
}

async function loadStampFonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  doc.registerFontkit(fontkit);
  const base = import.meta.env.BASE_URL;
  const [r, b] = await Promise.all([
    fetch(`${base}fonts/PTSans-Regular.ttf`).then((x) => x.arrayBuffer()),
    fetch(`${base}fonts/PTSans-Bold.ttf`).then((x) => x.arrayBuffer()),
  ]);
  const regular = await doc.embedFont(r, { subset: true });
  const bold = await doc.embedFont(b, { subset: true });
  return { regular, bold };
}

export async function preparePdf(
  original: Uint8Array,
  opts: PrepareOptions,
): Promise<PreparedPdf> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/encrypt/i.test(msg)) {
      throw new PdfSignError(
        'PDF защищён паролем (зашифрован)',
        'Снимите шифрование документа и повторите подписание.',
      );
    }
    throw new PdfSignError('Не удалось разобрать PDF: файл повреждён', msg);
  }

  const ctx = doc.context;
  const origLargest = ctx.largestObjectNumber;
  const changed = new Map<string, Emitted>();
  const mark = (ref: PDFRef, obj: PDFObject | null, raw?: Uint8Array) =>
    changed.set(ref.tag, { ref, obj, raw });

  const catalogRef = ctx.trailerInfo.Root as PDFRef;
  if (!(catalogRef instanceof PDFRef)) {
    throw new PdfSignError('В PDF отсутствует корректная ссылка на каталог документа');
  }
  const catalog = doc.catalog;

  const existing = readExistingSignatures(doc);
  const fieldName = nextFieldName(existing.map((s) => s.fieldName));

  /* ---- AcroForm ---- */
  let acroRef: PDFRef;
  let acro: PDFDict;
  const acroEntry = catalog.get(PDFName.of('AcroForm'));
  if (acroEntry instanceof PDFRef) {
    acroRef = acroEntry;
    acro = ctx.lookup(acroEntry, PDFDict);
  } else if (acroEntry instanceof PDFDict) {
    // инлайновый AcroForm — выносим в отдельный объект, каталог всё равно меняем
    acro = acroEntry;
    acroRef = ctx.register(acro);
    catalog.set(PDFName.of('AcroForm'), acroRef);
  } else {
    acro = ctx.obj({}) as PDFDict;
    acroRef = ctx.register(acro);
    catalog.set(PDFName.of('AcroForm'), acroRef);
  }
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  let fieldsOwner: PDFRef = acroRef;
  const fieldsEntry = acro.get(PDFName.of('Fields'));
  if (fieldsEntry instanceof PDFRef) fieldsOwner = fieldsEntry;
  if (!fields) {
    fields = ctx.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
    fieldsOwner = acroRef;
  }

  /* ---- Шрифты и штамп ---- */
  const pages = doc.getPages();
  const placement = opts.placement;
  let apRef: PDFRef | null = null;
  let rect: [number, number, number, number] = [0, 0, 0, 0];
  let pageRef: PDFRef | null = null;

  if (placement) {
    const page = pages[placement.pageIndex];
    if (!page) throw new PdfSignError('Указана несуществующая страница документа');
    pageRef = ctx.getObjectRef(page.node)!;
    rect = [
      placement.x,
      placement.y,
      placement.x + placement.width,
      placement.y + placement.height,
    ];

    const { regular, bold } = await loadStampFonts(doc);
    const content = buildStampContent(
      stampLines(opts.stamp),
      regular,
      bold,
      placement.width,
      placement.height,
    );

    const resources = ctx.obj({
      Font: ctx.obj({ FR: regular.ref, FB: bold.ref }),
    });
    const ap = ctx.stream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: ctx.obj([0, 0, placement.width, placement.height]),
      Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
      Resources: resources,
    });
    apRef = ctx.register(ap);
  }

  /* ---- Словарь подписи (собираем вручную ради фиксированных длин) ---- */
  const placeholderBytes = opts.useTsa ? PLACEHOLDER_T : PLACEHOLDER_BES;
  const sigRef = ctx.nextRef();
  const sigRaw = enc.encode(
    '<< /Type /Sig\n' +
      '/Filter /Adobe.PPKLite\n' +
      '/SubFilter /adbe.pkcs7.detached\n' +
      '/ByteRange [0 0000000000 0000000000 0000000000]\n' +
      `/M (${pdfDate(new Date())})\n` +
      `/Name ${pdfTextString(opts.signerName)}\n` +
      (opts.reason ? `/Reason ${pdfTextString(opts.reason)}\n` : '') +
      (opts.location ? `/Location ${pdfTextString(opts.location)}\n` : '') +
      (opts.contactInfo ? `/ContactInfo ${pdfTextString(opts.contactInfo)}\n` : '') +
      `/Contents <${'0'.repeat(placeholderBytes * 2)}>\n` +
      '>>',
  );
  mark(sigRef, null, sigRaw);

  /* ---- Виджет поля подписи ---- */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const widgetDict: Record<string, any> = {
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Ff: 0,
    Rect: ctx.obj(rect),
    T: PDFHexString.fromText(fieldName),
    V: sigRef,
    // 132 = Print | Locked; без NoView, штамп должен быть виден
    F: placement ? 4 : 2,
  };
  if (apRef) widgetDict.AP = ctx.obj({ N: apRef });
  if (pageRef) widgetDict.P = pageRef;
  const widget = ctx.obj(widgetDict) as PDFDict;
  const widgetRef = ctx.register(widget);

  fields.push(widgetRef);
  mark(fieldsOwner, fieldsOwner.tag === acroRef.tag ? acro : fields);
  mark(acroRef, acro);
  mark(catalogRef, catalog);

  /* ---- /Annots страницы ---- */
  if (pageRef) {
    const pageDict = ctx.lookup(pageRef, PDFDict);
    const annotsEntry = pageDict.get(PDFName.of('Annots'));
    if (annotsEntry instanceof PDFRef) {
      const annots = ctx.lookup(annotsEntry, PDFArray);
      annots.push(widgetRef);
      mark(annotsEntry, annots);
    } else {
      let annots = pageDict.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) {
        annots = ctx.obj([]) as PDFArray;
        pageDict.set(PDFName.of('Annots'), annots);
      }
      annots.push(widgetRef);
    }
    mark(pageRef, pageDict);
  }

  // встраивание шрифтов создаёт объекты — только после flush их можно сериализовать
  await doc.flush();

  // все объекты с номером выше исходного максимума — новые, их надо выгрузить
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref.objectNumber > origLargest && !changed.has(ref.tag)) {
      mark(ref, obj);
    }
  }
  mark(widgetRef, widget);

  /* ---- Сборка incremental update ---- */
  const prevStartXref = findStartXref(original);
  const xrefIsStream = !startsWithXrefKeyword(original, prevStartXref);

  const chunks: Uint8Array[] = [];
  let cursor = original.length;
  const lead = original[original.length - 1] === 0x0a ? enc.encode('') : enc.encode('\n');
  chunks.push(lead);
  cursor += lead.length;

  const offsets: { ref: PDFRef; offset: number }[] = [];
  const emitted = [...changed.values()].sort(
    (a, b) => a.ref.objectNumber - b.ref.objectNumber,
  );
  const xrefStreamRef = xrefIsStream ? ctx.nextRef() : null;

  for (const e of emitted) {
    const bytes = serializeObject(e);
    offsets.push({ ref: e.ref, offset: cursor });
    chunks.push(bytes);
    cursor += bytes.length;
  }

  const size = ctx.largestObjectNumber + 1;
  if (xrefStreamRef) {
    const entries = [...offsets];
    const xrefOffset = cursor;
    entries.push({ ref: xrefStreamRef, offset: xrefOffset });
    entries.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
    const streamBytes = buildXrefStream(entries, size, prevStartXref, ctx, xrefStreamRef);
    chunks.push(streamBytes);
    cursor += streamBytes.length;
    chunks.push(enc.encode(`startxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    const xrefOffset = cursor;
    const table = buildXrefTable(offsets, size, prevStartXref, ctx);
    chunks.push(table);
    cursor += table.length;
    chunks.push(enc.encode(`startxref\n${xrefOffset}\n%%EOF\n`));
  }

  const bytes = concat([original, ...chunks]);

  /* ---- Подстановка ByteRange ---- */
  const contentsKey = indexOfBytes(bytes, '/Contents <', original.length);
  if (contentsKey < 0) throw new PdfSignError('Внутренняя ошибка: не найден плейсхолдер /Contents');
  const contentsStart = contentsKey + '/Contents '.length;
  const contentsEnd = bytes.indexOf(0x3e, contentsStart) + 1; // '>'
  if (contentsEnd <= contentsStart) {
    throw new PdfSignError('Внутренняя ошибка: повреждён плейсхолдер /Contents');
  }

  const brKey = indexOfBytes(bytes, '/ByteRange [', original.length);
  const brEnd = bytes.indexOf(0x5d, brKey) + 1; // ']'
  const a = contentsStart;
  const b = contentsEnd;
  const c = bytes.length - b;
  const brValue = `[0 ${pad10(a)} ${pad10(b)} ${pad10(c)}]`;
  const brBytes = enc.encode(brValue);
  if (brBytes.length !== brEnd - (brKey + '/ByteRange '.length)) {
    throw new PdfSignError('Внутренняя ошибка: длина /ByteRange изменилась');
  }
  bytes.set(brBytes, brKey + '/ByteRange '.length);

  const dataToSign = concat([bytes.subarray(0, a), bytes.subarray(b, b + c)]);

  return { bytes, contentsStart, contentsEnd, placeholderBytes, dataToSign, fieldName };
}

function pad10(n: number): string {
  return String(n).padStart(10, '0');
}

function nextFieldName(existing: string[]): string {
  let i = 1;
  const set = new Set(existing);
  while (set.has(`Signature${i}`)) i++;
  return `Signature${i}`;
}

function findStartXref(bytes: Uint8Array): number {
  const tailStart = Math.max(0, bytes.length - 2048);
  const tail = new TextDecoder('latin1').decode(bytes.subarray(tailStart));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfSignError('В PDF не найден startxref — файл повреждён');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfSignError('В PDF повреждена таблица перекрёстных ссылок');
  return Number(m[1]);
}

function startsWithXrefKeyword(bytes: Uint8Array, offset: number): boolean {
  const s = new TextDecoder('latin1').decode(bytes.subarray(offset, offset + 8)).trimStart();
  return s.startsWith('xref');
}

function subsections(offsets: { ref: PDFRef; offset: number }[]) {
  const sorted = [...offsets].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
  const groups: { start: number; items: { ref: PDFRef; offset: number }[] }[] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    if (last && item.ref.objectNumber === last.start + last.items.length) {
      last.items.push(item);
    } else {
      groups.push({ start: item.ref.objectNumber, items: [item] });
    }
  }
  return groups;
}

function trailerExtras(ctx: PDFDocument['context']): string {
  const id = ctx.trailerInfo.ID;
  const info = ctx.trailerInfo.Info;
  let s = '';
  if (info instanceof PDFRef) s += ` /Info ${info.objectNumber} ${info.generationNumber} R`;
  if (id) {
    const buf = new Uint8Array(id.sizeInBytes());
    id.copyBytesInto(buf, 0);
    s += ` /ID ${new TextDecoder('latin1').decode(buf)}`;
  }
  return s;
}

function buildXrefTable(
  offsets: { ref: PDFRef; offset: number }[],
  size: number,
  prev: number,
  ctx: PDFDocument['context'],
): Uint8Array {
  let s = 'xref\n';
  for (const g of subsections(offsets)) {
    s += `${g.start} ${g.items.length}\n`;
    for (const it of g.items) {
      s += `${String(it.offset).padStart(10, '0')} ${String(it.ref.generationNumber).padStart(5, '0')} n \n`;
    }
  }
  const root = ctx.trailerInfo.Root as PDFRef;
  s += 'trailer\n';
  s += `<< /Size ${size} /Root ${root.objectNumber} ${root.generationNumber} R /Prev ${prev}${trailerExtras(ctx)} >>\n`;
  return enc.encode(s);
}

function buildXrefStream(
  entries: { ref: PDFRef; offset: number }[],
  size: number,
  prev: number,
  ctx: PDFDocument['context'],
  streamRef: PDFRef,
): Uint8Array {
  const groups = subsections(entries);
  const index: number[] = [];
  const rows: number[][] = [];
  for (const g of groups) {
    index.push(g.start, g.items.length);
    for (const it of g.items) {
      rows.push([1, it.offset, it.ref.generationNumber]);
    }
  }
  const data = new Uint8Array(rows.length * 7);
  rows.forEach((row, i) => {
    const o = i * 7;
    data[o] = row[0];
    data[o + 1] = (row[1] >>> 24) & 0xff;
    data[o + 2] = (row[1] >>> 16) & 0xff;
    data[o + 3] = (row[1] >>> 8) & 0xff;
    data[o + 4] = row[1] & 0xff;
    data[o + 5] = (row[2] >>> 8) & 0xff;
    data[o + 6] = row[2] & 0xff;
  });

  const root = ctx.trailerInfo.Root as PDFRef;
  const dict =
    `<< /Type /XRef /Size ${size} /Index [${index.join(' ')}] /W [1 4 2] ` +
    `/Root ${root.objectNumber} ${root.generationNumber} R /Prev ${prev}${trailerExtras(ctx)} ` +
    `/Length ${data.length} >>\n`;

  return concat([
    enc.encode(`${streamRef.objectNumber} ${streamRef.generationNumber} obj\n${dict}stream\n`),
    data,
    enc.encode('\nendstream\nendobj\n'),
  ]);
}

/* ------------------------------------------------------------------ */
/* Фаза 3 — вставка CMS                                                */
/* ------------------------------------------------------------------ */

export function embedSignature(prepared: PreparedPdf, cmsDer: Uint8Array): Uint8Array {
  const capacity = prepared.contentsEnd - prepared.contentsStart - 2; // без < и >
  const hex = bytesToHex(cmsDer);
  if (hex.length > capacity) {
    throw new PdfSignError(
      `Подпись не помещается в зарезервированное место (${cmsDer.length} байт при резерве ${prepared.placeholderBytes} байт)`,
      'Увеличьте размер плейсхолдера и подпишите документ заново — обрезать подпись нельзя.',
    );
  }
  const padded = hex + '0'.repeat(capacity - hex.length);
  const out = prepared.bytes.slice();
  for (let i = 0; i < padded.length; i++) {
    out[prepared.contentsStart + 1 + i] = padded.charCodeAt(i);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

export { CADESCOM };
