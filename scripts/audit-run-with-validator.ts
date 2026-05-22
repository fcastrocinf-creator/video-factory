// Audita un run existente: corre el validator v3 contra TODAS las escenas
// generadas y reporta qué problemas detecta — sin gastar quota de Imagen.
//
// Uso: node --env-file=.env --import tsx scripts/audit-run-with-validator.ts premium-acdf6c97

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function main() {
  const runId = process.argv[2] ?? 'premium-acdf6c97';
  const runDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  const planPath = resolve(runDir, 'scene-plan.json');

  if (!existsSync(planPath)) {
    console.error(`No scene-plan.json en ${runDir} — necesito el plan para conocer prompts y texts`);
    process.exit(1);
  }

  const plan = JSON.parse(await readFile(planPath, 'utf-8')) as {
    scenes: Array<{ index: number; text: string; imagePrompt: string; imagePath?: string }>;
    narratorProfile?: { gender: 'male' | 'female' | 'neutral'; ageRange: string; characterCard: string; narratorPresent: boolean };
    styleBase: string;
  };

  console.log(`\nAuditando run ${runId} con ${plan.scenes.length} escenas`);
  console.log(`Narrador: ${plan.narratorProfile?.gender ?? '?'} / ${plan.narratorProfile?.ageRange ?? '?'}`);
  console.log(`Style: ${plan.styleBase.slice(0, 80)}...`);

  const validator = new SceneValidatorV3();
  if (!validator.isAvailable()) {
    console.error('GOOGLE_AI_API_KEY missing');
    process.exit(1);
  }

  const results: Array<{ idx: number; verdict: string; score: number; issues: string[]; text: string }> = [];

  for (const scene of plan.scenes) {
    const imagePath = resolve(runDir, `scene_${scene.index.toString().padStart(2, '0')}.png`);
    if (!existsSync(imagePath)) {
      console.log(`  [${scene.index}] SIN IMAGEN (skipped)`);
      continue;
    }
    const buf = await readFile(imagePath);
    try {
      const r = await validator.validate({
        text: scene.text,
        imagePrompt: scene.imagePrompt,
        imageBuffer: buf,
        styleBase: plan.styleBase,
        narratorProfile: plan.narratorProfile,
      });
      const tag = r.verdict === 'pass' ? '✓' : '✗';
      console.log(`  ${tag} [${scene.index}] ${r.verdict} score=${r.score} "${scene.text.slice(0, 40)}..."`);
      if (r.issues.length > 0) {
        for (const issue of r.issues.slice(0, 2)) {
          console.log(`     - ${issue.slice(0, 120)}`);
        }
      }
      results.push({ idx: scene.index, verdict: r.verdict, score: r.score, issues: r.issues, text: scene.text });
    } catch (e) {
      console.log(`  ERROR [${scene.index}]: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  const passes = results.filter((r) => r.verdict === 'pass').length;
  const regens = results.filter((r) => r.verdict === 'regenerate').length;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / Math.max(1, results.length);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`AUDIT SUMMARY — run ${runId}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total escenas validadas:  ${results.length}`);
  console.log(`Pass:                     ${passes} (${((passes / results.length) * 100).toFixed(0)}%)`);
  console.log(`Regenerate (con issues):  ${regens} (${((regens / results.length) * 100).toFixed(0)}%)`);
  console.log(`Score promedio:           ${avgScore.toFixed(1)}/100`);
  console.log(`\nEscenas con issues (top 5 por score más bajo):`);
  results
    .filter((r) => r.verdict === 'regenerate')
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .forEach((r) => {
      console.log(`  [${r.idx}] score=${r.score} | "${r.text.slice(0, 50)}..."`);
      console.log(`       ${r.issues[0]?.slice(0, 100) ?? '(no issue text)'}`);
    });
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
