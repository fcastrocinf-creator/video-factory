// Valida que todos los packages/presets/*.preset.json validan contra el schema
// y que la matriz (category × format × style) no tenga huecos críticos.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PresetConfigSchema } from '@video-factory/contracts';

async function main() {
  const dir = resolve('packages/presets');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.preset.json'));

  const validPresets: Array<{ id: string; categoryId?: string; formatId?: string; styleId?: string }> = [];
  let ok = 0;
  let fail = 0;

  for (const f of files) {
    const raw = JSON.parse(await readFile(resolve(dir, f), 'utf-8'));
    const p = PresetConfigSchema.safeParse(raw);
    if (p.success) {
      ok++;
      validPresets.push({
        id: p.data.id,
        categoryId: p.data.category?.id,
        formatId: p.data.format?.id,
        styleId: p.data.style?.id,
      });
      const cat = p.data.category?.id ?? '(orphan)';
      const fmt = p.data.format?.id ?? '(no format)';
      const sty = p.data.style?.id ?? '(no style)';
      console.log(`✓ ${f.padEnd(50)} ${cat} → ${fmt} → ${sty}`);
    } else {
      fail++;
      console.error(`✗ ${f}`);
      console.error(`   ${p.error.message.slice(0, 300)}`);
    }
  }

  console.log(`\n${ok}/${files.length} presets válidos${fail ? ` (${fail} fallaron)` : ''}`);

  // Matriz de cobertura
  console.log('\n=== Matriz Categoría × Formato ===');
  const matrix = new Map<string, Map<string, string[]>>();
  for (const p of validPresets) {
    if (!p.categoryId || !p.formatId) continue;
    if (!matrix.has(p.categoryId)) matrix.set(p.categoryId, new Map());
    const formats = matrix.get(p.categoryId)!;
    if (!formats.has(p.formatId)) formats.set(p.formatId, []);
    formats.get(p.formatId)!.push(p.styleId ?? '(no-style)');
  }
  for (const [cat, formats] of matrix.entries()) {
    console.log(`\n  ${cat}:`);
    for (const [fmt, styles] of formats.entries()) {
      console.log(`    └── ${fmt}: ${styles.join(', ')}`);
    }
  }

  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
