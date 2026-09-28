# @gostsign/core

Движок PAdES-подписи PDF сертификатами ГОСТ Р 34.10 через КриптоПро ЭЦП Browser plug-in.
Без UI и без привязки к сборщику: работает в Vite, Next.js и где угодно в браузере.

Собственной криптографии нет: хэш и подпись считает КриптоПро CSP на машине пользователя.

## Подключение

1. Раздайте ассеты из `assets/` как статику приложения:
   `fonts/PTSans-Regular.ttf`, `fonts/PTSans-Bold.ttf`, `vendor/cadesplugin_api.js`.
2. До первого обращения к плагину укажите, где они лежат:

```ts
import { configure } from '@gostsign/core';
configure({ assetsBaseUrl: '/gostsign/' });
```

Пакет публикуется исходниками TypeScript (`exports` указывает на `src/index.ts`),
поэтому сборщик приложения должен транспилировать его (в Next.js — `transpilePackages`).

## Подписание

```ts
import {
  listCertificates, inspectPdf, defaultPlacement, signPdf, recommendTsaProvider, PRESETS,
} from '@gostsign/core';

const { certs, handles } = await listCertificates();
const cert = certs[0];
const info = await inspectPdf(pdfBytes);
const style = PRESETS.classic.style;

const result = await signPdf(pdfBytes, {
  certificate: cert,
  certHandle: handles[cert.index],
  style,
  placement: defaultPlacement(info, info.pageSizes.length - 1, style),
  tsa: { url: recommendTsaProvider(cert.issuerName).url, fallback: 'bes' },
});
// result.bytes — исходный файл + incremental update с подписью
// result.level — 'CAdES-T' или 'CAdES-BES' (если TSA был недоступен, причина в result.tsaError)
```

Низкоуровневые шаги (`preparePdf` → `signBytes` → `embedSignature`) тоже экспортируются —
например, для своей оркестрации пакетной подписи.

## Ошибки

`CadesError` и `PdfSignError` несут `message` и `hint` для пользователя.
У `CadesError` есть `code` (`cancelled`, `tsa_unavailable`, `no_private_key`, `plugin_unavailable`, …),
по которому приложение принимает решения, не разбирая текст.

## Сертификат

`CertificateInfo` кроме DN содержит реквизиты владельца: `personInn`, `orgInn`, `snils`, `ogrn`.
Разбор понимает разные написания атрибутов (`INN` / `ИНН` / `OID.1.2.643.3.131.1.1`, `INNLE`,
старый формат «00» + ИНН юрлица) — см. `subjectIds`.

## Проверка

```bash
pnpm check   # оффлайн: incremental update, мультиподпись, разбор реквизитов
```
