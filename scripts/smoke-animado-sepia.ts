// Smoke ANIMADO: B-ROLL Animado · Acuarela Sepia con Veo image-to-video por escena.
// Guión corto (~25s) para validar end-to-end rápido. 10-12 escenas animadas en
// paralelo (concurrency 4). Tiempo estimado total: 8-15 min.

import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
import { narratorAnalyzer } from '@video-factory/block-narrator-analyzer';
import { ttsElevenLabs } from '@video-factory/block-tts-elevenlabs';
import { ttsOpenai } from '@video-factory/block-tts-openai';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';
import { ImageGenMultiBlock, type ProviderStep } from '@video-factory/block-image-gen-multi';
import {
  GoogleImagenProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
} from '@video-factory/block-image-gen-imagen';
import { VeoClient } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Guion CORTO (~25s) — 1 párrafo, suficiente para validar Veo per-scene.
const TEST_SCRIPT = `Si te despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada, eso no es cansancio. Es tu sistema linfático colapsado. Después de los cuarenta, tu cuerpo ya no drena igual, y nadie te lo explica.`;

const FFPROBE = resolve(
  REPO_ROOT,
  'node_modules',
  '.pnpm',
  '@remotion+compositor-win32-x64-msvc@4.0.462',
  'node_modules',
  '@remotion',
  'compositor-win32-x64-msvc',
  'ffprobe.exe',
);

function probeAudioDurationSeconds(path: string): number {
  const r = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of',
    'default=noprint_wrappers=1:nokey=1', path,
  ]);
  if (r.status !== 0) throw new Error(`ffprobe falló: ${r.stderr.toString()}`);
  const sec = parseFloat(r.stdout.toString().trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe duración inválida: "${r.stdout}"`);
  return sec;
}

async function main() {
  const runId = `animado-sepia-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/doctor_broll_animado_comic_sepia.preset.json'), 'utf-8')),
  );

  console.log(`[animado] workDir=${workDir}`);
  console.log(`[animado] preset=${preset.id} · format=${preset.format?.id} · engine=${preset.visualEngine}`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  // B.1 script-processor
  const sin = scriptProcessor.validateInput({
    rawText: TEST_SCRIPT,
    language: brand.language.split('-')[0] ?? 'es',
  });
  if (sin.isErr()) throw sin.error;
  const sp = await scriptProcessor.run(sin.value, ctx);
  if (sp.isErr()) throw sp.error;
  let parsedScript = sp.value;

  // B.1.5 narrator
  const narratorRes = await narratorAnalyzer.run(parsedScript, ctx);
  if (narratorRes.isErr()) throw narratorRes.error;
  parsedScript = narratorRes.value;
  console.log(`[animado] narrator=${parsedScript.narratorProfile?.gender}/${parsedScript.narratorProfile?.ageRange}`);

  // B.2 TTS fresh (script corto, ~270 chars, costo ínfimo)
  let ttsRes = await ttsElevenLabs.run(parsedScript, ctx);
  if (ttsRes.isErr()) {
    const errCode = ttsRes.error.code;
    const isQuotaOrAuth = /API_(401|402|429)/i.test(errCode) || /quota|unauthorized|payment/i.test(ttsRes.error.message);
    if (isQuotaOrAuth) {
      console.log(`[animado] ElevenLabs falló (${errCode}), fallback OpenAI TTS...`);
      ttsRes = await ttsOpenai.run(parsedScript, ctx);
    }
  }
  if (ttsRes.isErr()) throw ttsRes.error;
  const audioPath = resolve(workDir, 'audio.mp3');
  if (!existsSync(audioPath)) await copyFile(ttsRes.value.filePath, audioPath);
  const realAudioDuration = probeAudioDurationSeconds(audioPath);
  console.log(`[animado] audio=${realAudioDuration.toFixed(2)}s`);
  parsedScript = { ...parsedScript, estimatedDurationSeconds: realAudioDuration };

  const audioTrack: AudioTrack = {
    filePath: audioPath,
    durationSeconds: realAudioDuration,
    sampleRate: 44100,
    channels: 1,
    format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text,
      startTimeSeconds: (i * realAudioDuration) / arr.length,
      endTimeSeconds: ((i + 1) * realAudioDuration) / arr.length,
    })),
  };

  // B.3 subtitles
  const subs = await subtitlesGoogle.run(audioTrack, ctx);
  if (subs.isErr()) throw subs.error;
  const subtitleTrack = subs.value;
  console.log(`[animado] subs: ${subtitleTrack.lines.length} líneas, ${subtitleTrack.words.length} palabras`);

  // B.4 scene-planner (target ~10-12 escenas para 25s)
  const planner = new ScenePlannerBlock({});
  const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (planResult.isErr()) throw planResult.error;
  let sceneTrack = planResult.value;
  console.log(`[animado] scene-planner OK: ${sceneTrack.scenes.length} escenas`);
  await writeFile(resolve(workDir, 'scene-plan.json'), JSON.stringify(sceneTrack, null, 2));

  // B.5 image-gen-multi
  const openaiApiKey = process.env['OPENAI_API_KEY'];
  const googleApiKey = process.env['GOOGLE_AI_API_KEY']!;
  const gcpProjectId = process.env['GCP_PROJECT_ID'];
  const providerChain: ProviderStep[] = [];
  if (openaiApiKey && openaiApiKey !== 'sk_pendiente') {
    providerChain.push({
      provider: new OpenaiImageProvider({ apiKey: openaiApiKey, quality: 'medium' }),
      model: 'gpt-image-1',
      label: 'openai:gpt-image-1',
    });
  }
  if (gcpProjectId) {
    const vertex = new VertexImagenProvider({ projectId: gcpProjectId });
    providerChain.push(
      { provider: vertex, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
      { provider: vertex, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
    );
  }
  const aistudio = new GoogleImagenProvider({ apiKey: googleApiKey });
  providerChain.push(
    { provider: aistudio, model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' },
  );

  const imageMulti = new ImageGenMultiBlock({
    concurrency: 4,
    minIntervalMs: 3000,
    maxApiRetries: 3,
    providerChain,
    validate: true,
    maxValidationRetries: 1, // smoke rápido: 1 retry
    minPassScore: 70,
    validateSequence: false,
    narratorProfile: sceneTrack.narratorProfile,
    styleBase: sceneTrack.styleBase,
    fastMode: true,
  });
  const imgResult = await imageMulti.run(sceneTrack, ctx);
  if (imgResult.isErr()) throw imgResult.error;
  sceneTrack = imgResult.value;
  console.log(`[animado] imágenes OK: ${sceneTrack.scenes.length}`);

  // B.5.5 scene-animator (Veo image-to-video por escena) ← lo nuevo
  console.log(`[animado] >>> scene-animator: animando ${sceneTrack.scenes.length} escenas con Veo (concurrency 4)`);
  const startVeo = Date.now();
  const veoClient = new VeoClient({ apiKey: googleApiKey });
  let done = 0;
  const animated = await Promise.all(
    sceneTrack.scenes.map(async (scene) => {
      if (!scene.imagePath || !existsSync(scene.imagePath)) return scene;
      try {
        const imageBuffer = await readFile(scene.imagePath);
        const imageBase64 = imageBuffer.toString('base64');
        const motionPrompt = `${scene.imagePrompt.slice(0, 200)}\n\nMotion: subtle natural movement only — keep SAME composition, character breathes and blinks, gentle 5% camera push-in, no scene changes.`;
        const videoBuffer = await veoClient.generate({
          prompt: motionPrompt,
          imageBase64,
          imageMimeType: 'image/png',
          aspectRatio: '9:16',
          durationSeconds: 8,
          model: 'veo-3.1-lite-generate-preview',
        });
        const videoFile = `scene_${String(scene.index).padStart(2, '0')}.mp4`;
        const videoPath = resolve(workDir, videoFile);
        await writeFile(videoPath, videoBuffer);
        done++;
        console.log(`[animado]   [${done}/${sceneTrack.scenes.length}] scene_${String(scene.index).padStart(2, '0')} animada (${videoBuffer.length} bytes)`);
        return { ...scene, videoPath };
      } catch (e) {
        done++;
        console.warn(`[animado]   [${done}/${sceneTrack.scenes.length}] scene_${scene.index} FALLÓ — keeping static. Err: ${(e as Error).message.slice(0, 200)}`);
        return scene; // best-effort: dejamos static
      }
    }),
  );
  sceneTrack = { ...sceneTrack, scenes: animated };
  const animatedCount = animated.filter((s) => s.videoPath).length;
  const elapsedVeo = ((Date.now() - startVeo) / 1000).toFixed(1);
  console.log(`[animado] <<< scene-animator: ${animatedCount}/${animated.length} animadas en ${elapsedVeo}s`);

  if (animatedCount === 0) {
    console.error(`[animado] CERO escenas animadas — algo está mal con Veo. Sigue para render con estáticas.`);
  }

  // B.6 compositor
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId: randomUUID(),
    brandId: brand.id,
    presetId: preset.id,
    parsedScript,
    audioTrack,
    subtitleTrack,
    imagePath: sceneTrack.scenes[0]?.imagePath ?? '',
    sceneTrack,
    animatedScenes: true,
    outputPath,
    resolution: [1080, 1920],
    fps: 30,
    status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  console.log(`[animado] DONE: ${outputPath}`);
}

main().catch((err) => {
  console.error('[animado] FAILED:', err);
  process.exit(1);
});
