import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type AudioTrack,
  type ImageAsset,
  type RenderJob,
  type VideoTrack,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { VideoGenVeoBlock } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

async function main() {
  const runId = `smoke-veo-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(
      await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_animado.preset.json'), 'utf-8'),
    ),
  );

  // Reusar assets previos (audio + imagen del doctor Pixar)
  const sourceAudio = resolve(
    REPO_ROOT,
    'storage',
    'runs',
    '35d33de4-9071-4ec6-96a9-c53f7769a55c',
    'audio.mp3',
  );
  if (!existsSync(sourceAudio)) {
    throw new Error(`Falta audio fuente: ${sourceAudio}`);
  }
  const sourceImage = resolve(REPO_ROOT, 'storage', 'imagen_test.png');
  if (!existsSync(sourceImage)) {
    throw new Error(`Falta imagen fuente: ${sourceImage}`);
  }

  const audioPath = resolve(workDir, 'audio.mp3');
  await writeFile(audioPath, await readFile(sourceAudio));
  const imagePath = resolve(workDir, 'image.png');
  await writeFile(imagePath, await readFile(sourceImage));

  // eslint-disable-next-line no-console
  console.log(`[smoke-veo] workDir=${workDir}`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  // B.1
  const scriptInputResult = scriptProcessor.validateInput({
    rawText: TEST_SCRIPT,
    language: brand.language.split('-')[0] ?? 'es',
  });
  if (scriptInputResult.isErr()) throw scriptInputResult.error;
  const parsedResult = await scriptProcessor.run(scriptInputResult.value, ctx);
  if (parsedResult.isErr()) throw parsedResult.error;
  const parsedScript = parsedResult.value;
  // eslint-disable-next-line no-console
  console.log(`[smoke-veo] B.1 OK: ${parsedScript.segments.length} segmentos`);

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

  // B.3
  const subsResult = await subtitlesGoogle.run(audioTrack, ctx);
  if (subsResult.isErr()) throw subsResult.error;
  const subtitleTrack = subsResult.value;
  // eslint-disable-next-line no-console
  console.log(
    `[smoke-veo] B.3 OK: ${subtitleTrack.words.length} palabras, ${subtitleTrack.lines.length} líneas`,
  );

  // B.4 — imagen ya disponible como fixture; sintetizo ImageAsset
  const imageAsset: ImageAsset = {
    filePath: imagePath,
    width: 1080,
    height: 1920,
    format: 'png',
    prompt: preset.visualStyle.promptTemplate,
    metadata: {
      model: 'imagen-4.0-generate-001',
      engine: 'imagen4',
    },
  };

  // B.4b — Veo con fallback
  let videoTrack: VideoTrack | undefined;
  const veoBlock = new VideoGenVeoBlock({
    targetDurationSeconds: audioTrack.durationSeconds,
    clipCount: Math.max(1, Math.ceil(audioTrack.durationSeconds / 8)),
  });
  const veoResult = await veoBlock.run(imageAsset, ctx);
  if (veoResult.isErr()) {
    // eslint-disable-next-line no-console
    console.warn(`[smoke-veo] B.4b Veo FALLÓ (cae a PlanoFijo): ${veoResult.error.message}`);
  } else {
    videoTrack = veoResult.value;
    // eslint-disable-next-line no-console
    console.log(`[smoke-veo] B.4b Veo OK: ${videoTrack.clips.length} clips`);
  }

  // B.5
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId: randomUUID(),
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath,
    videoTrack,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  // eslint-disable-next-line no-console
  console.log(`[smoke-veo] B.5 OK: ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `[smoke-veo] Modo: ${videoTrack ? 'PlanoAnimado (Veo)' : 'PlanoFijo (fallback con imagen)'}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-veo] FAILED:', err);
  process.exit(1);
});
