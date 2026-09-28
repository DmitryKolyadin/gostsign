/**
 * Настройки окружения ядра. Ядро не знает, каким сборщиком собрано приложение
 * и где лежит его статика, поэтому пути к ассетам задаёт приложение.
 *
 * Ассеты ядра лежат в `packages/core/assets/` и копируются приложением в свою
 * статику: `fonts/PTSans-*.ttf`, `vendor/cadesplugin_api.js`.
 */

export interface FontBuffers {
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}

export interface GostsignConfig {
  /**
   * Базовый URL, по которому доступны ассеты ядра (`fonts/`, `vendor/`).
   * Должен заканчиваться на `/`. По умолчанию `/`.
   */
  assetsBaseUrl: string;
  /** Полный URL `cadesplugin_api.js`; по умолчанию `${assetsBaseUrl}vendor/cadesplugin_api.js`. */
  pluginApiUrl?: string;
  /** Своя загрузка шрифтов штампа (например, чтение с диска в Node). */
  loadFonts?: () => Promise<FontBuffers>;
}

const config: GostsignConfig = { assetsBaseUrl: '/' };

/** Меняет настройки. Вызывать до первого обращения к плагину и шрифтам. */
export function configure(patch: Partial<GostsignConfig>): void {
  Object.assign(config, patch);
  if (!config.assetsBaseUrl.endsWith('/')) config.assetsBaseUrl += '/';
}

export function getConfig(): Readonly<GostsignConfig> {
  return config;
}

export function assetUrl(path: string): string {
  return config.assetsBaseUrl + path.replace(/^\//, '');
}
