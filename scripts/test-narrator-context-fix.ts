// Test rápido del fix: el validator ya NO debe rechazar escenas que muestran
// otros personajes (paciente) como "character mismatch".
//
// Test contra scene_00 de premium-acdf6c97 (mujer mirándose al espejo).
// Antes: rechazo por "character mismatch with 60yo Japanese doctor"
// Después: pasa porque el imagePrompt es sobre la paciente, no el narrador.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function main() {
  // Caso 1: scene que muestra a la PACIENTE (no al narrador)
  const patientImg = await readFile(
    resolve(REPO_ROOT, 'storage/runs/premium-acdf6c97/scene_00.png'),
  );
  const patientPrompt =
    'Hand-illustrated digital painting in warm sepia-watercolor style, close-up of a young woman in her late 30s, looking tired in the bathroom mirror with swollen face and visible dark circles under her eyes, soft morning light';

  const narrator = {
    gender: 'male' as const,
    ageRange: '55-65',
    characterCard:
      'Mature Japanese man around 60, gray temple hair, white lab coat, serene authoritative expression',
    narratorPresent: true,
  };

  const validator = new SceneValidatorV3();

  // CASO A: pasando narratorProfile (como hacíamos antes — DEBE rechazar por mismatch)
  console.log('\n--- CASO A: WITH narratorProfile (legacy behavior) ---');
  const withNarrator = await validator.validate({
    text: 'si despiertas con la cara hinchada y las ojeras',
    imagePrompt: patientPrompt,
    imageBuffer: patientImg,
    narratorProfile: narrator,
  });
  console.log(`Verdict: ${withNarrator.verdict} | Score: ${withNarrator.score}`);
  console.log(`Issues: ${withNarrator.issues.slice(0, 3).join(' | ')}`);

  // CASO B: SIN narratorProfile (nuestro fix — debe pasar porque la imagen muestra
  // a la paciente correctamente)
  console.log('\n--- CASO B: WITHOUT narratorProfile (fix applied) ---');
  const withoutNarrator = await validator.validate({
    text: 'si despiertas con la cara hinchada y las ojeras',
    imagePrompt: patientPrompt,
    imageBuffer: patientImg,
    narratorProfile: undefined,
  });
  console.log(`Verdict: ${withoutNarrator.verdict} | Score: ${withoutNarrator.score}`);
  console.log(`Issues: ${withoutNarrator.issues.slice(0, 3).join(' | ')}`);

  console.log('\n--- ANALYSIS ---');
  console.log(`Caso A rejected: ${withNarrator.verdict === 'regenerate' ? 'YES (expected)' : 'NO (unexpected)'}`);
  console.log(`Caso B passed: ${withoutNarrator.verdict === 'pass' ? 'YES (fix works)' : 'NO (fix incomplete)'}`);
  console.log(`Score increase: ${withoutNarrator.score - withNarrator.score} points`);

  process.exit(withoutNarrator.verdict === 'pass' ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
