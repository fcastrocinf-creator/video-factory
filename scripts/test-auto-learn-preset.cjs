// scripts/test-auto-learn-preset.cjs
// Test M7-B v1: autoLearnPresetFromVideo end-to-end.
// Costo: ~$0.05 (1 llamada understandVideo). Tiempo: ~20s.

const { readFileSync } = require('node:fs');
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
  const { autoLearnPresetFromVideo } = await import(
    '../apps/web/lib/auto-learn-preset.ts'
  );

  const videoPath = resolve(
    __dirname,
    '..',
    'storage',
    'rips',
    '27ad591c-ad6c-4975-ba92-59f25e06dfda',
    'source.mp4',
  );
  console.log('=== Test auto-learn-preset ===');
  console.log(`Video: ${videoPath}`);
  console.log('');

  const result = await autoLearnPresetFromVideo({
    videoPath,
    brandIdForContext: 'vitaly',
  });

  console.log(`✓ Preset auto-aprendido en ${result.elapsedSec.toFixed(1)}s`);
  console.log(`  ID: ${result.presetId}`);
  console.log(`  Display name: ${result.preset.displayName}`);
  console.log(`  Format: ${result.preset.format?.id}`);
  console.log(`  Style: ${result.preset.style?.id}`);
  console.log(`  Category: ${result.preset.category?.id}`);
  console.log(`  Hook: ${result.preset.classification.hookAngulo}`);
  console.log(`  Visual engine: ${result.preset.visualEngine}`);
  console.log(`  Scenes/min: ${result.preset.scenesPerMinute}`);
  console.log(`  Default duration: ${result.preset.defaultDurationSeconds}s`);
  console.log('');
  console.log(`  Description: ${result.preset.description.slice(0, 250)}`);
  console.log('');
  console.log(`  Prompt template (first 250): "${result.preset.visualStyle.promptTemplate.slice(0, 250)}..."`);
  console.log('');
  console.log(`  Style boilerplate: "${result.preset.visualStyle.styleBoilerplate?.slice(0, 200)}..."`);
  console.log(`  Forbidden terms: ${result.preset.visualStyle.forbiddenStyleTerms?.join(', ')}`);
  console.log('');
  console.log(`Persisted at:`);
  console.log(`  Preset:        ${result.presetFilePath}`);
  console.log(`  Understanding: ${result.understandingFilePath}`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
