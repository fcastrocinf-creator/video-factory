// FIXTURE TEST — VALIDATOR CHAT IA v3 regression suite.
//
// Corre VALIDATOR contra una lista de casos conocidos (bad + good) y reporta:
//   - Recall por categoría: % de casos bad caught con verdict='wrong'
//   - Precision en controles: % de casos good marcados 'right' o 'accept-with-warnings'
//   - Tiempo y costo totales
//
// El fixture se define inline acá (no JSON externo) — más fácil de editar y leer.
//
// Uso (con env exportado):
//   export ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY= .env | cut -d= -f2-)
//   node --import tsx scripts/test-validator-fixture.ts

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
process.chdir(REPO_ROOT);

import { validateScene } from '../apps/web/lib/validator-chat-ia.js';

interface FixtureCase {
  label: string;
  description: string;
  /** known-bad o known-good */
  kind: 'bad' | 'good';
  /** Categoría esperada (si bad). Lista — VALIDATOR podría devolver múltiples. */
  expectedCategories?: string[];
  imagePath: string;
  /** Si pasamos clip, también lo evalúa. Si solo image, animationOk será null. */
  videoPath?: string;
  scene: {
    index: number;
    text: string;
    imagePrompt: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
  };
  brandContext: {
    productName: string;
    productDescription: string;
    productUsageForm: string;
    styleSummary: string;
    language: string;
  };
}

const SOOMI_VITALY_BRAND = {
  productName: 'Vitaly Gotas',
  productDescription:
    'Suplemento sublingual en gotas para drenaje linfático. Se aplican unas gotas bajo la lengua.',
  productUsageForm: 'sublingual',
  styleSummary: 'B-ROLL Animado · Comic / Acuarela Sepia',
  language: 'es',
};

// 1103a786 = primer rip SOOMI (39 scenes, con varios errores reportados)
const RUN_1 = resolve(REPO_ROOT, 'storage', 'runs', '1103a786-630f-4d22-8047-fb2246d20d6e');
// f1979a90 = segundo rip SOOMI (39 scenes, logical-coherence error en scene 19)
const RUN_2 = resolve(REPO_ROOT, 'storage', 'runs', 'f1979a90-17bf-4e82-bf42-e3915fd61c1b');

const FIXTURES: FixtureCase[] = [
  // ────────────────────────────────────────────────────────────
  // KNOWN-BAD: cada uno debe ser marcado 'wrong' con categoría esperada
  // ────────────────────────────────────────────────────────────
  {
    label: 'BAD-burned-text-leaked',
    description: 'Scene 77 — botón con texto "Click Here" en inglés (ad ES)',
    kind: 'bad',
    expectedCategories: ['burned-text-leaked', 'burned-text-gibberish', 'other'],
    imagePath: resolve(RUN_1, 'scene_77.png'),
    // NO videoPath — solo testeamos la imagen estática
    scene: {
      index: 77,
      text: 'haga click ahora y reciba el protocolo en su email',
      imagePrompt: 'Vintage comic style call-to-action scene with button',
      startTimeSeconds: 200,
      endTimeSeconds: 210,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
  {
    label: 'BAD-anatomy',
    description: 'Scene 0 — tobillo con 4 dedos en lugar de 5',
    kind: 'bad',
    expectedCategories: ['anatomy'],
    imagePath: resolve(RUN_1, 'scene_00.png'),
    scene: {
      index: 0,
      text: 'Este es el tobillo de Laura antes de seguir el protocolo europeo',
      imagePrompt:
        'A detailed anatomical illustration of a very swollen, puffy human ankle. The foot has five toes.',
      startTimeSeconds: 0,
      endTimeSeconds: 4.5,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
  {
    label: 'BAD-logical-coherence',
    description:
      'Scene 19 f1979a90 — muestra absorción EXITOSA cuando narrador dice que falla',
    kind: 'bad',
    expectedCategories: ['logical-coherence', 'brand', 'subject'],
    imagePath: resolve(RUN_2, 'scene_19.png'),
    scene: {
      index: 19,
      text: 'las pastillas no se absorben bien en el cuerpo, gran parte se desperdicia',
      imagePrompt:
        'Vintage medical illustration of pills entering the bloodstream successfully',
      startTimeSeconds: 95,
      endTimeSeconds: 100,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
  {
    label: 'BAD-static-loop',
    description: 'Scene 5 1103a786 — clip animado completamente estático',
    kind: 'bad',
    expectedCategories: ['static-loop'],
    imagePath: resolve(RUN_1, 'scene_05.png'),
    videoPath: resolve(RUN_1, 'scene_05.mp4'), // SÍ clip — testeamos static-loop
    scene: {
      index: 5,
      text: 'Escúcheme bien',
      imagePrompt: 'Vintage comic physiotherapist man speaking direct to camera',
      startTimeSeconds: 16,
      endTimeSeconds: 18,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
  // ────────────────────────────────────────────────────────────
  // KNOWN-GOOD: deben ser marcados 'right' o 'accept-with-warnings'
  // ────────────────────────────────────────────────────────────
  {
    label: 'GOOD-anatomical-clean',
    description: 'Scene 2 — tobillo curado, anatomía correcta, sin texto',
    kind: 'good',
    imagePath: resolve(RUN_1, 'scene_02.png'),
    // NO videoPath — solo testeamos la imagen estática (el clip de scene 2
    // estaba static-loop pero la imagen sola debería pasar)
    scene: {
      index: 2,
      text: 'Este es el mismo tobillo, ocho semanas después.',
      imagePrompt:
        'Anatomical illustration of a healthy slim ankle with 5 toes, vintage sepia comic style',
      startTimeSeconds: 6,
      endTimeSeconds: 9,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
  {
    label: 'GOOD-diagram-clean',
    description: 'Scene 3 — diagrama del sistema linfático, educacional',
    kind: 'good',
    imagePath: resolve(RUN_1, 'scene_03.png'),
    scene: {
      index: 3,
      text: 'La retención de líquidos crónica es más fácil de manejar en la edad adulta',
      imagePrompt:
        'Diagram of human lymphatic system showing blocked fluid in legs and arms, vintage educational illustration',
      startTimeSeconds: 9,
      endTimeSeconds: 14,
    },
    brandContext: SOOMI_VITALY_BRAND,
  },
];

const logger = {
  info: (_o: unknown, _m?: string) => {
    /* silenciado para no inflar output */
  },
  warn: (o: unknown, m?: string) => {
    console.warn(`[WARN] ${m ?? ''}`, JSON.stringify(o).slice(0, 200));
  },
};

interface FixtureRunResult {
  label: string;
  kind: 'bad' | 'good';
  passed: boolean;
  verdict: string;
  confidence: number;
  nextAction: string;
  caughtCategories: string[];
  expectedCategories?: string[];
  matchedExpected: boolean;
  elapsedSec: number;
  thinkingChars: number;
  details: string;
}

async function runFixture(fixture: FixtureCase): Promise<FixtureRunResult> {
  if (!existsSync(fixture.imagePath)) {
    return {
      label: fixture.label,
      kind: fixture.kind,
      passed: false,
      verdict: 'MISSING_FILE',
      confidence: 0,
      nextAction: 'n/a',
      caughtCategories: [],
      expectedCategories: fixture.expectedCategories,
      matchedExpected: false,
      elapsedSec: 0,
      thinkingChars: 0,
      details: `imagePath no existe: ${fixture.imagePath}`,
    };
  }

  const t0 = Date.now();
  const result = await validateScene({
    runId: `fixture-${fixture.label}-${Date.now()}`,
    scene: fixture.scene as never,
    staticImagePath: fixture.imagePath,
    animatedVideoPath: fixture.videoPath,
    brandContext: fixture.brandContext,
    scenePosition: {
      index: fixture.scene.index,
      total: 40,
      narrativeBeat: 'mechanism',
    },
    attempt: 1,
    logger,
  });
  const elapsedSec = (Date.now() - t0) / 1000;

  if (!result.verdict) {
    return {
      label: fixture.label,
      kind: fixture.kind,
      passed: false,
      verdict: 'API_ERROR',
      confidence: 0,
      nextAction: 'n/a',
      caughtCategories: [],
      expectedCategories: fixture.expectedCategories,
      matchedExpected: false,
      elapsedSec,
      thinkingChars: 0,
      details: result.error?.message ?? 'unknown',
    };
  }

  const v = result.verdict;
  const caughtCategories = v.issues.map((i) => i.category);
  const thinkingChars = result.history.thinkingContent?.length ?? 0;

  let passed = false;
  let matchedExpected = false;
  let details = '';

  if (fixture.kind === 'bad') {
    // Esperamos verdict='wrong' Y al menos una de las expectedCategories
    const wrongVerdict = v.verdict === 'wrong';
    const hasExpectedCat = fixture.expectedCategories
      ? fixture.expectedCategories.some((cat) => caughtCategories.includes(cat))
      : true;
    matchedExpected = hasExpectedCat;
    passed = wrongVerdict && hasExpectedCat;
    if (!wrongVerdict)
      details = `Esperaba verdict=wrong, devolvió ${v.verdict}. Issues: ${caughtCategories.join(',') || '(none)'}`;
    else if (!hasExpectedCat)
      details = `verdict=wrong OK pero no matched expected categories. Esperaba alguna de [${fixture.expectedCategories?.join(',') ?? ''}], devolvió [${caughtCategories.join(',')}]`;
    else details = `Caught: ${caughtCategories.join(', ')}`;
  } else {
    // Esperamos verdict='right' o nextAction='accept-with-warnings'
    const accepted =
      v.verdict === 'right' ||
      v.nextAction === 'accept' ||
      v.nextAction === 'accept-with-warnings';
    matchedExpected = accepted;
    passed = accepted;
    if (!accepted)
      details = `Esperaba accept, marcó verdict=${v.verdict} nextAction=${v.nextAction}. Issues: ${caughtCategories.join(',') || '(none)'}`;
    else details = `Aceptado: ${v.verdict}/${v.nextAction}`;
  }

  return {
    label: fixture.label,
    kind: fixture.kind,
    passed,
    verdict: v.verdict,
    confidence: v.confidence,
    nextAction: v.nextAction,
    caughtCategories,
    expectedCategories: fixture.expectedCategories,
    matchedExpected,
    elapsedSec,
    thinkingChars,
    details,
  };
}

async function main() {
  console.log(
    `\n═══════════════════════════════════════════════════════════════════`,
  );
  console.log(`  VALIDATOR CHAT IA v3 — FIXTURE REGRESSION TEST`);
  console.log(`  ${FIXTURES.length} casos · run serial (concurrencia interna 1)`);
  console.log(
    `═══════════════════════════════════════════════════════════════════\n`,
  );

  const results: FixtureRunResult[] = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    const fixture = FIXTURES[i]!;
    console.log(`\n[${i + 1}/${FIXTURES.length}] ${fixture.label}`);
    console.log(`  ${fixture.description}`);
    console.log(`  kind=${fixture.kind}${fixture.expectedCategories ? ` · expected=${fixture.expectedCategories.join('|')}` : ''}`);
    console.log(
      `  image=${fixture.imagePath.split(/[\\/]/).pop()}${fixture.videoPath ? ` · clip=${fixture.videoPath.split(/[\\/]/).pop()}` : ' · (image only)'}`,
    );
    const r = await runFixture(fixture);
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(
      `  → ${icon} · verdict=${r.verdict} · conf=${r.confidence} · ${r.elapsedSec.toFixed(1)}s · thinking=${r.thinkingChars}c`,
    );
    if (r.caughtCategories.length > 0) {
      console.log(`     caught: ${r.caughtCategories.join(', ')}`);
    }
    console.log(`     ${r.details}`);
    results.push(r);
  }

  // ─── Métricas agregadas ────────────────────────────────────
  const badCases = results.filter((r) => r.kind === 'bad');
  const goodCases = results.filter((r) => r.kind === 'good');
  const badCaught = badCases.filter((r) => r.passed).length;
  const goodAccepted = goodCases.filter((r) => r.passed).length;
  const recall = badCases.length > 0 ? (badCaught / badCases.length) * 100 : 0;
  const precision = goodCases.length > 0 ? (goodAccepted / goodCases.length) * 100 : 0;
  const totalElapsed = results.reduce((sum, r) => sum + r.elapsedSec, 0);
  const totalCostUsd = results.length * 0.08; // estimación

  console.log(
    `\n═══════════════════════════════════════════════════════════════════`,
  );
  console.log(`  RESUMEN`);
  console.log(
    `═══════════════════════════════════════════════════════════════════`,
  );
  console.log(`\n  Casos bad   : ${badCases.length} · caught ${badCaught} → RECALL ${recall.toFixed(1)}%`);
  console.log(
    `  Casos good  : ${goodCases.length} · accepted ${goodAccepted} → PRECISION ${precision.toFixed(1)}%`,
  );
  console.log(`  Tiempo total: ${totalElapsed.toFixed(1)}s (${(totalElapsed / 60).toFixed(1)} min)`);
  console.log(`  Costo aprox : $${totalCostUsd.toFixed(2)} USD`);
  console.log('');
  console.log(
    `  Tabla detallada:`,
  );
  console.log(
    `  ─────────────────────────────────────────────────────────────────────────`,
  );
  console.log(
    `  Label                       │ Result  │ Verdict │ Conf │ Categories Caught`,
  );
  console.log(
    `  ─────────────────────────────────────────────────────────────────────────`,
  );
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(27)} │ ${r.passed ? ' ✅ PASS' : ' ❌ FAIL'} │ ${r.verdict.padEnd(7)} │ ${String(r.confidence).padStart(3)}  │ ${r.caughtCategories.slice(0, 3).join(',').slice(0, 35)}`,
    );
  }

  const overall = recall === 100 && precision >= 90;
  console.log(
    `\n  ${overall ? '🎯 PERFECTO' : recall === 100 ? '⚠️ Recall 100% pero precision baja' : '❌ Tuning necesario'}`,
  );

  // Salir con código 0 si todo OK, 1 si hay regresión
  process.exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(2);
});
