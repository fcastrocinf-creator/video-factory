// Detecta CORTES / micro-escenas en un video (frame-diff = lógica de micro-escenas).
// Útil para cazar transiciones no deseadas (ej. Veo mete un cambio de escena al final).
// Uso: npx tsx scripts/detect-cuts.ts "<video>"
import { buildMotionMap } from '../apps/web/lib/motion-map';

async function main(): Promise<void> {
  const v = process.argv[2];
  if (!v) {
    console.error('uso: tsx scripts/detect-cuts.ts "<video>"');
    process.exit(2);
    return;
  }
  const map = await buildMotionMap({ videoPath: v, sampleFps: 8 });
  const samples = map.samples;
  const meanM = samples.reduce((a, s) => a + s.motionPct, 0) / Math.max(1, samples.length);
  const thr = Math.max(12, meanM * 3);
  const cuts = samples.filter((s) => s.motionPct > thr).map((s) => ({ t: +s.t.toFixed(2), m: +s.motionPct.toFixed(1) }));
  console.log(`mean motion%: ${meanM.toFixed(1)}  ·  umbral corte: ${thr.toFixed(1)}`);
  console.log(`animado: ${map.summary.animatedPct}%`);
  console.log(`segmentos: ${JSON.stringify(map.segments)}`);
  console.log(`CORTES (picos de movimiento = transiciones): ${JSON.stringify(cuts)}`);
  console.log(`últimas muestras: ${JSON.stringify(samples.slice(-10).map((s) => ({ t: +s.t.toFixed(2), m: +s.motionPct.toFixed(1) })))}`);
}
void main();
