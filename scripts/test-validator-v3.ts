// Test VALIDATOR CHAT IA v3 contra escenas REALES del rip SOOMI.
//
// Toma 3 escenas del run 1103a786:
//   - Scene 5: conocida con burned-text "9:16" + "VITALY GOTAS DRENAJE LINFÁTICO"
//   - Scene 7: conocida con "Expression Sheet" (character sheet con varias poses)
//   - Scene 2: probable OK (anatomical illustration de tobillo sano)
//
// VALIDATOR debe rechazar 5 y 7 (categorías burned-text-leaked / gallery-mode)
// y aprobar 2. Para cada uno imprime el thinking + verdict + issues + corrections.
//
// Uso:
//   node --env-file=.env --import tsx scripts/test-validator-v3.ts

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Set cwd para que validator-chat-ia.ts lea storage/ correctamente
process.chdir(REPO_ROOT);

import { validateScene } from '../apps/web/lib/validator-chat-ia.js';

const RUN_ID = '1103a786-630f-4d22-8047-fb2246d20d6e';
const SCENES_TO_TEST = [5, 7, 2];

// Logger compacto
const logger = {
  info: (obj: unknown, msg?: string) => {
    console.log(`[INFO] ${msg ?? ''}`, JSON.stringify(obj).slice(0, 300));
  },
  warn: (obj: unknown, msg?: string) => {
    console.warn(`[WARN] ${msg ?? ''}`, JSON.stringify(obj).slice(0, 300));
  },
};

async function main() {
  const runDir = resolve(REPO_ROOT, 'storage', 'runs', RUN_ID);
  const planPath = resolve(runDir, 'scene-plan.json');

  if (!existsSync(planPath)) {
    console.error(`No scene-plan.json en ${runDir}`);
    process.exit(1);
  }

  const plan = JSON.parse(await readFile(planPath, 'utf-8')) as {
    scenes: Array<{
      index: number;
      text: string;
      imagePrompt: string;
      imagePath?: string;
      videoPath?: string;
      startTimeSeconds: number;
      endTimeSeconds: number;
    }>;
  };

  console.log(
    `\n═══════════════════════════════════════════════════════════════════`,
  );
  console.log(`  TEST VALIDATOR CHAT IA v3 — run ${RUN_ID.slice(0, 8)}`);
  console.log(`  Escenas a validar: ${SCENES_TO_TEST.join(', ')}`);
  console.log(
    `═══════════════════════════════════════════════════════════════════\n`,
  );

  const results: Array<{
    sceneIndex: number;
    verdict: string;
    confidence: number;
    nextAction: string;
    issueCount: number;
    criticalCount: number;
    elapsedSec: number;
    hadThinking: boolean;
    thinkingChars: number;
  }> = [];

  for (const sceneIndex of SCENES_TO_TEST) {
    const scene = plan.scenes.find((s) => s.index === sceneIndex);
    if (!scene) {
      console.log(`⚠️  Scene ${sceneIndex} no existe en scene-plan, skip`);
      continue;
    }
    if (!scene.imagePath || !existsSync(scene.imagePath)) {
      console.log(`⚠️  Scene ${sceneIndex} sin imagePath, skip`);
      continue;
    }

    console.log(
      `\n┌─────────────────────────────────────────────────────────────────┐`,
    );
    console.log(`│ Scene ${sceneIndex}`);
    console.log(`│ Narración: "${scene.text.slice(0, 80)}"`);
    console.log(`│ imagePath: ${scene.imagePath.split(/[\\/]/).pop()}`);
    console.log(
      `│ videoPath: ${scene.videoPath ? scene.videoPath.split(/[\\/]/).pop() : '(no clip)'}`,
    );
    console.log(
      `└─────────────────────────────────────────────────────────────────┘`,
    );

    const t0 = Date.now();
    const result = await validateScene({
      runId: `test-v3-${Date.now()}`, // run sintético, no contamina historial real
      scene: scene as never,
      staticImagePath: scene.imagePath,
      animatedVideoPath: scene.videoPath,
      brandContext: {
        brandId: 'vitaly',
        productName: 'Vitaly Gotas',
        productDescription:
          'Suplemento sublingual en gotas para drenaje linfático. Se aplican unas gotas bajo la lengua.',
        productUsageForm: 'sublingual',
        styleSummary: 'B-ROLL Animado · Comic / Acuarela Sepia',
        language: 'es',
      },
      scenePosition: {
        index: sceneIndex,
        total: plan.scenes.length,
        narrativeBeat:
          sceneIndex === 0 ? 'hook' : sceneIndex < 4 ? 'problem' : 'mechanism',
      },
      scriptFullSummary: plan.scenes
        .map((s) => s.text)
        .join(' ')
        .slice(0, 1500),
      attempt: 1,
      logger,
    });
    const elapsedSec = (Date.now() - t0) / 1000;

    if (!result.verdict) {
      console.log(
        `\n  ❌ ERROR: ${result.error?.type} — ${result.error?.message?.slice(0, 250)}`,
      );
      results.push({
        sceneIndex,
        verdict: 'API_ERROR',
        confidence: 0,
        nextAction: 'n/a',
        issueCount: 0,
        criticalCount: 0,
        elapsedSec,
        hadThinking: false,
        thinkingChars: 0,
      });
      continue;
    }

    const v = result.verdict;
    const criticalCount = v.issues.filter((i) => i.severity === 'critical').length;
    const majorCount = v.issues.filter((i) => i.severity === 'major').length;
    const thinkingChars = result.history.thinkingContent?.length ?? 0;

    console.log(`\n  🤖 VERDICT:`);
    console.log(`     verdict        = ${v.verdict.toUpperCase()}`);
    console.log(`     confidence     = ${v.confidence}/100`);
    console.log(`     nextAction     = ${v.nextAction}`);
    console.log(`     staticImageOk  = ${v.staticImageOk}`);
    console.log(`     animationOk    = ${v.animationOk}`);
    console.log(`     keyframes      = ${result.keyframesExtracted}`);
    console.log(`     elapsed        = ${elapsedSec.toFixed(1)}s`);
    console.log(`     thinking       = ${thinkingChars} chars`);

    if (v.issues.length > 0) {
      console.log(`\n  📋 ISSUES (${criticalCount} crit, ${majorCount} maj):`);
      for (const iss of v.issues) {
        console.log(
          `     • [${iss.severity}/${iss.category}] frame ${iss.evidenceFrameIndex ?? '?'} ${iss.evidenceRegion ?? '?'}: ${iss.description.slice(0, 150)}`,
        );
      }
    }

    if (v.correctedImagePrompt) {
      console.log(
        `\n  🔧 correctedImagePrompt (${v.correctedImagePrompt.length} chars):`,
      );
      console.log(`     "${v.correctedImagePrompt.slice(0, 220)}..."`);
    }
    if (v.correctedMotionPrompt) {
      console.log(
        `\n  🎬 correctedMotionPrompt (${v.correctedMotionPrompt.length} chars):`,
      );
      console.log(`     "${v.correctedMotionPrompt.slice(0, 220)}..."`);
    }
    if (v.systemicAntiPattern) {
      console.log(`\n  🚫 systemicAntiPattern: "${v.systemicAntiPattern}"`);
    }

    console.log(`\n  💬 Rationale:`);
    console.log(`     "${v.rationale.slice(0, 320)}"`);

    if (result.history.thinkingContent) {
      console.log(`\n  🧠 THINKING (primeros 800 chars):`);
      console.log(
        result.history.thinkingContent
          .slice(0, 800)
          .split('\n')
          .map((l) => `     ${l}`)
          .join('\n'),
      );
      if (thinkingChars > 800) console.log(`     ... [+${thinkingChars - 800} chars]`);
    }

    results.push({
      sceneIndex,
      verdict: v.verdict,
      confidence: v.confidence,
      nextAction: v.nextAction,
      issueCount: v.issues.length,
      criticalCount,
      elapsedSec,
      hadThinking: thinkingChars > 0,
      thinkingChars,
    });
  }

  console.log(
    `\n═══════════════════════════════════════════════════════════════════`,
  );
  console.log(`  RESUMEN`);
  console.log(
    `═══════════════════════════════════════════════════════════════════`,
  );
  console.log(
    `\n  Scene │ Verdict │ Conf │ NextAction         │ Issues │ Crit │ Thinking │ Elapsed`,
  );
  console.log(
    `  ──────┼─────────┼──────┼────────────────────┼────────┼──────┼──────────┼────────`,
  );
  for (const r of results) {
    console.log(
      `  ${String(r.sceneIndex).padStart(5)} │ ${r.verdict.padEnd(7)} │ ${String(r.confidence).padStart(3)}  │ ${r.nextAction.padEnd(18)} │ ${String(r.issueCount).padStart(6)} │ ${String(r.criticalCount).padStart(4)} │ ${r.hadThinking ? String(r.thinkingChars).padStart(7) + 'c' : '   no    '} │ ${r.elapsedSec.toFixed(1)}s`,
    );
  }
  console.log(`\n  Total: ${results.length} validaciones`);
  console.log(
    `\n  ✓ Esperado: scenes 5 y 7 → wrong (crítico); scene 2 → right o accept-with-warnings.\n`,
  );
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
