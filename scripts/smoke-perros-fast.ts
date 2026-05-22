// Smoke perros FAST: optimizado para tiempo mínimo manteniendo calidad.
// Reusa audio del run anterior, prioriza Higgsfield para image-gen, Gemini Flash
// para scene-planner, Kling pool 5 para animator. Validator ON con 1 retry.

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
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
} from '@video-factory/block-image-gen-imagen';
import { KlingClient, VeoClient } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TEST_SCRIPT = `Mi vecina me llamó llorando porque su Golden destrozó el sofá. Otra vez.

Yo paseaba quince perros al día y veía lo mismo siempre: dueños desesperados, perros aburridos.

Aquí va lo que aprendí de un adiestrador profesional.

Primero: tu perro no se porta mal, está aburrido. Necesita dos horas de actividad real al día, no quince minutos alrededor de la cuadra.

Segundo: el "no" no significa nada para ellos. Lo que funciona es redirección. Si muerde el sofá, le das un kong relleno. Si ladra al timbre, lo mandas a su cama.

Tercero: cada perro tiene una recompensa que vale oro. Para mi Toby es queso. Para la Golden de mi vecina, una pelota vieja. Encuentra la suya.

En dos semanas vas a tener otro perro.`;

const CACHED_AUDIO_PERROS = resolve(REPO_ROOT, 'storage', 'runs', 'perros-0cb1da7e', 'audio.mp3');

const FFPROBE = resolve(
  REPO_ROOT,
  'node_modules', '.pnpm',
  '@remotion+compositor-win32-x64-msvc@4.0.462',
  'node_modules', '@remotion', 'compositor-win32-x64-msvc',
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

interface StepTiming { label: string; elapsedSec: number; }
const timings: StepTiming[] = [];

async function main() {
  const overallStart = Date.now();
  const runId = `perros-fast-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/mujer_protagonista_broll_animado_comic_sepia.preset.json'), 'utf-8')),
  );

  console.log(`[fast] workDir=${workDir}`);
  console.log(`[fast] preset=${preset.id} · OPTIMIZACIONES: cached audio, Higgsfield primary, Gemini Flash, Kling pool 5\n`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };

  const stepStart = (label: string) => {
    console.log(`[fast] >>> ${label} t=${((Date.now()-overallStart)/1000).toFixed(1)}s`);
    return { label, start: Date.now() };
  };
  const stepEnd = (s: { label: string; start: number }) => {
    const elapsedSec = (Date.now() - s.start) / 1000;
    timings.push({ label: s.label, elapsedSec });
    console.log(`[fast] <<< ${s.label} elapsed=${elapsedSec.toFixed(1)}s`);
  };

  let t = stepStart('script-processor');
  const sin = scriptProcessor.validateInput({ rawText: TEST_SCRIPT, language: 'es' });
  if (sin.isErr()) throw sin.error;
  const sp = await scriptProcessor.run(sin.value, ctx);
  if (sp.isErr()) throw sp.error;
  let parsedScript = sp.value;
  stepEnd(t);

  t = stepStart('narrator-analyzer');
  const narratorRes = await narratorAnalyzer.run(parsedScript, ctx);
  if (narratorRes.isErr()) throw narratorRes.error;
  parsedScript = narratorRes.value;
  console.log(`[fast]     narrator=${parsedScript.narratorProfile?.gender}/${parsedScript.narratorProfile?.ageRange}`);
  stepEnd(t);

  // B.2 TTS — reuse cached audio del run perros anterior si existe
  t = stepStart('tts (reuse cached)');
  const audioPath = resolve(workDir, 'audio.mp3');
  if (existsSync(CACHED_AUDIO_PERROS)) {
    await copyFile(CACHED_AUDIO_PERROS, audioPath);
    console.log(`[fast]     audio reusado del run anterior`);
  } else {
    let ttsRes = await ttsElevenLabs.run(parsedScript, ctx);
    if (ttsRes.isErr()) {
      const isQuotaOrAuth = /API_(401|402|429)/i.test(ttsRes.error.code);
      if (isQuotaOrAuth) ttsRes = await ttsOpenai.run(parsedScript, ctx);
    }
    if (ttsRes.isErr()) throw ttsRes.error;
    if (!existsSync(audioPath)) await copyFile(ttsRes.value.filePath, audioPath);
  }
  const realAudioDuration = probeAudioDurationSeconds(audioPath);
  console.log(`[fast]     audio=${realAudioDuration.toFixed(2)}s`);
  parsedScript = { ...parsedScript, estimatedDurationSeconds: realAudioDuration };
  const audioTrack: AudioTrack = {
    filePath: audioPath, durationSeconds: realAudioDuration, sampleRate: 44100, channels: 1, format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text, startTimeSeconds: (i * realAudioDuration) / arr.length, endTimeSeconds: ((i + 1) * realAudioDuration) / arr.length,
    })),
  };
  stepEnd(t);

  t = stepStart('subtitles');
  const subs = await subtitlesGoogle.run(audioTrack, ctx);
  if (subs.isErr()) throw subs.error;
  const subtitleTrack = subs.value;
  console.log(`[fast]     subs=${subtitleTrack.lines.length} líneas / ${subtitleTrack.words.length} palabras`);
  stepEnd(t);

  // B.4 scene-planner con Gemini FLASH (más rápido que Pro)
  t = stepStart('scene-planner (Gemini Flash)');
  const planner = new ScenePlannerBlock({ geminiModel: 'gemini-2.5-flash' });
  const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (planResult.isErr()) throw planResult.error;
  let sceneTrack = planResult.value;
  await writeFile(resolve(workDir, 'scene-plan.json'), JSON.stringify(sceneTrack, null, 2));
  console.log(`[fast]     scenes=${sceneTrack.scenes.length}`);
  stepEnd(t);

  // B.5 image-gen-multi — Higgsfield primary (OpenAI exhausto), validator ON 1 retry
  t = stepStart('image-gen-multi (Higgsfield primary, validator ON 1 retry)');
  const openaiKey = process.env['OPENAI_API_KEY'];
  const googleKey = process.env['GOOGLE_AI_API_KEY']!;
  const gcpProj = process.env['GCP_PROJECT_ID'];
  const hKid = process.env['HIGGSFIELD_KEY_ID'];
  const hSecret = process.env['HIGGSFIELD_KEY_SECRET'];
  const chain: ProviderStep[] = [];
  // PRIMARY: Higgsfield Flux Pro Kontext (~30-60s/img, soporta concurrency 5)
  if (hKid && hSecret) {
    chain.push({
      provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
      model: 'flux-pro/kontext/max/text-to-image',
      label: 'higgsfield:flux-pro-kontext',
    });
  }
  // Fallback OpenAI (auto-skip si billing exhausted)
  if (openaiKey && openaiKey !== 'sk_pendiente') {
    chain.push({ provider: new OpenaiImageProvider({ apiKey: openaiKey, quality: 'medium' }), model: 'gpt-image-1', label: 'openai:gpt-image-1' });
  }
  // Vertex Imagen como último fallback
  if (gcpProj) {
    const v = new VertexImagenProvider({ projectId: gcpProj });
    chain.push(
      { provider: v, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
    );
  }
  chain.push({ provider: new GoogleImagenProvider({ apiKey: googleKey }), model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' });
  console.log(`[fast]     chain: ${chain.map((c) => c.label).join(' → ')}`);

  const imageMulti = new ImageGenMultiBlock({
    concurrency: 5,
    minIntervalMs: 2000,
    maxApiRetries: 2,
    providerChain: chain,
    validate: true,
    maxValidationRetries: 1,
    minPassScore: 75,
    validateSequence: false,
    narratorProfile: sceneTrack.narratorProfile,
    styleBase: sceneTrack.styleBase,
    fastMode: true,
  });
  const imgResult = await imageMulti.run(sceneTrack, ctx);
  if (imgResult.isErr()) throw imgResult.error;
  sceneTrack = imgResult.value;
  console.log(`[fast]     imágenes=${sceneTrack.scenes.length}`);
  stepEnd(t);

  // B.5.5 scene-animator Kling pool 5 (igual que perros)
  const klingAk = process.env['KLING_ACCESS_KEY'];
  const klingSk = process.env['KLING_SECRET_KEY'];
  const useKling = Boolean(klingAk && klingSk);
  const ANIM_CONCURRENCY = useKling ? 5 : 4;
  t = stepStart(`scene-animator (POOL ${ANIM_CONCURRENCY} · ${useKling ? 'Kling+Veo fallback' : 'Veo only'})`);
  const veo = new VeoClient({ apiKey: googleKey });
  const kling = useKling ? new KlingClient({ accessKey: klingAk!, secretKey: klingSk! }) : null;
  let doneCount = 0, klingOk = 0, veoOk = 0, staticFail = 0;
  const total = sceneTrack.scenes.length;
  const animScenes: typeof sceneTrack.scenes = new Array(total);
  const queue = sceneTrack.scenes.map((s, i) => ({ scene: s, idx: i }));

  async function workerLoop(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { scene, idx } = item;
      if (!scene.imagePath || !existsSync(scene.imagePath)) {
        animScenes[idx] = scene;
        doneCount++; staticFail++;
        continue;
      }
      const imgBuf = await readFile(scene.imagePath);
      const motionPrompt = `${scene.imagePrompt.slice(0, 200)}\n\nMotion: subtle natural movement only — keep SAME composition, gentle 5% camera push-in, subject moves naturally (breathing, slight motion), no scene changes, watercolor sepia style maintained.`;
      const videoFile = `scene_${String(scene.index).padStart(2, '0')}.mp4`;
      const videoPath = resolve(workDir, videoFile);
      let succeeded = false;
      if (kling) {
        try {
          const videoBuffer = await kling.generate({
            prompt: motionPrompt,
            imageBase64: imgBuf.toString('base64'),
            model: 'kling-v2-6',
            mode: 'std',
            duration: '5',
          });
          await writeFile(videoPath, videoBuffer);
          animScenes[idx] = { ...scene, videoPath };
          doneCount++; klingOk++;
          console.log(`[fast]     [${doneCount}/${total}] scene_${String(scene.index).padStart(2, '0')} OK Kling`);
          succeeded = true;
        } catch (e) {
          console.warn(`[fast]     scene_${scene.index} Kling failed → Veo: ${(e as Error).message.slice(0, 80)}`);
        }
      }
      if (!succeeded) {
        try {
          const videoBuffer = await veo.generate({
            prompt: motionPrompt,
            imageBase64: imgBuf.toString('base64'),
            imageMimeType: 'image/png', aspectRatio: '9:16', durationSeconds: 8,
            model: 'veo-3.1-lite-generate-preview',
          });
          await writeFile(videoPath, videoBuffer);
          animScenes[idx] = { ...scene, videoPath };
          doneCount++; veoOk++;
          console.log(`[fast]     [${doneCount}/${total}] scene_${String(scene.index).padStart(2, '0')} OK Veo`);
        } catch (e) {
          animScenes[idx] = scene;
          doneCount++; staticFail++;
          console.warn(`[fast]     [${doneCount}/${total}] scene_${scene.index} FAILED → static`);
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ANIM_CONCURRENCY, total) }, () => workerLoop()),
  );
  sceneTrack = { ...sceneTrack, scenes: animScenes.filter(Boolean) };
  stepEnd(t);
  console.log(`[fast]     animator: Kling=${klingOk}/${total} · Veo=${veoOk}/${total} · static=${staticFail}/${total}`);

  t = stepStart('compositor');
  const outputPath = resolve(workDir, 'final.mp4');
  const renderJob: RenderJob = {
    runId: randomUUID(),
    brandId: brand.id, presetId: preset.id, parsedScript, audioTrack, subtitleTrack,
    imagePath: sceneTrack.scenes[0]?.imagePath ?? '',
    sceneTrack, animatedScenes: true, outputPath,
    resolution: [1080, 1920], fps: 30, status: 'pending',
  };
  const renderResult = await compositorRemotion.run(renderJob, ctx);
  if (renderResult.isErr()) throw renderResult.error;
  stepEnd(t);

  const total_elapsed = (Date.now() - overallStart) / 1000;
  console.log(`\n[fast] ============================================`);
  console.log(`[fast] TOTAL: ${total_elapsed.toFixed(1)}s = ${(total_elapsed/60).toFixed(1)} min`);
  console.log(`[fast] OUTPUT: ${outputPath}`);
  console.log(`[fast]`);
  console.log(`[fast] === Breakdown ===`);
  for (const t of timings) {
    const pct = (t.elapsedSec / total_elapsed) * 100;
    console.log(`[fast]   ${t.label.padEnd(60)} ${t.elapsedSec.toFixed(1).padStart(6)}s (${pct.toFixed(0)}%)`);
  }
  console.log(`[fast]`);
  console.log(`[fast] === Animator ratio ===`);
  console.log(`[fast]   Kling: ${klingOk}/${total} · Veo: ${veoOk}/${total} · Static: ${staticFail}/${total}`);
  console.log(`[fast] ============================================`);
}

main().catch((err) => { console.error('[fast] FAILED:', err); process.exit(1); });
