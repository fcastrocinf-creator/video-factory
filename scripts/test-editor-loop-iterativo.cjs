// scripts/test-editor-loop-iterativo.cjs
// Test STANDALONE del loop iterativo conversacional.
//
// Simula:
//   Iteración 1: Editor IA ve report con mismatch 5s → pide extend-duration
//   [Mock executor "ejecuta" la acción y devuelve report con mismatch=0]
//   Iteración 2: Editor IA ve report OK → pide approve
//   Loop termina aprobado en 2 iteraciones.
//
// Costo: ~$0.006 (2 llamadas Haiku).

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
  const { runEditorLoop } = await import(
    '../packages/blocks/post-render-judge/src/index.ts'
  );

  // Reporte inicial: scene plan termina 5s antes que audio → bug clásico
  const initialReport = {
    pass: false,
    totalScenes: 14,
    scenesWithVideo: 14,
    scenesWithStaticImageOnly: 0,
    scenesMissingVisual: 0,
    audioDurationSec: 42.0,
    scenePlanDurationSec: 37.0,
    durationMismatchSec: 5.0,
    visualSampleSize: 3,
    visualSampleAvgScore: 88,
    visualSampleFailures: 0,
    issues: [
      {
        severity: 'critical',
        category: 'duration-mismatch',
        sceneIndex: null,
        description:
          'Audio (~42.0s) y scene plan (37.0s) difieren en 5.0s. CRITICAL — video corta antes que audio termina.',
        suggestion: 'Extender última scene para cubrir el audio completo.',
      },
    ],
    rationale: 'FALLÓ. 1 critical (duration mismatch 5s).',
  };

  // Mock executor — simula que el pipeline ejecuta la acción y devuelve nuevo report
  const executor = {
    async executeAction(action) {
      console.log(`  [executor] Ejecutando acción: ${action.type}`);
      if (action.type === 'extend-duration') {
        console.log(`    → scene ${action.sceneIndex} extendida a ${action.newEndTimeSeconds}s`);
        console.log(`    → razón: "${action.reason}"`);
        // Simular re-render exitoso: ahora scenes coinciden con audio
        return {
          ...initialReport,
          pass: true,
          scenePlanDurationSec: action.newEndTimeSeconds,
          durationMismatchSec: Math.abs(initialReport.audioDurationSec - action.newEndTimeSeconds),
          issues: [],
          rationale: `Post-render OK después de extend-duration en scene ${action.sceneIndex}.`,
        };
      }
      throw new Error(`Acción no soportada en este mock: ${action.type}`);
    },
  };

  console.log('=== Test loop iterativo conversacional ===\n');
  console.log('Reporte INICIAL:');
  console.log(`  Audio: ${initialReport.audioDurationSec}s | Scene plan: ${initialReport.scenePlanDurationSec}s`);
  console.log(`  Mismatch: ${initialReport.durationMismatchSec}s`);
  console.log(`  Issues: ${initialReport.issues.length}`);
  console.log('');
  console.log('Iniciando loop...\n');

  const t0 = Date.now();
  const result = await runEditorLoop(initialReport, executor);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.isErr()) {
    console.error(`✗ LOOP FALLÓ en ${elapsed}s`);
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
  }

  const r = result.value;
  console.log(`\n=== Resultado del loop (${elapsed}s, ${r.iterations} iteraciones) ===`);
  console.log(`Aprobado: ${r.approved ? '✓ SÍ' : '✗ NO'}`);
  console.log(`Manual fix required: ${r.manualFixRequired ? 'SÍ' : 'NO'}`);
  console.log(`Exhausted (max iter): ${r.exhausted ? 'SÍ' : 'NO'}`);
  console.log('');
  console.log('=== Conversación completa ===');
  for (const turn of r.conversation) {
    console.log(`\n--- Iteración ${turn.iteration} ---`);
    console.log(`Severity: ${turn.verdict.severity}`);
    console.log(`Verdict: "${turn.verdict.verdict}"`);
    console.log(`Action: ${JSON.stringify(turn.verdict.actions[0], null, 2)}`);
  }

  console.log('');
  if (r.approved && r.iterations === 2) {
    console.log('✓ LOOP CONVERSACIONAL FUNCIONA — bug detectado → fix ejecutado → re-validado → aprobado.');
  } else if (r.approved) {
    console.log(`⚠ Aprobado en ${r.iterations} iteraciones (esperaba 2).`);
  } else {
    console.log(`✗ NO aprobado tras ${r.iterations} iteraciones.`);
  }
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
