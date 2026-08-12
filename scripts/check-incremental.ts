/**
 * Оффлайн-проверка ядра: incremental update, /ByteRange, мультиподпись.
 * Крипта не задействована — вместо CMS кладётся фиктивный DER.
 * Запуск: pnpm check
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { embedSignature, preparePdf, readExistingSignatures } from '../src/lib/pdfSign';
import { findSignatures } from '../src/lib/pdfInspect';

// pdf-lib/fontkit в браузере грузит шрифты через fetch — подменяем на чтение с диска
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/fonts/') || url.startsWith('fonts/')) {
    const buf = await readFile(new URL(`../public/${url.replace(/^\//, '')}`, import.meta.url));
    return new Response(buf);
  }
  return realFetch(input, init);
}) as typeof fetch;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function makeSample(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Test document, page ${i + 1}`, { x: 60, y: 760, size: 16, font });
  }
  return doc.save({ useObjectStreams });
}

const stamp = {
  serialNumber: '00 D1 4C 3F 21 9A 77 B2',
  ownerName: 'Иванов Иван Иванович',
  validFrom: new Date('2025-01-15'),
  validTo: new Date('2026-01-15'),
};

/** Фиктивный CMS: валидный по структуре DER SEQUENCE нужной длины. */
function fakeCms(len: number): Uint8Array {
  const body = new Uint8Array(len);
  body.fill(0x41);
  const header = new Uint8Array([0x30, 0x82, (len >> 8) & 0xff, len & 0xff]);
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(body, header.length);
  return out;
}

async function signOnce(bytes: Uint8Array, pageIndex: number, y: number) {
  const prepared = await preparePdf(bytes, {
    stamp,
    placement: { pageIndex, x: 60, y, width: 190, height: 66 },
    useTsa: false,
    signerName: stamp.ownerName,
    reason: 'Проверка ядра',
  });

  // байты вне /Contents не должны отличаться от исходного файла
  check(
    'исходные байты не изменились',
    Buffer.compare(Buffer.from(bytes), Buffer.from(prepared.bytes.subarray(0, bytes.length))) === 0,
  );

  const signed = embedSignature(prepared, fakeCms(2000));
  check('длина файла не изменилась после вставки CMS', signed.length === prepared.bytes.length);

  const before = Buffer.from(prepared.bytes.subarray(0, prepared.contentsStart));
  const after = Buffer.from(signed.subarray(0, prepared.contentsStart));
  check('байты до /Contents не тронуты вставкой', Buffer.compare(before, after) === 0);

  return { signed, prepared };
}

async function run(label: string, useObjectStreams: boolean) {
  console.log(`\n=== ${label} ===`);
  const original = await makeSample(useObjectStreams);

  const first = await signOnce(original, 0, 60);
  const second = await signOnce(first.signed, 0, 160);
  const third = await signOnce(second.signed, 1, 60);
  const final = third.signed;

  const slots = findSignatures(final);
  check('найдено три подписи', slots.length === 3, `найдено ${slots.length}`);
  for (const s of slots) {
    check(`подпись #${s.index + 1}: ByteRange согласован с /Contents`, s.consistent, s.gapNote ?? '');
  }
  check('последняя подпись покрывает весь файл', slots[slots.length - 1]?.coversWholeFile === true);
  for (const s of slots.slice(0, -1)) {
    check(
      `подпись #${s.index + 1}: покрывает свою ревизию`,
      !s.coversWholeFile && s.byteRange[2] + s.byteRange[3] < final.length,
    );
  }

  // первая подпись должна покрывать ровно те же байты, что и в момент подписания
  const firstSlots = findSignatures(first.signed);
  if (firstSlots.length && slots.length) {
    const wasData = Buffer.from(first.signed.subarray(0, firstSlots[0].contentsStart));
    const nowData = Buffer.from(final.subarray(0, slots[0].contentsStart));
    check('данные первой подписи не изменились после двух новых подписей', Buffer.compare(wasData, nowData) === 0);
  }

  const parsed = await PDFDocument.load(final, { updateMetadata: false });
  const sigs = readExistingSignatures(parsed);
  check('pdf-lib видит три поля подписи', sigs.length === 3, JSON.stringify(sigs.map((s) => s.fieldName)));
  check(
    'имена полей уникальны',
    new Set(sigs.map((s) => s.fieldName)).size === 3,
    sigs.map((s) => s.fieldName).join(', '),
  );
  check('у всех полей есть штамп на странице', sigs.every((s) => s.pageIndex !== null && s.rect));

  await mkdir(new URL('../.out/', import.meta.url), { recursive: true });
  const out = new URL(`../.out/${useObjectStreams ? 'objstm' : 'table'}.pdf`, import.meta.url);
  await writeFile(out, final);
  console.log(`  файл: ${out.pathname}`);
}

await run('xref-таблица', false);
await run('xref-поток (object streams)', true);

console.log(failures ? `\n${failures} проверок провалено` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
