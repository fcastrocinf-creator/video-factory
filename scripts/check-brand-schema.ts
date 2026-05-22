// Verifica que todos los packages/brands/*.brand.json validan contra el schema
// actualizado de BrandConfig (incluye ingredients con defaults).
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrandConfigSchema } from '@video-factory/contracts';

async function main() {
  const dir = resolve('packages/brands');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.brand.json'));
  let ok = 0;
  let fail = 0;
  for (const f of files) {
    const raw = JSON.parse(await readFile(resolve(dir, f), 'utf-8'));
    const p = BrandConfigSchema.safeParse(raw);
    if (p.success) {
      console.log(`${f}: OK (ingredients defaults: assets=${p.data.ingredients.assets.length}, colors=${p.data.ingredients.colorPalette.length})`);
      ok++;
    } else {
      console.error(`${f}: FAIL - ${p.error.message.slice(0, 300)}`);
      fail++;
    }
  }
  console.log(`\n${ok}/${files.length} brands válidos${fail ? ` (${fail} fallaron)` : ''}`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
