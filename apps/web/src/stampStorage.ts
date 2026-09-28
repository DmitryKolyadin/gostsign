import { DEFAULT_STYLE, parseStyle, type StampStyle } from '@gostsign/core';

const STORAGE_KEY = 'gostsign.stampStyle';

export function loadStyle(): StampStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parseStyle(JSON.parse(raw));
  } catch {
    /* повреждённый профиль — молча откатываемся на классику */
  }
  return DEFAULT_STYLE;
}

export function saveStyle(style: StampStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* приватный режим или переполнение — не критично */
  }
}
