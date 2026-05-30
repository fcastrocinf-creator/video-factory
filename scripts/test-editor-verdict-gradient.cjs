// scripts/test-editor-verdict-gradient.cjs
// Test STANDALONE del editor IA con DISTINTAS calidades de input:
//   1. Reporte PERFECTO (debe → publishable / ready=true)
//   2. Reporte con 1 warning menor (debe → minor-polish)
//   3. Reporte con 2 escenas no-animadas (debe → needs-rework)
//   4. Reporte con bug grave de duración (debe → block-shipping)
//
// Validamos que el editor IA gradúa correctamente — no solo bloquea cuando
// hay errores, también APRUEBA cuando todo está OK.
//
// Costo total: ~$0.01-0.02 (4 llamadas Claude Haiku).

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

const CASES = [
  {
    name: '1. PERFECTO (esperado: publishable)',
    expectedSeverity: 'publishable',
    report: {
      pass: true,
      totalScenes: 15,
      scenesWithVideo: 15,
      scenesWithStaticImageOnly: 0,
      scenesMissingVisual: 0,
      audioDurationSec: 38.0,
      scenePlanDurationSec: 38.0,
      durationMismatchSec: 0.0,
      visualSampleSize: 3,
      visualSampleAvgScore: 92,
      visualSampleFailures: 0,
      issues: [],
      rationale: 'Sin issues detectados. 15/15 escenas animadas. Audio y scenes match perfecto.',
    },
  },
  {
    name: '2. 1 WARNING MENOR (esperado: minor-polish o publishable)',
    expectedSeverity: 'minor-polish',
    report: {
      pass: true,
      totalScenes: 15,
      scenesWithVideo: 15,
      scenesWithStaticImageOnly: 0,
      scenesMissingVisual: 0,
      audioDurationSec: 38.0,
      scenePlanDurationSec: 38.2,
      durationMismatchSec: 0.2,
      visualSampleSize: 3,
      visualSampleAvgScore: 82,
      visualSampleFailures: 1,
      issues: [
        {
          severity: 'warning',
          category: 'visual-quality',
          sceneIndex: 7,
          description: 'Scene 7 score 72/100 borderline — fondo levemente sobreexpuesto, pero figura central OK',
          suggestion: 'Opcional: regenerar con prompt agregando "softer ambient lighting"',
        },
      ],
      rationale: 'Mayoría OK, 1 warning menor en scene 7.',
    },
  },
  {
    name: '3. 2 ESCENAS NO-ANIMADAS (esperado: needs-rework)',
    expectedSeverity: 'needs-rework',
    report: {
      pass: false,
      totalScenes: 15,
      scenesWithVideo: 13,
      scenesWithStaticImageOnly: 2,
      scenesMissingVisual: 0,
      audioDurationSec: 38.0,
      scenePlanDurationSec: 38.0,
      durationMismatchSec: 0.0,
      visualSampleSize: 3,
      visualSampleAvgScore: 85,
      visualSampleFailures: 0,
      issues: [
        {
          severity: 'info',
          category: 'missing-animation',
          sceneIndex: 4,
          description: 'Scene 4 no se animó (fallback a estática). Texto: "el zinc reactiva tu drenaje linfático"',
          suggestion: 'Verificar quota Kling/Veo. Regenerar si es escena clave.',
        },
        {
          severity: 'info',
          category: 'missing-animation',
          sceneIndex: 9,
          description: 'Scene 9 no se animó (fallback a estática). Texto: "tus pómulos vuelven a verse"',
          suggestion: 'Verificar quota Kling/Veo. Regenerar si es escena clave.',
        },
      ],
      rationale: '13/15 animadas, 2 escenas estáticas (4 y 9).',
    },
  },
  {
    name: '4. BUG GRAVE DURACIÓN (esperado: block-shipping)',
    expectedSeverity: 'block-shipping',
    report: {
      pass: false,
      totalScenes: 14,
      scenesWithVideo: 14,
      scenesWithStaticImageOnly: 0,
      scenesMissingVisual: 0,
      audioDurationSec: 42.0,
      scenePlanDurationSec: 35.0,
      durationMismatchSec: 7.0,
      visualSampleSize: 0,
      visualSampleFailures: 0,
      issues: [
        {
          severity: 'critical',
          category: 'duration-mismatch',
          sceneIndex: null,
          description: 'Audio (~42.0s) y scene plan (35.0s) difieren en 7.0s. CRITICAL — video corta antes que audio termina.',
          suggestion: 'Extender última scene para cubrir el audio completo.',
        },
      ],
      rationale: 'FALLÓ. 1 critical (duration mismatch 7s).',
    },
  },
];

(async () => {
  const { buildEditorVerdict } = await import(
    '../packages/blocks/post-render-judge/src/index.ts'
  );

  console.log('=== Test de gradación del Editor IA ===\n');

  let correct = 0;
  for (const c of CASES) {
    console.log(`--- ${c.name} ---`);
    const t0 = Date.now();
    const result = await buildEditorVerdict({ report: c.report });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result.isErr()) {
      console.log(`  ✗ ERROR en ${elapsed}s: ${result.error.message}`);
      continue;
    }
    const v = result.value;
    const sevMatch = v.severity === c.expectedSeverity;
    // Para minor-polish toleramos publishable (Claude puede ser permisivo)
    const sevAcceptable =
      sevMatch ||
      (c.expectedSeverity === 'minor-polish' && v.severity === 'publishable');
    const mark = sevAcceptable ? '✓' : '✗';
    if (sevAcceptable) correct++;
    console.log(`  ${mark} Severidad: ${v.severity} (esperado: ${c.expectedSeverity}) — ${elapsed}s`);
    console.log(`    ¿Listo?: ${v.ready ? 'SÍ' : 'NO'}`);
    console.log(`    Veredicto: "${v.verdict.slice(0, 200)}${v.verdict.length > 200 ? '...' : ''}"`);
    if (v.actions.length > 0) {
      console.log(`    Acciones (${v.actions.length}):`);
      for (const a of v.actions.slice(0, 3)) console.log(`      - ${a}`);
    }
    console.log('');
  }

  console.log(`=== Resultado: ${correct}/${CASES.length} casos correctos ===`);
  if (correct === CASES.length) {
    console.log('✓ Editor IA gradúa correctamente en todo el espectro.');
  } else if (correct >= CASES.length - 1) {
    console.log('⚠ Editor IA gradúa MAYORMENTE bien (1 borderline acceptable).');
  } else {
    console.log('✗ Editor IA tiene fallas de calibración — revisar SYSTEM_PROMPT.');
  }
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
