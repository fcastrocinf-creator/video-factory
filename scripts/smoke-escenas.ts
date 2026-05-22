// Smoke multi-escena: Gemini divide el guión en escenas, Imagen genera una imagen
// por escena, Remotion compone con Ken Burns por escena. Reusa audio cacheado.

import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type AudioTrack,
  type RenderJob,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';
import { ImageGenMultiBlock } from '@video-factory/block-image-gen-multi';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

const SOURCE_AUDIO = resolve(
  REPO_ROOT,
  'storage',
  'runs',
  '35d33de4-9071-4ec6-96a9-c53f7769a55c',
  'audio.mp3',
);

async function main() {
  const runId = `escenas-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(
      await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_escenas.preset.json'), 'utf-8'),
    ),
  );

  if (!existsSync(SOURCE_AUDIO)) throw new Error(`Falta audio fuente: ${SOURCE_AUDIO}`);
  const audioPath = resolve(workDir, 'audio.mp3');
  await copyFile(SOURCE_AUDIO, audioPath);
  // eslint-disable-next-line no-console
  console.log(`[escenas] workDir=${workDir}`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  // B.1
  const sin = scriptProcessor.validateInput({
    rawText: TEST_SCRIPT,
    language: brand.language.split('-')[0] ?? 'es',
  });
  if (sin.isErr()) throw sin.error;
  const sp = await scriptProcessor.run(sin.value, ctx);
  if (sp.isErr()) throw sp.error;
  const parsedScript = sp.value;
  // eslint-disable-next-line no-console
  console.log(`[escenas] B.1 OK: ${parsedScript.segments.length} segmentos`);

  const audioTrack: AudioTrack = {
    filePath: audioPath,
    durationSeconds: parsedScript.estimatedDurationSeconds,
    sampleRate: 44100,
    channels: 1,
    format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text,
      startTimeSeconds: (i * parsedScript.estimatedDurationSeconds) / arr.length,
      endTimeSeconds: ((i + 1) * parsedScript.estimatedDurationSeconds) / arr.length,
    })),
  };

  // B.3 — subs (necesarios para Remotion)
  const subs = await subtitlesGoogle.run(audioTrack, ctx);
  if (subs.isErr()) throw subs.error;
  const subtitleTrack = subs.value;
  // eslint-disable-next-line no-console
  console.log(`[escenas] B.3 OK: ${subtitleTrack.lines.length} líneas`);

  // B.1.5 — scene-planner (Gemini)
  const planner = new ScenePlannerBlock({ targetSceneCount: 6 });
  const planResult = await planner.run(parsedScript, ctx);
  if (planResult.isErr()) throw planResult.error;
  const sceneTrack = planResult.value;
  // eslint-disable-next-line no-console
  console.log(`[escenas] Scene-planner OK: ${sceneTrack.scenes.length} escenas`);
  for (const s of sceneTrack.scenes) {
    // eslint-disable-next-line no-console
    console.log(
      `  - Escena ${s.index} (${s.startTimeSeconds.toFixed(1)}-${s.endTimeSeconds.toFixed(1)}s): "${s.imagePrompt.slice(0, 100)}..."`,
    );
  }

  // B.4-multi
  const imageMulti = new ImageGenMultiBlock({ concurrency: 3 });
  const imgResult = await imageMulti.run(sceneTrack, ctx);
  if (imgResult.isErr()) throw imgResult.error;
  const sceneTrackWithImages = imgResult.value;
  // eslint-disable-next-line no-console
  console.log(`[escenas] B.4-multi OK: ${sceneTrackWithImages.scenes.length} imágenes`);

  // B.5
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId: randomUUID(),
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath: sceneTrackWithImages.scenes[0]?.imagePath ?? '',
    sceneTrack: sceneTrackWithImages,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  // eslint-disable-next-line no-console
  console.log(`[escenas] B.5 OK: ${outputPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[escenas] FAILED:', err);
  process.exit(1);
});
