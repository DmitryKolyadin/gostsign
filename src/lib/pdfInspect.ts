/**
 * Отладочный инструментарий (п. 8 ТЗ).
 * Разбирает готовый PDF: /ByteRange, /Contents, структура CMS,
 * и сверяет messageDigest из CMS с хэшем ByteRange, посчитанным плагином.
 */
import { inspectCMS, oidName, type CmsInfo } from './asn1';
import { hashBytes, CADESCOM } from './cades';

export interface SignatureSlot {
  index: number;
  byteRange: number[];
  contentsStart: number;
  contentsEnd: number;
  cms: Uint8Array;
  info: CmsInfo;
  /** ByteRange согласован с положением /Contents (нет расхождения на байт). */
  consistent: boolean;
  /** Подпись покрывает файл целиком (т.е. это последняя ревизия). */
  coversWholeFile: boolean;
  gapNote: string | null;
}

export interface DigestCheck {
  ok: boolean;
  computed: string;
  computedReversed: string;
  expected: string | null;
  note: string;
}

const latin1 = new TextDecoder('latin1');

export function findSignatures(pdf: Uint8Array): SignatureSlot[] {
  const text = latin1.decode(pdf);
  const slots: SignatureSlot[] = [];
  const re = /\/ByteRange\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  let index = 0;

  while ((m = re.exec(text))) {
    const nums = m[1]
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => !isNaN(n));
    if (nums.length < 4) continue;

    // ищем hex-строку /Contents рядом с этим ByteRange
    let cStart = text.indexOf('/Contents', m.index);
    if (cStart < 0 || cStart - m.index > 4096) {
      cStart = text.lastIndexOf('/Contents', m.index);
    }
    if (cStart < 0) continue;
    const open = text.indexOf('<', cStart);
    const close = text.indexOf('>', open);
    if (open < 0 || close < 0) continue;

    const hex = text.slice(open + 1, close).replace(/[^0-9a-fA-F]/g, '');
    const cms = trimToDerLength(hexToBytes(hex));

    const [s0, l0, s1, l1] = nums;
    // Подпись из более ранней ревизии покрывает файл не целиком — это норма для
    // incremental update и НЕ ошибка. Ошибка — расхождение с положением /Contents.
    const consistent = s0 === 0 && s0 + l0 === open && s1 === close + 1 && s1 + l1 <= pdf.length;
    const coversWholeFile = consistent && s1 + l1 === pdf.length;

    const problems: string[] = [];
    if (s0 !== 0) problems.push(`первый сегмент начинается не с 0 (${s0})`);
    if (s0 + l0 !== open)
      problems.push(`конец первого сегмента ${s0 + l0} ≠ смещение '<' ${open} (Δ ${open - (s0 + l0)})`);
    if (s1 !== close + 1)
      problems.push(`второй сегмент начинается с ${s1}, а '>' заканчивается на ${close + 1} (Δ ${s1 - (close + 1)})`);
    if (s1 + l1 > pdf.length)
      problems.push(`второй сегмент выходит за пределы файла (${s1 + l1} > ${pdf.length})`);
    const gapNote = problems.length ? problems.join('; ') : null;

    let info: CmsInfo;
    try {
      info = inspectCMS(cms);
    } catch {
      continue;
    }

    slots.push({
      index: index++,
      byteRange: nums,
      contentsStart: open,
      contentsEnd: close + 1,
      cms,
      info,
      consistent,
      coversWholeFile,
      gapNote,
    });
  }
  return slots;
}

export function byteRangeData(pdf: Uint8Array, byteRange: number[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i + 1 < byteRange.length; i += 2) {
    parts.push(pdf.subarray(byteRange[i], byteRange[i] + byteRange[i + 1]));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const DIGEST_OID_TO_ALG: Record<string, number> = {
  '1.2.643.7.1.1.2.2': CADESCOM.HASH_GOST_3411_2012_256,
  '1.2.643.7.1.1.2.3': CADESCOM.HASH_GOST_3411_2012_512,
  '1.2.643.2.2.9': CADESCOM.HASH_GOST_3411,
};

/** Пересчитывает хэш ByteRange плагином и сверяет с messageDigest из CMS. */
export async function checkDigest(pdf: Uint8Array, slot: SignatureSlot): Promise<DigestCheck> {
  const oid = slot.info.signerDigestAlgorithm || slot.info.digestAlgorithms[0];
  const alg = DIGEST_OID_TO_ALG[oid];
  if (!alg) {
    return {
      ok: false,
      computed: '',
      computedReversed: '',
      expected: slot.info.messageDigest,
      note: `Неизвестный алгоритм хэширования ${oidName(oid)} — пересчёт невозможен`,
    };
  }
  const data = byteRangeData(pdf, slot.byteRange);
  const computed = await hashBytes(data, alg);
  const computedReversed = reverseHex(computed);
  const expected = slot.info.messageDigest;
  const ok = !!expected && (expected === computed || expected === computedReversed);
  return {
    ok,
    computed,
    computedReversed,
    expected,
    note: ok
      ? expected === computed
        ? 'messageDigest совпадает с хэшем ByteRange'
        : 'messageDigest совпадает с хэшем ByteRange (обратный порядок байтов, это норма для КриптоПро)'
      : 'messageDigest НЕ совпадает — документ изменён после подписания либо ByteRange посчитан неверно',
  };
}

function reverseHex(hex: string): string {
  let out = '';
  for (let i = hex.length - 2; i >= 0; i -= 2) out += hex.slice(i, i + 2);
  return out;
}

/** Отрезает нули-заполнители плейсхолдера по реальной длине DER-структуры. */
function trimToDerLength(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2) return bytes;
  let i = 1;
  let len = bytes[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || i + n > bytes.length) return bytes;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + bytes[i++];
  }
  const total = i + len;
  return total > 0 && total <= bytes.length ? bytes.subarray(0, total) : bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? hex.slice(0, -1) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
