// scripts/test-m9-context.cjs
// Test M9: verifica que el system context se genera correctamente y que
// los eventos se persisten al log.

const { readFileSync, existsSync } = require('node:fs');
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
  const { buildSystemContext, formatSystemContextForPrompt } = await import(
    '../apps/web/lib/system-context.ts'
  );
  const { logSystemEvent } = await import('../apps/web/lib/system-log.ts');

  console.log('=== Test M9: System Context ===\n');

  // Trigger un log para validar
  await logSystemEvent({
    kind: 'config-changed',
    data: { test: 'm9-validation' },
    summary: 'Test M9 standalone validation run',
  });

  const ctx = await buildSystemContext();
  console.log(`Brands: ${ctx.brands.length}`);
  console.log(`Presets active: ${ctx.presets.active.length}`);
  console.log(`Presets pending: ${ctx.presets.pending.length}`);
  console.log(`Image providers: ${ctx.imageProviders.length}`);
  console.log(`Animation providers: ${ctx.animationProviders.length}`);
  console.log(`TTS providers: ${ctx.ttsProviders.length}`);
  console.log(`Design decisions: ${ctx.designDecisions.length}`);
  console.log(`IA layers: ${ctx.iaLayers.length}`);
  console.log('');

  const formatted = formatSystemContextForPrompt(ctx);
  console.log(`Formatted length: ${formatted.length} chars`);
  console.log('');
  console.log('=== Formatted preview (primeros 1500 chars) ===');
  console.log(formatted.slice(0, 1500));
  console.log('...');
  console.log('');

  // Verificar que el log se persistió
  const logPath = resolve(__dirname, '..', 'storage', 'system-log.jsonl');
  if (existsSync(logPath)) {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    console.log(`✓ system-log.jsonl existe con ${lines.length} eventos`);
  } else {
    console.log('✗ system-log.jsonl NO existe');
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
