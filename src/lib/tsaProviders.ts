export interface TsaProvider {
  id: string;
  name: string;
  url: string;
  /** Подстроки, по которым узнаём издателя сертификата (issuerName), без учёта регистра. */
  issuerMatch?: string[];
  free: boolean;
  legallyValid: boolean;
  note?: string;
}

export const TSA_PROVIDERS: TsaProvider[] = [
  {
    id: 'tensor',
    name: 'Тензор (Saby)',
    url: 'http://tax4.tensor.ru/tsp-tensor_gost2012/tsp.srf',
    issuerMatch: ['тензор', 'tensor', 'saby', 'сбис'],
    free: true,
    legallyValid: true,
    note: 'Бесплатно для владельцев сертификатов Тензора',
  },
  {
    id: 'skbkontur',
    name: 'СКБ Контур',
    url: 'http://pki.skbkontur.ru/tsp2012/tsp.srf',
    issuerMatch: ['skb kontur', 'скб контур', 'сертум-джи', 'kontur'],
    free: true,
    legallyValid: true,
    note: 'Бесплатно для владельцев сертификатов Контура',
  },
  {
    id: 'sertum-pro',
    name: 'Сертум-Про',
    url: 'http://pki.sertum-pro.ru/tsp2012/tsp.srf',
    issuerMatch: ['сертум-про', 'sertum-pro'],
    free: true,
    legallyValid: true,
    note: 'Бесплатно для владельцев сертификатов Сертум-Про',
  },
  {
    id: 'taxcom',
    name: 'Такском',
    url: 'http://tsp.taxcom.ru/tsp/tsp.srf',
    issuerMatch: ['taxcom', 'такском'],
    free: true,
    legallyValid: true,
    note: 'Бесплатно для владельцев сертификатов Такскома',
  },
  {
    id: 'cryptopro-prod',
    name: 'КриптоПро (боевой TSP)',
    url: 'http://qs.cryptopro.ru/tsp/tsp.srf',
    issuerMatch: ['крипто-про', 'cryptopro', 'крипто про'],
    free: true,
    legallyValid: true,
    note: 'Условия использования уточняйте у КриптоПро — не для всех тарифов',
  },
  {
    id: 'ntssoft',
    name: 'НТСсофт (универсальный)',
    url: 'http://ocsp.ntssoft.ru/tsp/tsp.srf',
    free: true,
    legallyValid: true,
    note:
      'По заявлению НТСсофт работает с сертификатами любого аккредитованного УЦ. Не проверено в проде — протестируйте перед использованием.',
  },
  {
    id: 'test-cryptopro',
    name: 'Тестовый TSP КриптоПро',
    url: 'http://testca2012.cryptopro.ru/tsp/tsp.srf',
    free: true,
    legallyValid: false,
    note: 'ЮРИДИЧЕСКИ НИЧТОЖЕН — только для отладки, не используйте для реальных документов',
  },
];

/** Подбирает провайдера, наиболее подходящего для данного издателя сертификата. */
export function recommendTsaProvider(issuerName: string | null | undefined): TsaProvider {
  const issuer = (issuerName ?? '').toLowerCase();
  const matched = issuer
    ? TSA_PROVIDERS.find((p) => p.issuerMatch?.some((m) => issuer.includes(m)))
    : undefined;
  return matched ?? TSA_PROVIDERS.find((p) => p.id === 'ntssoft')!;
}
