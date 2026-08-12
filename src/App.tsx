import { useCallback, useEffect, useMemo, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import {
  CadesError,
  describe,
  fromBase64,
  hashAlgByPublicKeyOid,
  listCertificates,
  loadPlugin,
  pluginDiagnostics,
  signBytes,
  type CertificateInfo,
} from './lib/cades';
import {
  DEFAULT_STAMP_HEIGHT,
  DEFAULT_STAMP_WIDTH,
  MIN_STAMP_HEIGHT,
  MIN_STAMP_WIDTH,
  embedSignature,
  findFreeSpot,
  formatDate,
  occupiedRects,
  preparePdf,
  readExistingSignatures,
  rectsOverlap,
  stampLines as buildStampLines,
  type ExistingSignature,
  type StampPlacement,
} from './lib/pdfSign';
import { PdfPreview } from './components/PdfPreview';
import { DebugPanel } from './components/DebugPanel';

const DEFAULT_TSA = 'http://testca2012.cryptopro.ru/tsp/tsp.srf';

type Phase = 'idle' | 'prepare' | 'sign' | 'embed' | 'done';

interface Doc {
  name: string;
  bytes: Uint8Array;
  pageSizes: { width: number; height: number }[];
  signatures: ExistingSignature[];
}

export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [placement, setPlacement] = useState<StampPlacement | null>(null);
  const [withStamp, setWithStamp] = useState(true);

  const [certs, setCerts] = useState<CertificateInfo[]>([]);
  const [handles, setHandles] = useState<unknown[]>([]);
  const [certIndex, setCertIndex] = useState<number | null>(null);
  const [pluginState, setPluginState] = useState<'checking' | 'ok' | 'fail'>('checking');
  const [pluginError, setPluginError] = useState<CadesError | null>(null);

  const [useTsa, setUseTsa] = useState(false);
  const [tsaUrl, setTsaUrl] = useState(DEFAULT_TSA);
  const [reason, setReason] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [diag, setDiag] = useState<string[] | null>(null);

  /* --- плагин --- */
  const refreshCerts = useCallback(async () => {
    setPluginState('checking');
    setPluginError(null);
    try {
      await loadPlugin();
      const { certs, handles } = await listCertificates(true);
      setCerts(certs);
      setHandles(handles);
      setCertIndex(certs.length ? 0 : null);
      setPluginState('ok');
    } catch (e) {
      setPluginError(e instanceof CadesError ? e : new CadesError(describe(e)));
      setPluginState('fail');
    }
  }, []);

  useEffect(() => {
    void refreshCerts();
  }, [refreshCerts]);

  const cert = certIndex != null ? certs[certIndex] : null;

  const stampData = useMemo(
    () =>
      cert
        ? {
            serialNumber: cert.serialNumber,
            ownerName: cert.cn || `${cert.surname} ${cert.givenName}`.trim(),
            validFrom: cert.validFrom,
            validTo: cert.validTo,
          }
        : null,
    [cert],
  );

  const stampLines = stampData
    ? buildStampLines(stampData)
    : [
        'Документ подписан электронной подписью',
        'Сертификат: —',
        'Владелец: —',
        'Действителен с —',
      ];

  /* --- загрузка документа --- */
  const openFile = async (file: File) => {
    setError(null);
    setResult(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
      const pageSizes = parsed.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
      const signatures = readExistingSignatures(parsed);
      setDoc({ name: file.name, bytes, pageSizes, signatures });
      setPageIndex(0);
      setPlacement(null);
    } catch (e) {
      const msg = describe(e);
      setError({
        message: /encrypt/i.test(msg)
          ? 'PDF защищён паролем — подписание невозможно'
          : 'Не удалось открыть PDF: файл повреждён или это не PDF',
        hint: msg,
      });
    }
  };

  /* --- автопозиция штампа --- */
  useEffect(() => {
    if (!doc || !withStamp) return;
    const page = doc.pageSizes[pageIndex];
    if (!page) return;
    const taken = occupiedRects(doc.signatures, pageIndex);
    const spot = findFreeSpot(taken, page.width, page.height, DEFAULT_STAMP_WIDTH, DEFAULT_STAMP_HEIGHT);
    setPlacement({
      pageIndex,
      x: spot.x,
      y: spot.y,
      width: DEFAULT_STAMP_WIDTH,
      height: DEFAULT_STAMP_HEIGHT,
    });
  }, [doc, pageIndex, withStamp]);

  const taken = doc ? occupiedRects(doc.signatures, pageIndex) : [];
  const overlap =
    !!placement &&
    taken.some((t) =>
      rectsOverlap([placement.x, placement.y, placement.x + placement.width, placement.y + placement.height], t),
    );
  const tooSmall =
    !!placement && (placement.width < MIN_STAMP_WIDTH || placement.height < MIN_STAMP_HEIGHT);

  /* --- подписание --- */
  const sign = async () => {
    if (!doc || !cert || certIndex == null) return;
    setError(null);
    setResult(null);
    try {
      if (!cert.hasPrivateKey) {
        throw new CadesError(
          'У выбранного сертификата нет закрытого ключа',
          'Подключите носитель с ключом или выберите другой сертификат.',
        );
      }
      if (withStamp && overlap) {
        throw new CadesError(
          'Штамп перекрывает уже существующую подпись',
          'По ГОСТ Р 7.0.97-2016 штампы не должны накладываться друг на друга — сдвиньте рамку.',
        );
      }

      setPhase('prepare');
      const prepared = await preparePdf(doc.bytes, {
        stamp: stampData!,
        placement: withStamp ? placement : null,
        useTsa,
        signerName: stampData!.ownerName,
        reason: reason.trim() || undefined,
      });

      setPhase('sign');
      const cmsBase64 = await signBytes(handles[certIndex], prepared.dataToSign, {
        hashAlg: hashAlgByPublicKeyOid(cert.publicKeyOid),
        useTsa,
        tsaUrl,
      });

      setPhase('embed');
      const signed = embedSignature(prepared, fromBase64(cmsBase64));

      setResult({ bytes: signed, name: doc.name.replace(/\.pdf$/i, '') + '_signed.pdf' });
      setPhase('done');

      // продолжаем работу с подписанной версией — для мультиподписи
      const parsed = await PDFDocument.load(signed, { updateMetadata: false });
      setDoc({
        name: doc.name,
        bytes: signed,
        pageSizes: doc.pageSizes,
        signatures: readExistingSignatures(parsed),
      });
    } catch (e) {
      const err = e as CadesError;
      setError({ message: err.message ?? describe(e), hint: err.hint });
      setPhase('idle');
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.bytes as unknown as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__mark">ГЦ</div>
        <div>
          <h1>
            ГостSign<span className="masthead__dot">.</span>
          </h1>
          <p>
            Подписание PDF по ГОСТ — PAdES, КриптоПро, всё в браузере.
            <br />
            Документ и ключ не покидают ваш компьютер.
          </p>
        </div>
        <button className="btn btn--ghost masthead__debug" onClick={() => setShowDebug((v) => !v)}>
          {showDebug ? 'Скрыть диагностику' : 'Диагностика'}
        </button>
      </header>

      {pluginState === 'fail' && pluginError && (
        <div className="notice notice--error">
          <strong>{pluginError.message}</strong>
          {pluginError.hint && <div>{pluginError.hint}</div>}
          <div className="row">
            <button className="btn btn--ghost" onClick={() => void refreshCerts()}>
              Проверить снова
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => void pluginDiagnostics().then(setDiag)}
            >
              Самодиагностика плагина
            </button>
          </div>
          {diag && <pre className="diag">{diag.join('\n')}</pre>}
        </div>
      )}

      {showDebug && <DebugPanel pdfBytes={result?.bytes ?? doc?.bytes ?? null} fileName={doc?.name ?? null} />}

      <main className="layout">
        <section className="column column--left">
          <Dropzone doc={doc} onFile={openFile} />

          {doc && (
            <>
              <div className="panel">
                <h2 className="panel__title">Подписи в документе</h2>
                {doc.signatures.length === 0 ? (
                  <p className="muted">Документ ещё не подписан.</p>
                ) : (
                  <ul className="siglist">
                    {doc.signatures.map((s, i) => (
                      <li key={i}>
                        <strong>{s.fieldName}</strong>
                        <span className="muted">
                          {s.signerName ? ` · ${s.signerName}` : ''}
                          {s.pageIndex != null ? ` · стр. ${s.pageIndex + 1}` : ''}
                          {s.subFilter ? ` · ${s.subFilter.replace('/', '')}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="panel">
                <h2 className="panel__title">Сертификат</h2>
                {pluginState === 'checking' && <p className="muted">Опрашиваем КриптоПро…</p>}
                {pluginState === 'ok' && certs.length === 0 && (
                  <p className="muted">
                    В личном хранилище нет действующих сертификатов. Подключите носитель и обновите
                    список.
                  </p>
                )}
                <div className="certs">
                  {certs.map((c, i) => (
                    <label key={c.thumbprint} className={'cert' + (certIndex === i ? ' cert--on' : '')}>
                      <input
                        type="radio"
                        name="cert"
                        checked={certIndex === i}
                        onChange={() => setCertIndex(i)}
                      />
                      <span className="cert__name">{c.cn || c.subjectName}</span>
                      <span className="cert__meta">
                        № {c.serialNumber}
                        <br />
                        {formatDate(c.validFrom)} — {formatDate(c.validTo)}
                        {!c.hasPrivateKey && <b className="warn"> · нет закрытого ключа</b>}
                      </span>
                      <span className="cert__issuer">{shortIssuer(c.issuerName)}</span>
                    </label>
                  ))}
                </div>
                <button className="btn btn--ghost" onClick={() => void refreshCerts()}>
                  Обновить список
                </button>
              </div>

              <div className="panel">
                <h2 className="panel__title">Параметры</h2>

                <label className="toggle">
                  <input type="checkbox" checked={withStamp} onChange={(e) => setWithStamp(e.target.checked)} />
                  <span>Видимый штамп подписи (ГОСТ Р 7.0.97-2016)</span>
                </label>

                <label className="toggle">
                  <input type="checkbox" checked={useTsa} onChange={(e) => setUseTsa(e.target.checked)} />
                  <span>Штамп времени, CAdES-T</span>
                </label>
                {useTsa && (
                  <input
                    className="input"
                    value={tsaUrl}
                    onChange={(e) => setTsaUrl(e.target.value)}
                    placeholder="Адрес службы TSA"
                  />
                )}

                <input
                  className="input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Основание подписания (необязательно)"
                />

                {doc.pageSizes.length > 1 && withStamp && (
                  <div className="pager">
                    <button
                      className="btn btn--ghost"
                      disabled={pageIndex === 0}
                      onClick={() => setPageIndex((p) => p - 1)}
                    >
                      ←
                    </button>
                    <span>
                      Страница {pageIndex + 1} из {doc.pageSizes.length}
                    </span>
                    <button
                      className="btn btn--ghost"
                      disabled={pageIndex >= doc.pageSizes.length - 1}
                      onClick={() => setPageIndex((p) => p + 1)}
                    >
                      →
                    </button>
                  </div>
                )}

                {withStamp && tooSmall && (
                  <div className="notice notice--warn">
                    Штамп меньше {MIN_STAMP_WIDTH}×{MIN_STAMP_HEIGHT} пт — реквизиты могут стать
                    нечитаемыми.
                  </div>
                )}
                {withStamp && overlap && (
                  <div className="notice notice--error">
                    Штамп перекрывает существующую подпись — сдвиньте рамку.
                  </div>
                )}

                <button
                  className="btn btn--primary"
                  disabled={!cert || phase !== 'idle' || (withStamp && overlap)}
                  onClick={() => void sign()}
                >
                  {phase === 'idle' && 'Подписать документ'}
                  {phase === 'prepare' && 'Готовим заготовку…'}
                  {phase === 'sign' && 'Подписываем в КриптоПро…'}
                  {phase === 'embed' && 'Встраиваем подпись…'}
                  {phase === 'done' && 'Подписать ещё раз'}
                </button>

                {phase !== 'idle' && phase !== 'done' && (
                  <ol className="phases">
                    <li className={phase === 'prepare' ? 'on' : 'done'}>ByteRange и плейсхолдер</li>
                    <li className={phase === 'sign' ? 'on' : phase === 'embed' ? 'done' : ''}>
                      Подпись в СКЗИ
                    </li>
                    <li className={phase === 'embed' ? 'on' : ''}>Вставка CMS</li>
                  </ol>
                )}

                {error && (
                  <div className="notice notice--error">
                    <strong>{error.message}</strong>
                    {error.hint && <div>{error.hint}</div>}
                  </div>
                )}

                {result && (
                  <div className="notice notice--ok">
                    <strong>Документ подписан.</strong>
                    <button className="btn btn--primary" onClick={download}>
                      Скачать {result.name}
                    </button>
                    <p className="muted">
                      Если PDF-вьюер не понимает ГОСТ-подписи, он покажет «статус подписи
                      неизвестен» — это ограничение вьюера, а не дефект подписи.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        <section className="column column--right">
          {doc ? (
            <PdfPreview
              pdfBytes={doc.bytes}
              pageIndex={pageIndex}
              onPagesLoaded={() => undefined}
              placement={withStamp ? placement : null}
              onPlacementChange={setPlacement}
              stampLines={stampLines}
              occupied={taken}
              overlapWarning={overlap}
            />
          ) : (
            <div className="empty">
              <p>Перетащите PDF слева — превью появится здесь.</p>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        Открытый исходный код · подпись формируется сертифицированным СКЗИ на вашей машине ·
        ни один байт документа не уходит в сеть
      </footer>
    </div>
  );
}

function shortIssuer(dn: string): string {
  const m = /CN=([^,]+)/.exec(dn);
  return m ? m[1].replace(/^"|"$/g, '') : dn;
}

function Dropzone({ doc, onFile }: { doc: Doc | null; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={'dropzone' + (over ? ' dropzone--over' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        type="file"
        accept="application/pdf"
        hidden
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      {doc ? (
        <>
          <strong>{doc.name}</strong>
          <span className="muted">
            {doc.pageSizes.length} стр. · {(doc.bytes.length / 1024).toFixed(0)} КБ · нажмите, чтобы
            заменить
          </span>
        </>
      ) : (
        <>
          <strong>Перетащите PDF сюда</strong>
          <span className="muted">или нажмите для выбора файла</span>
        </>
      )}
    </label>
  );
}
