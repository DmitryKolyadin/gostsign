// Кладёт ассеты @gostsign/core (шрифты штампа, cadesplugin_api.js) в public/.
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const core = dirname(require.resolve('@gostsign/core/package.json'));
const pub = new URL('../public/', import.meta.url).pathname;
for (const dir of ['fonts', 'vendor']) {
  await cp(join(core, 'assets', dir), join(pub, dir), { recursive: true });
}
