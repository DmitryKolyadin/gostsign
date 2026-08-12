/**
 * Обёртка над КриптоПро ЭЦП Browser plug-in.
 * Вся криптография выполняется плагином (сертифицированный СКЗИ на машине
 * пользователя). Здесь нет ни одной строчки собственной реализации ГОСТ.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    cadesplugin?: any;
  }
}

export const CADESCOM = {
  BASE64_TO_BINARY: 1,
  CADES_BES: 1,
  CADES_T: 0x5,
  HASH_GOST_3411: 100,
  HASH_GOST_3411_2012_256: 101,
  HASH_GOST_3411_2012_512: 102,
  CERT_INCLUDE_WHOLE_CHAIN: 2,
  STORE_CURRENT_USER: 2,
  STORE_MY: 'My',
  STORE_OPEN_READ_ONLY: 0,
  FIND_TIME_VALID: 9,
} as const;

/** OID алгоритма открытого ключа -> алгоритм хэширования плагина. */
export function hashAlgByPublicKeyOid(oid: string): number {
  switch (oid) {
    case '1.2.643.7.1.1.1.1':
      return CADESCOM.HASH_GOST_3411_2012_256;
    case '1.2.643.7.1.1.1.2':
      return CADESCOM.HASH_GOST_3411_2012_512;
    case '1.2.643.2.2.19':
      return CADESCOM.HASH_GOST_3411;
    default:
      throw new CadesError(
        `Неизвестный алгоритм ключа сертификата (OID ${oid}). ` +
          'Поддерживаются только ГОСТ Р 34.10-2001 и 34.10-2012.',
      );
  }
}

export class CadesError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CadesError';
    this.hint = hint;
  }
}

const PLUGIN_URL = 'https://www.cryptopro.ru/products/cades/plugin';

/**
 * ВАЖНО: window.cadesplugin сам является Promise. Резолвить им наш промис нельзя —
 * промис «усыновляет» thenable и наружу приходит значение plugin_resolve(), т.е.
 * undefined. Поэтому отдаём API завёрнутым в объект и разворачиваем в конце.
 */
let pluginPromise: Promise<{ api: any }> | null = null;
let cadesApi: any = null;

/**
 * Дожидается готовности плагина. Значение НЕ возвращает: любой промис, которому
 * отдать window.cadesplugin, усыновит его как thenable и отдаст наружу undefined.
 * За самим API — синхронный getCades() уже после await.
 */
export async function loadPlugin(): Promise<void> {
  cadesApi = (await loadPluginBoxed()).api;
}

/** API плагина. Вызывать только после await loadPlugin(). */
export function getCades(): any {
  if (!cadesApi) {
    throw new CadesError('КриптоПро ЭЦП Browser plug-in ещё не инициализирован');
  }
  return cadesApi;
}

function loadPluginBoxed(): Promise<{ api: any }> {
  if (pluginPromise) return pluginPromise;

  const promise = new Promise<{ api: any }>((resolve, reject) => {
    const boot = () => {
      const cadesplugin = window.cadesplugin;
      if (!cadesplugin) {
        reject(
          new CadesError(
            'Не удалось загрузить cadesplugin_api.js',
            'Проверьте, что файл /vendor/cadesplugin_api.js доступен.',
          ),
        );
        return;
      }
      const timeout = setTimeout(() => {
        reject(
          new CadesError(
            'КриптоПро ЭЦП Browser plug-in не отвечает',
            'Плагин не установлен, либо расширение браузера отключено. ' +
              `Установите актуальную версию (с поддержкой Manifest V3): ${PLUGIN_URL}`,
          ),
        );
      }, 20000);

      cadesplugin
        .then(async () => {
          clearTimeout(timeout);
          // Промис может резолвиться, когда расширение отвечает, но сам плагин
          // (NPAPI-объект) не поднят — тогда CreateObjectAsync падает на undefined.
          try {
            if (typeof cadesplugin.CreateObjectAsync !== 'function') {
              throw new Error('CreateObjectAsync недоступен');
            }
            const about = await cadesplugin.CreateObjectAsync('CAdESCOM.About');
            await about.Version;
          } catch (probeError) {
            reject(
              new CadesError(
                'Расширение браузера отвечает, но сам КриптоПро ЭЦП Browser plug-in не загружен',
                'Проверьте: 1) установлен ли КриптоПро CSP; 2) установлен ли КриптоПро ЭЦП Browser plug-in ' +
                  '(отдельная программа, не только расширение); 3) включено ли расширение в браузере и ' +
                  'разрешён ли ему доступ к этому сайту; 4) перезапущен ли браузер после установки. ' +
                  `Дистрибутив: ${PLUGIN_URL}. Техническая деталь: ${describe(probeError)}`,
              ),
            );
            return;
          }
          resolve({ api: cadesplugin });
        })
        .catch((e: unknown) => {
          clearTimeout(timeout);
          reject(
            new CadesError(
              'КриптоПро ЭЦП Browser plug-in недоступен: ' + describe(e),
              'Убедитесь, что плагин установлен, расширение браузера включено и ' +
                `используется актуальная версия с поддержкой Manifest V3: ${PLUGIN_URL}`,
            ),
          );
        });
    };

    if (window.cadesplugin) {
      boot();
      return;
    }
    const script = document.createElement('script');
    script.src = `${import.meta.env.BASE_URL}vendor/cadesplugin_api.js`;
    script.onload = boot;
    script.onerror = () =>
      reject(
        new CadesError(
          'Не удалось загрузить cadesplugin_api.js',
          'Файл должен лежать в public/vendor/.',
        ),
      );
    document.head.appendChild(script);
  });

  // при неудаче не кэшируем результат — кнопка «Проверить снова» должна работать
  promise.catch(() => {
    if (pluginPromise === promise) pluginPromise = null;
  });
  pluginPromise = promise;
  return promise;
}

/** Сбор фактов о состоянии плагина — чтобы не гадать по одной строке ошибки. */
export async function pluginDiagnostics(): Promise<string[]> {
  const lines: string[] = [];
  const add = (k: string, v: unknown) => lines.push(`${k}: ${v}`);
  add('userAgent', navigator.userAgent);
  add('origin', location.origin);

  const cp = window.cadesplugin;
  add('window.cadesplugin', cp ? 'есть' : 'НЕТ (скрипт не загрузился)');
  if (!cp) return lines;
  add('JSModuleVersion', cp.JSModuleVersion ?? 'неизвестна');
  add('typeof CreateObjectAsync', typeof cp.CreateObjectAsync);
  add('typeof CreateObject', typeof cp.CreateObject);

  try {
    await Promise.race([
      cp,
      new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут 15 с')), 15000)),
    ]);
    add('промис cadesplugin', 'резолвится');
  } catch (e) {
    add('промис cadesplugin', 'ОТКЛОНЁН — ' + describe(e));
    return lines;
  }

  const withTimeout = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('таймаут')), ms))]);

  try {
    const id = await withTimeout(
      new Promise<string>((res) => cp.get_extension_id?.(res)),
      5000,
    );
    add('ID расширения', id);
    const ver = await withTimeout(
      new Promise<string>((res) => cp.get_extension_version?.(res)),
      5000,
    );
    add('версия расширения', ver);
  } catch (e) {
    add('расширение', 'не отвечает — ' + describe(e));
  }

  try {
    const about = await cp.CreateObjectAsync('CAdESCOM.About');
    add('версия плагина', await about.Version);
  } catch (e) {
    add('CAdESCOM.About', 'ОШИБКА — ' + describe(e));
  }

  try {
    const store = await cp.CreateObjectAsync('CAPICOM.Store');
    await store.Open(CADESCOM.STORE_CURRENT_USER, CADESCOM.STORE_MY, CADESCOM.STORE_OPEN_READ_ONLY);
    const certs = await store.Certificates;
    add('сертификатов в хранилище', await certs.Count);
    await store.Close();
  } catch (e) {
    add('CAPICOM.Store', 'ОШИБКА — ' + describe(e));
  }
  return lines;
}

export function describe(e: unknown): string {
  if (e == null) return 'неизвестная ошибка';
  if (typeof e === 'string') return e;
  const m = (e as any).message ?? String(e);
  return typeof m === 'string' ? m : String(m);
}

/** Переводит техническую ошибку плагина в человекочитаемую. */
export function humanizeCadesError(e: unknown): CadesError {
  if (e instanceof CadesError) return e;
  const raw = describe(e);
  const low = raw.toLowerCase();

  if (low.includes('createobjectasync') || low.includes('pluginobject')) {
    return new CadesError(
      'КриптоПро ЭЦП Browser plug-in не загружен в браузере',
      'Установите КриптоПро CSP и КриптоПро ЭЦП Browser plug-in, включите расширение браузера ' +
        `и перезапустите браузер: ${PLUGIN_URL}. Техническая деталь: ${raw}`,
    );
  }
  if (low.includes('0x8010006e') || low.includes('отменена пользователем') || low.includes('cancelled by the user')) {
    return new CadesError('Ввод PIN-кода отменён пользователем', 'Подписание прервано. Повторите операцию.');
  }
  if (low.includes('0x8009200') || low.includes('0x80090010') || low.includes('keyset')) {
    return new CadesError(
      'Нет доступа к закрытому ключу сертификата',
      'Проверьте, что носитель (токен/флешка) подключён и контейнер доступен.',
    );
  }
  if (low.includes('0x800b0101') || low.includes('срок действия') || low.includes('expired')) {
    return new CadesError('Срок действия сертификата истёк', 'Выберите действующий сертификат.');
  }
  if (low.includes('tsp') || low.includes('tsa') || low.includes('служба штампов') || low.includes('0x8007007b')) {
    return new CadesError(
      'Служба штампов времени (TSA) недоступна',
      'Проверьте адрес TSA и сетевой доступ, либо отключите CAdES-T.',
    );
  }
  if (low.includes('0x800b010a') || low.includes('цепочк') || low.includes('chain')) {
    return new CadesError(
      'Не удалось построить цепочку доверия сертификата',
      'Установите корневой сертификат УЦ в доверенные.',
    );
  }
  return new CadesError('Ошибка КриптоПро: ' + raw);
}

export interface CertificateInfo {
  index: number;
  thumbprint: string;
  subjectName: string;
  issuerName: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  hasPrivateKey: boolean;
  publicKeyOid: string;
  /** Разобранные поля Subject. */
  cn: string;
  surname: string;
  givenName: string;
  org: string;
  inn: string;
  snils: string;
}

/** Разбирает строку SubjectName вида `CN=Иванов, O="ООО ..."` */
export function parseDN(dn: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < dn.length) {
    while (i < dn.length && (dn[i] === ' ' || dn[i] === ',')) i++;
    const eq = dn.indexOf('=', i);
    if (eq < 0) break;
    const key = dn.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let value = '';
    if (dn[i] === '"') {
      i++;
      while (i < dn.length) {
        if (dn[i] === '"' && dn[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (dn[i] === '"') {
          i++;
          break;
        } else {
          value += dn[i++];
        }
      }
    } else {
      while (i < dn.length && dn[i] !== ',') value += dn[i++];
    }
    out[key] = value.trim();
  }
  return out;
}

function toDate(v: unknown): Date {
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Читает личное хранилище пользователя. */
export async function listCertificates(onlyValid = true): Promise<{
  certs: CertificateInfo[];
  handles: any[];
}> {
  await loadPlugin();
  const cadesplugin = getCades();
  try {
    const store = await cadesplugin.CreateObjectAsync('CAPICOM.Store');
    await store.Open(
      CADESCOM.STORE_CURRENT_USER,
      CADESCOM.STORE_MY,
      CADESCOM.STORE_OPEN_READ_ONLY,
    );
    let collection = await store.Certificates;
    if (onlyValid) {
      collection = await collection.Find(CADESCOM.FIND_TIME_VALID);
    }
    const count = await collection.Count;
    const certs: CertificateInfo[] = [];
    const handles: any[] = [];

    for (let i = 1; i <= count; i++) {
      const cert = await collection.Item(i);
      const subjectName: string = await cert.SubjectName;
      const dn = parseDN(subjectName);
      let publicKeyOid = '';
      try {
        const pk = await cert.PublicKey();
        const alg = await pk.Algorithm;
        publicKeyOid = await alg.Value;
      } catch {
        publicKeyOid = '';
      }
      let hasPrivateKey = false;
      try {
        hasPrivateKey = await cert.HasPrivateKey();
      } catch {
        hasPrivateKey = false;
      }

      certs.push({
        index: handles.length,
        thumbprint: await cert.Thumbprint,
        subjectName,
        issuerName: await cert.IssuerName,
        serialNumber: await cert.SerialNumber,
        validFrom: toDate(await cert.ValidFromDate),
        validTo: toDate(await cert.ValidToDate),
        hasPrivateKey,
        publicKeyOid,
        cn: dn.CN ?? '',
        surname: dn.SN ?? dn.SURNAME ?? '',
        givenName: dn.G ?? dn.GN ?? '',
        org: dn.O ?? '',
        inn: dn.INNLE ?? dn.INN ?? '',
        snils: dn.SNILS ?? '',
      });
      handles.push(cert);
    }
    await store.Close();
    return { certs, handles };
  } catch (e) {
    throw humanizeCadesError(e);
  }
}

/**
 * Подписывает уже посчитанный плагином хэш данных и возвращает detached CMS
 * в base64 — ровно то, что кладётся в /Contents.
 */
export async function signBytes(
  certHandle: any,
  data: Uint8Array,
  opts: { hashAlg: number; useTsa: boolean; tsaUrl?: string },
): Promise<string> {
  await loadPlugin();
  const cadesplugin = getCades();
  try {
    const hashed = await cadesplugin.CreateObjectAsync('CAdESCOM.HashedData');
    await hashed.propset_Algorithm(opts.hashAlg);
    await hashed.propset_DataEncoding(CADESCOM.BASE64_TO_BINARY);
    await hashed.Hash(toBase64(data));

    const signer = await cadesplugin.CreateObjectAsync('CAdESCOM.CPSigner');
    await signer.propset_Certificate(certHandle);
    await signer.propset_Options(CADESCOM.CERT_INCLUDE_WHOLE_CHAIN);
    if (opts.useTsa) {
      if (!opts.tsaUrl) throw new CadesError('Не указан адрес службы штампов времени (TSA)');
      await signer.propset_TSAAddress(opts.tsaUrl);
    }

    const sd = await cadesplugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
    const cms: string = await sd.SignHash(
      hashed,
      signer,
      opts.useTsa ? CADESCOM.CADES_T : CADESCOM.CADES_BES,
    );
    return cms.replace(/[\r\n\s]/g, '');
  } catch (e) {
    throw humanizeCadesError(e);
  }
}

/** Считает хэш плагином и возвращает hex (для отладочной сверки с messageDigest). */
export async function hashBytes(data: Uint8Array, hashAlg: number): Promise<string> {
  await loadPlugin();
  const cadesplugin = getCades();
  try {
    const hashed = await cadesplugin.CreateObjectAsync('CAdESCOM.HashedData');
    await hashed.propset_Algorithm(hashAlg);
    await hashed.propset_DataEncoding(CADESCOM.BASE64_TO_BINARY);
    await hashed.Hash(toBase64(data));
    const value: string = await hashed.Value;
    return value.replace(/\s/g, '').toUpperCase();
  } catch (e) {
    throw humanizeCadesError(e);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/[\r\n\s]/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
