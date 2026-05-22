// Verificación rápida del wiring nuevo (narrator-analyzer + voice-selector)
// SIN correr TTS real (que tiene quota limitada).
//
// Confirma que:
//   1. narrator-analyzer infiere gender=male para el guion de Hiroshi Sato
//   2. selectVoiceForNarrator elige una voz masculina del voiceLibrary cuando
//      el narrator es male y la defaultVoice es femenina (caso Vitaly).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrandConfigSchema } from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { narratorAnalyzer } from '@video-factory/block-narrator-analyzer';
import { selectVoiceForNarrator } from '@video-factory/block-tts-elevenlabs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT_MALE = `Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.`;

const TEST_SCRIPT_FEMALE = `Soy María, especialista en bienestar femenino. Llevo más de diez años ayudando a mujeres como tú a recuperar la energía que perdieron después de los 40.`;

const TEST_SCRIPT_NEUTRAL = `Vitaly Gotas es la nueva fórmula natural para el drenaje linfático. Dos goteros bajo la lengua cada mañana.`;

async function testCase(label: string, scriptText: string, expectedGender: 'male' | 'female' | 'neutral') {
  const logger = createLogger('smoke-ui-flow');
  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const ctx: BlockContext = {
    runId: 'smoke-ui-flow',
    workDir: resolve(REPO_ROOT, 'storage', 'runs', 'smoke-ui-flow'),
    logger,
    brand,
    preset: undefined as unknown as never, // narrator-analyzer no usa preset
  };

  const parsedScript = {
    language: 'es',
    segments: [{ text: scriptText, pauseAfterMs: 0, emphasisWords: [] }],
    estimatedDurationSeconds: 30,
  };

  // 1) Narrator analyzer
  const result = await narratorAnalyzer.run(parsedScript as never, ctx);
  if (result.isErr()) throw result.error;
  const profile = result.value.narratorProfile!;

  // 2) Voice selector
  const chosenVoice = selectVoiceForNarrator({
    defaultVoice: brand.defaultVoice,
    voiceLibrary: brand.voiceLibrary ?? [],
    narratorProfile: profile,
  });

  const passNarrator = profile.gender === expectedGender;
  const passVoice =
    expectedGender === 'neutral'
      ? chosenVoice.voiceId === brand.defaultVoice.voiceId
      : chosenVoice.gender === expectedGender;

  console.log(`\n=== ${label} ===`);
  console.log(`Script preview: "${scriptText.slice(0, 80)}..."`);
  console.log(`Inferred gender: ${profile.gender} (expected ${expectedGender}) ${passNarrator ? '✓' : '✗'}`);
  console.log(`Inferred age: ${profile.ageRange}`);
  console.log(`Character card: "${profile.characterCard.slice(0, 100)}..."`);
  console.log(`Chosen voice: ${chosenVoice.label || chosenVoice.voiceId} (gender=${chosenVoice.gender}) ${passVoice ? '✓' : '✗'}`);
  return passNarrator && passVoice;
}

async function main() {
  const results = await Promise.all([
    testCase('MALE NARRATOR (Dr. Hiroshi)', TEST_SCRIPT_MALE, 'male'),
    testCase('FEMALE NARRATOR (María)', TEST_SCRIPT_FEMALE, 'female'),
    testCase('NEUTRAL (voiceover impersonal)', TEST_SCRIPT_NEUTRAL, 'neutral'),
  ]);
  const allPass = results.every(Boolean);
  console.log(`\n${allPass ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main();
