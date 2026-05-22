// Toma los 2 clips Veo válidos del run realista-ae631592 y los loopea en Remotion
// para cubrir los 73 s de audio. No hace llamadas nuevas a Veo (ya hit quota).
// Resultado: MP4 ANIMADO end-to-end con voz + subs + clips loopeados.

import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type AudioTrack,
  type RenderJob,
  type VideoClip,
  type VideoTrack,
} from '@video-factory/contracts';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

const SOURCE_RUN = 'realista-ae631592';
const SOURCE_CLIPS = ['clip_00.mp4', 'clip_01.mp4'];

async function main() {
  const runId = `animado-${randomUUID().slice(0, 8)}`;
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

  const sourceDir = resolve(REPO_ROOT, 'storage', 'runs', SOURCE_RUN);
  if (!existsSync(sourceDir)) throw new Error(`Falta workDir fuente: ${sourceDir}`);

  // Copiar audio + imagen + clips reales al nuevo workDir
  await copyFile(resolve(sourceDir, 'audio.mp3'), resolve(workDir, 'audio.mp3'));
  await copyFile(resolve(sourceDir, 'image.png'), resolve(workDir, 'image.png'));
  for (const clip of SOURCE_CLIPS) {
    await copyFile(resolve(sourceDir, clip), resolve(workDir, clip));
  }
  // eslint-disable-next-line no-console
  console.log(`[animado] workDir=${workDir}`);

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

  const audioPath = resolve(workDir, 'audio.mp3');
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
  console.log(`[animado] B.3 OK: ${subtitleTrack.lines.length} líneas`);

  // Construir VideoTrack loopeando los 2 clips reales hasta cubrir audio.durationSeconds
  const clipDurSec = 8;
  const totalNeeded = audioTrack.durationSeconds;
  const clipsToUse: VideoClip[] = [];
  let cursor = 0;
  let i = 0;
  while (cursor < totalNeeded) {
    const fileName = SOURCE_CLIPS[i % SOURCE_CLIPS.length]!;
    const filePath = resolve(workDir, fileName);
    clipsToUse.push({
      filePath,
      durationSeconds: clipDurSec,
      prompt: `loop clip ${i}`,
      startTimeSeconds: cursor,
      endTimeSeconds: cursor + clipDurSec,
    });
    cursor += clipDurSec;
    i++;
  }
  const videoTrack: VideoTrack = {
    clips: clipsToUse,
    totalDurationSeconds: cursor,
    fps: 30,
    width: 1080,
    height: 1920,
    format: 'mp4',
    engine: 'veo-lite',
    referenceImagePath: resolve(workDir, 'image.png'),
  };
  // eslint-disable-next-line no-console
  console.log(
    `[animado] VideoTrack construido: ${videoTrack.clips.length} clips loopeados de ${SOURCE_CLIPS.length} originales (cubre ${cursor}s de audio ${totalNeeded.toFixed(1)}s)`,
  );

  // B.5
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId: randomUUID(),
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath: resolve(workDir, 'image.png'),
    videoTrack,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  // eslint-disable-next-line no-console
  console.log(`[animado] DONE: ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(`[animado] Para abrir: Start-Process "${outputPath}"`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[animado] FAILED:', err);
  process.exit(1);
});

void basename; // unused but keeps import-side-effect predictable
