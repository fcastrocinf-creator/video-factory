// Test específico para el nuevo chequeo de COHERENCIA LÓGICA del validator V3.
// Imagen target: scene_06.png del run premium-acdf6c97 — muestra pies con
// "marcas de presión" que son símbolos infinity (∞), no marcas naturales.
//
// Expected: el validator debe detectar `elements_logically_coherent: false`
// y dar un refinementHint específico.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function main() {
  const imagePath = resolve(REPO_ROOT, 'storage/runs/premium-acdf6c97/scene_06.png');
  const buf = await readFile(imagePath);

  const validator = new SceneValidatorV3();
  if (!validator.isAvailable()) {
    console.error('GOOGLE_AI_API_KEY missing');
    process.exit(1);
  }

  // Prompt original aproximado de scene_06 (basado en plan del run)
  const r = await validator.validate({
    text: 'tus piernas pesan, tus zapatos aprietan',
    imagePrompt:
      'Hand-illustrated digital painting in warm sepia-watercolor style. Close-up of a swollen foot with pressure marks from a tight shoe, the shoe placed beside it on the ground, painterly brush strokes, sepia/amber color palette',
    imageBuffer: buf,
    narratorProfile: {
      gender: 'male',
      ageRange: '55-65',
      characterCard:
        'Mature Japanese man around 60, gray temple hair, white lab coat over dark shirt',
      narratorPresent: true,
    },
  });

  console.log('--- VALIDATION RESULT ---');
  console.log('Verdict:', r.verdict);
  console.log('Score:', r.score);
  console.log('\nIssues:');
  for (const issue of r.issues) {
    console.log(`  - ${issue}`);
  }
  console.log('\nRefinement Hint:', r.refinementHint?.slice(0, 400) ?? '(none)');

  console.log('\n--- STRUCTURED ANSWERS (relevant fields) ---');
  const a = r.structuredAnswers;
  if (a) {
    console.log(`elements_logically_coherent: ${a.elements_logically_coherent}`);
    console.log(`illogical_elements_description: "${a.illogical_elements_description}"`);
    console.log(`body_parts_fused: ${a.body_parts_fused}`);
    console.log(`body_parts_fused_description: "${a.body_parts_fused_description}"`);
    console.log(`foot_1_visible: ${a.foot_1_visible}, foot_1_toes_count: ${a.foot_1_toes_count}`);
    console.log(`foot_2_visible: ${a.foot_2_visible}, foot_2_toes_count: ${a.foot_2_toes_count}`);
  }

  console.log('\n--- ADVERSARIAL ---');
  console.log(r.adversarialCritique?.slice(0, 400) ?? '(none)');

  // Pass/fail logic:
  // El test pasa si el validator detectó alguna de estas:
  //   a) elements_logically_coherent=false con mención de marcas/patterns/infinity
  //   b) body_parts_fused=true con mención de pies
  //   c) verdict=regenerate por alguna razón anatómica
  const issuesText = r.issues.join(' ').toLowerCase();
  const detectedIllogical =
    (a?.elements_logically_coherent === false &&
      /mark|infinity|pattern|abstract|shape/i.test(a?.illogical_elements_description ?? '')) ||
    /illogical|infinity|abstract.*mark|pattern/i.test(issuesText);
  const detectedFusion = a?.body_parts_fused === true;
  const detectedAnatomyIssue = r.verdict === 'regenerate';

  console.log('\n--- TEST CHECKS ---');
  console.log(`✓/✗ Detected illogical "pressure marks": ${detectedIllogical ? '✓' : '✗'}`);
  console.log(`✓/✗ Detected body part fusion: ${detectedFusion ? '✓' : '✗'}`);
  console.log(`✓/✗ Verdict is regenerate: ${detectedAnatomyIssue ? '✓' : '✗'}`);

  const pass = detectedIllogical || detectedFusion || detectedAnatomyIssue;
  console.log(`\nFINAL: ${pass ? '✓ PASS' : '✗ FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
