// scripts/test-editor-verdict-standalone.cjs
// Test STANDALONE del editor IA verdict.
// Usa el post-render-report.json del Test 8 (que ya existe en disk) y le pide
// a Claude que actúe como editor. Sin tocar pipeline, sin gastar en video.
//
// Costo: ~$0.001-0.003 (1 llamada Claude Haiku).
// Output: verdict en consola + archivo storage/probe/test-verdict-{ts}.md

const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

(async () => {
  const { buildEditorVerdict } = await import(
    '../packages/blocks/post-render-judge/src/index.ts'
  );

  // Usar el report.json del Test 8 (mismatch critical detectado)
  const reportPath = resolve(
    __dirname,
    '..',
    'storage',
    'runs',
    '2ab64b04-66c9-4334-9d15-0043071a0109',
    'post-render-report.json',
  );
  if (!existsSync(reportPath)) {
    console.error(`✗ Report no existe: ${reportPath}`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  console.log('=== REPORT (input al editor IA) ===');
  console.log(`Total scenes: ${report.totalScenes}`);
  console.log(`Animadas: ${report.scenesWithVideo}`);
  console.log(`Issues: ${report.issues.length}`);
  for (const i of report.issues) {
    console.log(`  - [${i.severity}/${i.category}] ${i.description}`);
  }
  console.log('');

  console.log('Llamando al editor IA (Claude Haiku 4.5)...');
  const t0 = Date.now();
  const result = await buildEditorVerdict({ report });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.isErr()) {
    console.error(`✗ Editor IA FALLÓ en ${elapsed}s`);
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
  }

  const v = result.value;
  console.log(`\n✓ Editor respondió en ${elapsed}s`);
  console.log('');
  console.log(`Severidad: ${v.severity}`);
  console.log(`¿Listo?:   ${v.ready ? 'SÍ' : 'NO'}`);
  console.log('');
  console.log('=== VEREDICTO (lenguaje natural) ===');
  console.log(v.verdict);
  console.log('');
  if (v.actions.length > 0) {
    console.log(`=== ACCIONES REQUERIDAS (${v.actions.length}) ===`);
    for (const a of v.actions) console.log(`  → ${a}`);
  }

  // Persistir markdown
  const outPath = resolve(
    __dirname,
    '..',
    'storage',
    'probe',
    `test-verdict-${Date.now()}.md`,
  );
  const md = [
    `# Editor IA Verdict (standalone test)`,
    `**Severidad:** ${v.severity}`,
    `**¿Listo?:** ${v.ready ? '✅ SÍ' : '❌ NO'}`,
    ``,
    `## Veredicto`,
    ``,
    v.verdict,
    ``,
    v.actions.length > 0 ? `## Acciones` : '',
    ...v.actions.map((a) => `- ${a}`),
  ].join('\n');
  writeFileSync(outPath, md, 'utf-8');
  console.log(`\nSaved: ${outPath}`);
  console.log('\n✓ EDITOR IA FUNCIONA standalone.');
  console.log('  Si Test 8 NO generó verdict.md, el problema es de Next.js, NO del código del editor.');
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
