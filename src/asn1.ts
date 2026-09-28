/**
 * Минимальный DER-парсер — только для отладочного разбора CMS.
 * Никакой криптографии здесь нет и быть не должно.
 */

export interface Asn1Node {
  tag: number;
  constructed: boolean;
  /** Смещение начала заголовка в исходном буфере. */
  start: number;
  /** Смещение содержимого. */
  contentStart: number;
  length: number;
  children: Asn1Node[];
  bytes: Uint8Array;
}

export function parseDER(buf: Uint8Array, offset = 0, end = buf.length): Asn1Node[] {
  const nodes: Asn1Node[] = [];
  let i = offset;
  while (i < end) {
    const start = i;
    const tag = buf[i++];
    if ((tag & 0x1f) === 0x1f) {
      while (i < end && buf[i] & 0x80) i++;
      i++;
    }
    if (i >= end) break;
    let len = buf[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4) break; // indefinite/огромные длины в CMS не встречаются
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
    }
    const contentStart = i;
    const contentEnd = Math.min(contentStart + len, end);
    const constructed = (tag & 0x20) !== 0;
    const node: Asn1Node = {
      tag,
      constructed,
      start,
      contentStart,
      length: len,
      children: [],
      bytes: buf.subarray(contentStart, contentEnd),
    };
    if (constructed) {
      try {
        node.children = parseDER(buf, contentStart, contentEnd);
      } catch {
        node.children = [];
      }
    }
    nodes.push(node);
    i = contentEnd;
    if (len === 0 && tag === 0) break;
  }
  return nodes;
}

export function decodeOID(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

export function decodeUTCTime(bytes: Uint8Array): string {
  const s = new TextDecoder().decode(bytes);
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/.exec(s);
  if (!m) return s;
  const year = Number(m[1]) < 50 ? 2000 + Number(m[1]) : 1900 + Number(m[1]);
  return `${m[3]}.${m[2]}.${year} ${m[4]}:${m[5]}:${m[6] ?? '00'} UTC`;
}

export function decodeGeneralizedTime(bytes: Uint8Array): string {
  const s = new TextDecoder().decode(bytes);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]} UTC`;
}

/** Рекурсивно ищет первую последовательность OID + значение по OID. */
function findAttribute(nodes: Asn1Node[], oid: string): Asn1Node | null {
  for (const n of nodes) {
    if (n.tag === 0x30 && n.children.length >= 2 && n.children[0].tag === 0x06) {
      if (decodeOID(n.children[0].bytes) === oid) return n;
    }
    const inner = findAttribute(n.children, oid);
    if (inner) return inner;
  }
  return null;
}

function collectOIDs(nodes: Asn1Node[], out: Set<string>) {
  for (const n of nodes) {
    if (n.tag === 0x06) out.add(decodeOID(n.bytes));
    collectOIDs(n.children, out);
  }
}

const OID_NAMES: Record<string, string> = {
  '1.2.643.7.1.1.2.2': 'ГОСТ Р 34.11-2012 (256 бит)',
  '1.2.643.7.1.1.2.3': 'ГОСТ Р 34.11-2012 (512 бит)',
  '1.2.643.2.2.9': 'ГОСТ Р 34.11-94',
  '1.2.643.7.1.1.3.2': 'ГОСТ Р 34.10-2012 (256 бит)',
  '1.2.643.7.1.1.3.3': 'ГОСТ Р 34.10-2012 (512 бит)',
  '1.2.643.2.2.3': 'ГОСТ Р 34.10-2001',
};

export function oidName(oid: string): string {
  return OID_NAMES[oid] ? `${OID_NAMES[oid]} (${oid})` : oid;
}

export interface CmsInfo {
  contentType: string;
  digestAlgorithms: string[];
  signerDigestAlgorithm: string;
  signatureAlgorithm: string;
  messageDigest: string | null;
  signingTime: string | null;
  hasSigningCertificateV2: boolean;
  hasTimestamp: boolean;
  timestampTime: string | null;
  certificateCount: number;
  signerSubject: string;
  detached: boolean;
  raw: Asn1Node[];
}

const DN_OIDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.42': 'G',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'S',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.643.100.3': 'SNILS',
  '1.2.643.3.131.1.1': 'INN',
};

function dnToString(seq: Asn1Node): string {
  const parts: string[] = [];
  for (const rdn of seq.children) {
    for (const atv of rdn.children) {
      if (atv.children.length === 2 && atv.children[0].tag === 0x06) {
        const oid = decodeOID(atv.children[0].bytes);
        const name = DN_OIDS[oid] ?? oid;
        parts.push(`${name}=${new TextDecoder().decode(atv.children[1].bytes)}`);
      }
    }
  }
  return parts.join(', ');
}

/** Разбирает detached CMS для отладки. */
export function inspectCMS(der: Uint8Array): CmsInfo {
  const root = parseDER(der);
  const info: CmsInfo = {
    contentType: '',
    digestAlgorithms: [],
    signerDigestAlgorithm: '',
    signatureAlgorithm: '',
    messageDigest: null,
    signingTime: null,
    hasSigningCertificateV2: false,
    hasTimestamp: false,
    timestampTime: null,
    certificateCount: 0,
    signerSubject: '',
    detached: true,
    raw: root,
  };
  if (!root.length) return info;

  const contentInfo = root[0];
  if (contentInfo.children[0]?.tag === 0x06) {
    info.contentType = decodeOID(contentInfo.children[0].bytes);
  }
  const signedData = contentInfo.children[1]?.children[0];
  if (!signedData) return info;

  // SignedData ::= { version, digestAlgorithms SET, encapContentInfo, [0] certs, [1] crls, signerInfos SET }
  const digestAlgSet = signedData.children.find((c) => c.tag === 0x31);
  if (digestAlgSet) {
    info.digestAlgorithms = digestAlgSet.children
      .map((c) => (c.children[0]?.tag === 0x06 ? decodeOID(c.children[0].bytes) : ''))
      .filter(Boolean);
  }

  const encap = signedData.children.find(
    (c) => c.tag === 0x30 && c.children[0]?.tag === 0x06,
  );
  info.detached = !encap || encap.children.length < 2;

  const certsTag = signedData.children.find((c) => c.tag === 0xa0);
  if (certsTag) {
    info.certificateCount = certsTag.children.length;
    const first = certsTag.children[0];
    // Certificate -> TBSCertificate -> [version] serial sigAlg issuer validity subject
    const tbs = first?.children[0];
    if (tbs) {
      const seqs = tbs.children.filter((c) => c.tag === 0x30);
      // issuer, validity, subject: subject — вторая RDNSequence после validity
      const subject = seqs.length >= 4 ? seqs[seqs.length - 2] : undefined;
      if (subject) info.signerSubject = dnToString(subject);
    }
  }

  const signerInfos = signedData.children.filter((c) => c.tag === 0x31).pop();
  const si = signerInfos?.children[0];
  if (si) {
    const algs = si.children.filter((c) => c.tag === 0x30 && c.children[0]?.tag === 0x06);
    if (algs[0]) info.signerDigestAlgorithm = decodeOID(algs[0].children[0].bytes);
    if (algs[1]) info.signatureAlgorithm = decodeOID(algs[1].children[0].bytes);

    const signedAttrs = si.children.find((c) => c.tag === 0xa0);
    if (signedAttrs) {
      const md = findAttribute(signedAttrs.children, '1.2.840.113549.1.9.4');
      if (md) {
        const value = md.children[1]?.children[0];
        if (value) info.messageDigest = toHex(value.bytes);
      }
      const st = findAttribute(signedAttrs.children, '1.2.840.113549.1.9.5');
      if (st) {
        const value = st.children[1]?.children[0];
        if (value) {
          info.signingTime =
            value.tag === 0x18 ? decodeGeneralizedTime(value.bytes) : decodeUTCTime(value.bytes);
        }
      }
      info.hasSigningCertificateV2 = !!findAttribute(
        signedAttrs.children,
        '1.2.840.113549.1.9.16.2.47',
      );
    }
    const unsignedAttrs = si.children.find((c) => c.tag === 0xa1);
    if (unsignedAttrs) {
      const ts = findAttribute(unsignedAttrs.children, '1.2.840.113549.1.9.16.2.14');
      info.hasTimestamp = !!ts;
      if (ts) {
        const oids = new Set<string>();
        collectOIDs([ts], oids);
        // время из TSTInfo — первый GeneralizedTime внутри токена
        const gt = findFirstTag([ts], 0x18);
        if (gt) info.timestampTime = decodeGeneralizedTime(gt.bytes);
      }
    }
  }
  return info;
}

function findFirstTag(nodes: Asn1Node[], tag: number): Asn1Node | null {
  for (const n of nodes) {
    if (n.tag === tag) return n;
    const inner = findFirstTag(n.children, tag);
    if (inner) return inner;
  }
  return null;
}
