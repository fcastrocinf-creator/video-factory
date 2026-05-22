// Test rápido del scene-validator: alimenta scene_06.png (la mano con 4 dedos
// del último video) al validator y muestra el verdict + refinement hint.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneValidator } from '@video-factory/block-scene-validator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function main() {
  const sceneToTest = process.argv[2] ?? 'scene_06';
  const runDir = process.argv[3] ?? 'premium-fd99285f';
  const img = await readFile(resolve(REPO_ROOT, 'storage/runs', runDir, `${sceneToTest}.png`));

  const validator = new SceneValidator();
  if (!validator.isAvailable()) {
    console.error('GOOGLE_AI_API_KEY no está seteada');
    process.exit(1);
  }

  // Usamos el prompt aproximado de scene_06 (mano hinchada con anillo).
  const result = await validator.validate({
    text: 'y tus anillos no entran',
    imagePrompt:
      'Hand-illustrated digital painting in warm sepia-watercolor style, macro close-up of a mature womans hand with one swollen middle finger, golden ring stuck halfway up the swollen finger, painterly brush strokes, amber/ochre color palette, vertical 9:16',
    imageBuffer: img,
    styleBase:
      'Hand-illustrated digital painting in warm sepia-watercolor style, like a premium animated educational comic',
    narratorProfile: { gender: 'male', ageRange: '50-65' },
  });

  console.log('--- VALIDATION RESULT ---');
  console.log('Verdict:', result.verdict);
  console.log('Score:', result.score);
  console.log('Issues:', result.issues);
  console.log('Refinement Hint:', result.refinementHint);
  console.log('Reasoning:', result.reasoning);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
