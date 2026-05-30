// scripts/test-ad-analyzer.cjs
// Mide el conteo de escenas que detecta el ad-analyzer mejorado contra un video real.
// Comparable con baseline (15 escenas) detectado por la versión previa del prompt.
//
// Usage: node scripts/test-ad-analyzer.cjs <path/to/video.mp4>
//
// Requiere GOOGLE_AI_API_KEY o GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS

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

const videoPath = process.argv[2];
if (!videoPath) {
  console.error('Usage: node scripts/test-ad-analyzer.cjs <path/to/video.mp4>');
  process.exit(1);
}

(async () => {
  console.log('Video: ' + videoPath);
  console.log('Modelo: gemini-2.5-pro (con prompt v2: detección exhaustiva)');
  console.log('');
  console.log('Analizando... esto tarda ~30-90s para videos < 14 MB inline, +5-20s para >14 MB (File API).');
  console.log('');

  const t0 = Date.now();

  // Import dinámico del módulo TS — Node 22+ con --experimental-strip-types
  const { analyzeAd } = await import(
    '../apps/web/lib/ad-analyzer.ts'
  );

  const analysis = await analyzeAd({ videoPath, mimeType: 'video/mp4' });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('=== RESULTADO DEL ANÁLISIS ===');
  console.log('language:           ' + analysis.language);
  console.log('totalDurationSec:   ' + analysis.totalDurationSeconds);
  console.log('scenes count:       ' + analysis.scenes.length);
  console.log('densidad:           1 escena cada ' +
    (analysis.totalDurationSeconds / analysis.scenes.length).toFixed(1) + 's');
  console.log('hookType:           ' + analysis.hookType);
  console.log('product:            ' + (analysis.product?.name ?? '?'));
  console.log('');
  console.log('=== ESCENAS DETECTADAS ===');
  for (const s of analysis.scenes) {
    const dur = (s.endSec - s.startSec).toFixed(1);
    console.log(`  ${String(s.index).padStart(2,'0')} [${s.startSec.toFixed(1)}s → ${s.endSec.toFixed(1)}s, ${dur}s]`);
    console.log(`     ${s.visualDescription.slice(0, 120)}`);
  }
  console.log('');
  console.log('Análisis tomó ' + elapsedSec + 's');

  // Persistir resultado completo para inspección
  const outPath = resolve(__dirname, '..', 'storage', 'probe', 'ad-analysis-result.json');
  writeFileSync(outPath, JSON.stringify(analysis, null, 2), 'utf-8');
  console.log('JSON completo guardado en: ' + outPath);
  process.exit(0);
})().catch((e) => {
  console.error('Falló:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
