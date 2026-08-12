import { useState } from 'react';
import { checkDigest, findSignatures, type DigestCheck, type SignatureSlot } from '../lib/pdfInspect';
import { oidName } from '../lib/asn1';
import { describe } from '../lib/cades';

interface Props {
  pdfBytes: Uint8Array | null;
  fileName: string | null;
}

export function DebugPanel({ pdfBytes, fileName }: Props) {
  const [slots, setSlots] = useState<SignatureSlot[] | null>(null);
  const [checks, setChecks] = useState<Record<number, DigestCheck | string>>({});
  const [busy, setBusy] = useState(false);

  const analyze = (bytes: Uint8Array) => {
    setChecks({});
    setSlots(findSignatures(bytes));
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    setExternal({ bytes, name: f.name });
    analyze(bytes);
  };

  const [external, setExternal] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const target = external ?? (pdfBytes ? { bytes: pdfBytes, name: fileName ?? 'документ' } : null);

  const runDigestCheck = async (slot: SignatureSlot) => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await checkDigest(target.bytes, slot);
      setChecks((c) => ({ ...c, [slot.index]: res }));
    } catch (e) {
      setChecks((c) => ({ ...c, [slot.index]: describe(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel__title">Диагностика подписей</h2>
      <p className="muted">
        Разбирает <code>/ByteRange</code> и <code>/Contents</code>, показывает структуру CMS и
        сверяет <code>messageDigest</code> с хэшем, пересчитанным плагином.
      </p>

      <div className="row">
        <button className="btn" disabled={!target} onClick={() => target && analyze(target.bytes)}>
          Разобрать {external ? external.name : fileName ?? 'текущий документ'}
        </button>
        <label className="btn btn--ghost">
          Другой файл…
          <input type="file" accept="application/pdf" hidden onChange={onPick} />
        </label>
        {external && (
          <button className="btn btn--ghost" onClick={() => { setExternal(null); setSlots(null); }}>
            Сбросить
          </button>
        )}
      </div>

      {slots && slots.length === 0 && <div className="notice">В файле не найдено подписей.</div>}

      {slots?.map((s) => {
        const check = checks[s.index];
        return (
          <div key={s.index} className="sigcard">
            <div className="sigcard__head">
              <strong>Подпись #{s.index + 1}</strong>
              <span className={s.consistent ? 'tag tag--ok' : 'tag tag--bad'}>
                {s.consistent ? 'ByteRange корректен' : 'ByteRange некорректен'}
              </span>
              <span className="tag">
                {s.coversWholeFile
                  ? 'покрывает весь файл'
                  : 'покрывает свою ревизию (есть более поздние правки)'}
              </span>
            </div>
            {s.gapNote && <div className="notice notice--error">{s.gapNote}</div>}
            <dl className="kv">
              <dt>ByteRange</dt>
              <dd className="mono">[{s.byteRange.join(' ')}]</dd>
              <dt>/Contents</dt>
              <dd className="mono">
                {s.contentsStart}…{s.contentsEnd} ({s.contentsEnd - s.contentsStart - 2} hex-символов,
                CMS {s.cms.length} байт)
              </dd>
              <dt>Тип CMS</dt>
              <dd>{s.info.detached ? 'detached' : 'attached'} ({s.info.contentType})</dd>
              <dt>Алгоритм хэша</dt>
              <dd>{oidName(s.info.signerDigestAlgorithm || s.info.digestAlgorithms[0] || '—')}</dd>
              <dt>Алгоритм подписи</dt>
              <dd>{oidName(s.info.signatureAlgorithm || '—')}</dd>
              <dt>Сертификатов в CMS</dt>
              <dd>{s.info.certificateCount}</dd>
              <dt>Подписант</dt>
              <dd>{s.info.signerSubject || '—'}</dd>
              <dt>messageDigest</dt>
              <dd className="mono break">{s.info.messageDigest ?? 'отсутствует'}</dd>
              <dt>signingTime</dt>
              <dd>{s.info.signingTime ?? 'нет'}</dd>
              <dt>signing-certificate-v2</dt>
              <dd>{s.info.hasSigningCertificateV2 ? 'есть' : 'нет'}</dd>
              <dt>Штамп времени (TSA)</dt>
              <dd>
                {s.info.hasTimestamp
                  ? `есть${s.info.timestampTime ? ` — ${s.info.timestampTime}` : ''}`
                  : 'нет (CAdES-BES)'}
              </dd>
            </dl>

            <button className="btn btn--ghost" disabled={busy} onClick={() => runDigestCheck(s)}>
              Пересчитать хэш плагином и сверить
            </button>

            {typeof check === 'string' && <div className="notice notice--error">{check}</div>}
            {check && typeof check !== 'string' && (
              <div className={check.ok ? 'notice notice--ok' : 'notice notice--error'}>
                <div>{check.note}</div>
                <div className="mono break">посчитано: {check.computed || '—'}</div>
                <div className="mono break">ожидалось: {check.expected ?? '—'}</div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
