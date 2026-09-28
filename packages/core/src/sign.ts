/**
 * Сценарий подписания целиком: заготовка → подпись плагином → вставка CMS.
 * Приложению остаётся выбрать сертификат, место штампа и TSA.
 */
import { PDFDocument } from 'pdf-lib';
import {
  CadesError,
  describe,
  fromBase64,
  hashAlgByPublicKeyOid,
  signBytes,
  type CertificateInfo,
} from './cades';
import {
  PdfSignError,
  embedSignature,
  findFreeSpot,
  occupiedRects,
  preparePdf,
  readExistingSignatures,
  type ExistingSignature,
  type StampPlacement,
} from './pdfSign';
import { stampDefaultSize, type StampData, type StampStyle } from './stampStyle';

export interface PdfInfo {
  pageSizes: { width: number; height: number }[];
  signatures: ExistingSignature[];
}

/** Размеры страниц и уже стоящие подписи. Бросает PdfSignError с понятным текстом. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return {
      pageSizes: doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() })),
      signatures: readExistingSignatures(doc),
    };
  } catch (e) {
    const msg = describe(e);
    throw new PdfSignError(
      /encrypt/i.test(msg)
        ? 'PDF защищён паролем — подписание невозможно'
        : 'Не удалось открыть PDF: файл повреждён или это не PDF',
      msg,
    );
  }
}

/** Реквизиты для штампа — только из сертификата. */
export function stampDataFromCertificate(cert: CertificateInfo): StampData {
  return {
    serialNumber: cert.serialNumber,
    ownerName: cert.cn || `${cert.surname} ${cert.givenName}`.trim(),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
  };
}

/** Место штампа по умолчанию: свободное место на странице размером из пресета. */
export function defaultPlacement(
  info: PdfInfo,
  pageIndex: number,
  style: StampStyle,
): StampPlacement | null {
  const page = info.pageSizes[pageIndex];
  if (!page) return null;
  const [width, height] = stampDefaultSize(style);
  const spot = findFreeSpot(occupiedRects(info.signatures, pageIndex), page.width, page.height, width, height);
  return { pageIndex, x: spot.x, y: spot.y, width, height };
}

export type SignPhase = 'prepare' | 'sign' | 'embed';
export type SignatureLevel = 'CAdES-BES' | 'CAdES-T';

export interface SignPdfOptions {
  certificate: CertificateInfo;
  /** Объект сертификата плагина (из listCertificates().handles). */
  certHandle: unknown;
  style?: StampStyle;
  /** null — невидимая подпись без штампа. */
  placement: StampPlacement | null;
  /**
   * Штамп времени (CAdES-T). `fallback: 'bes'` — если TSA недоступен,
   * подписать CAdES-BES и вернуть ошибку TSA в результате.
   */
  tsa: { url: string; fallback?: 'throw' | 'bes' } | null;
  reason?: string;
  location?: string;
  contactInfo?: string;
  onPhase?: (phase: SignPhase) => void;
}

export interface SignPdfResult {
  bytes: Uint8Array;
  fieldName: string;
  level: SignatureLevel;
  /** Причина, по которой пришлось откатиться на CAdES-BES. */
  tsaError?: CadesError;
}

export async function signPdf(original: Uint8Array, opts: SignPdfOptions): Promise<SignPdfResult> {
  const { certificate: cert } = opts;
  if (!cert.hasPrivateKey) {
    throw new CadesError(
      'У выбранного сертификата нет закрытого ключа',
      'Подключите носитель с ключом или выберите другой сертификат.',
      'no_private_key',
    );
  }
  const stamp = stampDataFromCertificate(cert);
  const hashAlg = hashAlgByPublicKeyOid(cert.publicKeyOid);

  opts.onPhase?.('prepare');
  // плейсхолдер под CAdES-T вмещает и BES — откат на BES не требует новой заготовки
  const prepared = await preparePdf(original, {
    stamp,
    style: opts.style,
    placement: opts.placement,
    useTsa: !!opts.tsa,
    signerName: stamp.ownerName,
    reason: opts.reason,
    location: opts.location,
    contactInfo: opts.contactInfo,
  });

  opts.onPhase?.('sign');
  let level: SignatureLevel = opts.tsa ? 'CAdES-T' : 'CAdES-BES';
  let tsaError: CadesError | undefined;
  let cms: string;
  try {
    cms = await signBytes(opts.certHandle, prepared.dataToSign, {
      hashAlg,
      useTsa: !!opts.tsa,
      tsaUrl: opts.tsa?.url,
    });
  } catch (e) {
    if (!(e instanceof CadesError && e.code === 'tsa_unavailable' && opts.tsa?.fallback === 'bes')) {
      throw e;
    }
    tsaError = e;
    level = 'CAdES-BES';
    cms = await signBytes(opts.certHandle, prepared.dataToSign, { hashAlg, useTsa: false });
  }

  opts.onPhase?.('embed');
  const bytes = embedSignature(prepared, fromBase64(cms));
  return { bytes, fieldName: prepared.fieldName, level, tsaError };
}
