// scripts/test-video-understander.cjs
// Test STANDALONE de M7 Pieza A — video-understander.
// Usa el source.mp4 del rip Vitaly (12MB, ya existe).
// Costo: ~$0.04. Tiempo: ~15-25s.

const { readFileSync, writeFileSync } = require('node:fs');
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
  const { understandVideo } = await import(
    '../apps/web/lib/video-understander.ts'
  );

  const videoPath = resolve(
    __dirname,
    '..',
    'storage',
    'rips',
    '27ad591c-ad6c-4975-ba92-59f25e06dfda',
    'source.mp4',
  );
  const workDir = resolve(
    __dirname,
    '..',
    'storage',
    'probe',
    'video-understander-test',
  );

  console.log('=== Test video-understander ===');
  console.log(`Video: ${videoPath}`);
  console.log(`WorkDir: ${workDir}`);
  console.log('');
  console.log('Extrayendo keyframes + analizando con Claude Haiku...');

  const result = await understandVideo({
    videoPath,
    workDir,
    keyframeCount: 5,
  });

  console.log('');
  console.log(`✓ Análisis OK en ${result.elapsedSec.toFixed(1)}s (${result.keyframes.length} keyframes, ${result.modelUsed})`);
  console.log('');

  const u = result.understanding;
  console.log(`Style ID: ${u.styleId}`);
  console.log(`Style desc: ${u.styleDescription.slice(0, 200)}`);
  console.log(`Hook type: ${u.hookType}`);
  console.log(`Hook desc: ${u.hookDescription.slice(0, 200)}`);
  console.log(`Palette: ${u.palette.join(', ')}`);
  console.log('');
  if (u.character) {
    console.log(`Personaje: ${u.character.gender} ${u.character.ageRange}`);
    console.log(`  ${u.character.description.slice(0, 200)}`);
  } else {
    console.log('Personaje: ninguno (B-ROLL puro)');
  }
  console.log('');
  console.log(`Producto:`);
  console.log(`  Visual: ${u.productPresentation.productVisualDescription.slice(0, 200)}`);
  console.log(`  Forma de uso: ${u.productPresentation.usageForm ?? '(no especificada)'}`);
  console.log(`  Aparece en scenes: ${u.productPresentation.appearsInScenes.join(', ')}`);
  console.log('');
  console.log(`Scenes detectadas: ${u.scenes.length}`);
  for (const [i, s] of u.scenes.entries()) {
    console.log(`  [${i}] t=${s.sourceTimeSec.toFixed(1)}s [${s.narrativeBeat}/${s.shotType}/${s.mood}]`);
    console.log(`      ${s.visualDescription.slice(0, 150)}`);
  }
  console.log('');
  console.log(`Suggested preset:`);
  console.log(`  Format: ${u.suggestedPreset.format}`);
  console.log(`  Estrategia: ${u.suggestedPreset.estrategia}`);
  console.log(`  Visual engine: ${u.suggestedPreset.visualEngine}`);
  console.log(`  Scenes/min: ${u.suggestedPreset.scenesPerMinute}`);
  console.log(`  Duration: ${u.suggestedPreset.defaultDurationSeconds}s`);
  console.log(`  Prompt template: "${u.suggestedPreset.promptTemplate.slice(0, 200)}..."`);
  console.log('');
  console.log(`EJECUTIVO: ${u.executiveSummary}`);
  console.log('');

  // Persistir el análisis completo
  const outPath = resolve(workDir, 'understanding.json');
  writeFileSync(outPath, JSON.stringify(u, null, 2), 'utf-8');
  console.log(`Saved: ${outPath}`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
