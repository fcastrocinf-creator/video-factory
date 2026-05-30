// scripts/test-ad-analyzer.ts (corre con: pnpm exec tsx scripts/test-ad-analyzer.ts <video>)
//
// Mide el conteo de escenas que detecta el ad-analyzer mejorado contra un video
// real. Comparable con baseline anterior (e.g., 15 escenas) para validar que el
// prompt v2 (detección exhaustiva) corrige el sub-counting.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeAd } from '../apps/web/lib/ad-analyzer';

function loadEnv(): void {
  const envPath = resolve(import.meta.dirname, '..', '.env');
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
  console.error('Usage: pnpm exec tsx scripts/test-ad-analyzer.ts <path/to/video.mp4>');
  process.exit(1);
}

(async () => {
  console.log('Video: ' + videoPath);
  console.log('Modelo: gemini-2.5-pro (prompt v2: detección exhaustiva, temp=0)');
  console.log('');
  console.log('Analizando... ~30-90s inline, +5-20s para >14 MB (File API).');
  console.log('');

  const t0 = Date.now();
  const analysis = await analyzeAd({ videoPath, mimeType: 'video/mp4' });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const dens = analysis.totalDurationSeconds / analysis.scenes.length;
  console.log('=== RESULTADO ===');
  console.log('language:           ' + analysis.language);
  console.log('totalDurationSec:   ' + analysis.totalDurationSeconds);
  console.log('scenes count:       ' + analysis.scenes.length);
  console.log('densidad:           1 escena cada ' + dens.toFixed(1) + 's');
  console.log('hookType:           ' + analysis.hookType);
  console.log('product:            ' + (analysis.product?.name ?? '?'));
  console.log('');
  console.log('=== ESCENAS DETECTADAS ===');
  for (const s of analysis.scenes) {
    const dur = (s.endSec - s.startSec).toFixed(1);
    console.log(`  ${String(s.index).padStart(2, '0')} [${s.startSec.toFixed(1)}s → ${s.endSec.toFixed(1)}s, ${dur}s]`);
    console.log(`     ${s.visualDescription.slice(0, 120)}`);
  }
  console.log('');
  console.log('Análisis tomó ' + elapsedSec + 's');

  const outPath = resolve(import.meta.dirname, '..', 'storage', 'probe', 'ad-analysis-result.json');
  writeFileSync(outPath, JSON.stringify(analysis, null, 2), 'utf-8');
  console.log('JSON completo guardado en: ' + outPath);
  process.exit(0);
})().catch((e: unknown) => {
  console.error('Falló:', (e as Error).message);
  if (e instanceof Error && e.stack) {
    console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  }
  process.exit(1);
});
