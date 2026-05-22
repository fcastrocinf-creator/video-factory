// Smoke ANIMADO LARGO: B-ROLL Animado · Acuarela Sepia con guion completo Vitaly
// (~75s, ~27-30 escenas). Concurrency 8 + skip validator + Veo per-scene.
// Target: 7-10 min total.

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

// Guion largo Vitaly Gotas — Dr Hiroshi Sato (masculino, ~75s).
const TEST_SCRIPT = `Si despiertas con la cara hinchada y las ojeras marcadas como si no hubieras dormido nada… eso no es cansancio mi amiga. Es tu sistema linfático colapsado. Si al final del día tus piernas pesan, tus zapatos aprietan, y tus anillos no entran… tampoco es la sal. Es líquido atrapado en tejido que tu cuerpo ya no logra mover.

Soy el doctor Hiroshi Sato, especialista en medicina linfática en Kyoto. Por más de veinticinco años hemos tratado este problema distinto a Occidente. Después de los cuarenta, tu sistema linfático funciona más lento, y nadie te lo explica.

Los diuréticos que te recetan solo barren agua, pero también los minerales que tu cuerpo necesita para funcionar. Lo que sí funciona viene de la medicina japonesa tradicional. Una combinación de extractos vegetales que reactiva el flujo linfático naturalmente, sin forzar tu riñón.

La fórmula que recomiendo se llama Vitaly Gotas. Dos goteros bajo la lengua en la mañana. En diez días vas a ver tu cara distinta. En treinta días, vas a sentirte tú misma de nuevo.`;

// Cached audio masculino (de un run premium anterior con voz George/Daniel)
const SOURCE_AUDIO_MALE = resolve(
  REPO_ROOT,
  'storage',
  'runs',
  'premium-058d340a', // smoke premium #2 (tenía narrador masculino fresh)
  'audio.mp3',
);

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
  const overallStart = Date.now();
  const runId = `animado-largo-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/presets/doctor_broll_animado_comic_sepia.preset.json'), 'utf-8')),
  );

  console.log(`[largo] workDir=${workDir}`);
  console.log(`[largo] preset=${preset.id} · format=${preset.format?.id}`);

  const logger = createLogger(runId);
  const ctx: BlockContext = { runId, workDir, logger, brand, preset };
  const stepStart = (label: string) => { console.log(`[largo] >>> ${label} t=${((Date.now()-overallStart)/1000).toFixed(1)}s`); return Date.now(); };
  const stepEnd = (label: string, start: number) => console.log(`[largo] <<< ${label} elapsed=${((Date.now()-start)/1000).toFixed(1)}s`);

  // B.1 script
  let t = stepStart('script-processor');
  const sin = scriptProcessor.validateInput({ rawText: TEST_SCRIPT, language: 'es' });
  if (sin.isErr()) throw sin.error;
  const sp = await scriptProcessor.run(sin.value, ctx);
  if (sp.isErr()) throw sp.error;
  let parsedScript = sp.value;
  stepEnd('script-processor', t);

  // B.1.5 narrator
  t = stepStart('narrator-analyzer');
  const narratorRes = await narratorAnalyzer.run(parsedScript, ctx);
  if (narratorRes.isErr()) throw narratorRes.error;
  parsedScript = narratorRes.value;
  console.log(`[largo]     narrator=${parsedScript.narratorProfile?.gender}/${parsedScript.narratorProfile?.ageRange}`);
  stepEnd('narrator-analyzer', t);

  // B.2 TTS — reuse cached masculine audio si gender matches
  t = stepStart('tts');
  const audioPath = resolve(workDir, 'audio.mp3');
  if (parsedScript.narratorProfile?.gender === 'male' && existsSync(SOURCE_AUDIO_MALE)) {
    await copyFile(SOURCE_AUDIO_MALE, audioPath);
    console.log(`[largo]     audio cacheado MASCULINO reusado de ${SOURCE_AUDIO_MALE}`);
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
  console.log(`[largo]     audio=${realAudioDuration.toFixed(2)}s`);
  parsedScript = { ...parsedScript, estimatedDurationSeconds: realAudioDuration };
  const audioTrack: AudioTrack = {
    filePath: audioPath, durationSeconds: realAudioDuration, sampleRate: 44100, channels: 1, format: 'mp3',
    segments: parsedScript.segments.map((s, i, arr) => ({
      text: s.text, startTimeSeconds: (i * realAudioDuration) / arr.length, endTimeSeconds: ((i + 1) * realAudioDuration) / arr.length,
    })),
  };
  stepEnd('tts', t);

  // B.3 subs
  t = stepStart('subtitles');
  const subs = await subtitlesGoogle.run(audioTrack, ctx);
  if (subs.isErr()) throw subs.error;
  const subtitleTrack = subs.value;
  console.log(`[largo]     subs=${subtitleTrack.lines.length} líneas / ${subtitleTrack.words.length} palabras`);
  stepEnd('subtitles', t);

  // B.4 scene-planner
  t = stepStart('scene-planner');
  const planner = new ScenePlannerBlock({});
  const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (planResult.isErr()) throw planResult.error;
  let sceneTrack = planResult.value;
  await writeFile(resolve(workDir, 'scene-plan.json'), JSON.stringify(sceneTrack, null, 2));
  console.log(`[largo]     scenes=${sceneTrack.scenes.length}`);
  stepEnd('scene-planner', t);

  // B.5 image-gen-multi — CONCURRENCY 8, SKIP VALIDATOR (animado)
  t = stepStart('image-gen-multi (conc 8, skip validator)');
  const openaiKey = process.env['OPENAI_API_KEY'];
  const googleKey = process.env['GOOGLE_AI_API_KEY']!;
  const gcpProj = process.env['GCP_PROJECT_ID'];
  const hKid = process.env['HIGGSFIELD_KEY_ID'];
  const hSecret = process.env['HIGGSFIELD_KEY_SECRET'];
  const chain: ProviderStep[] = [];
  if (openaiKey && openaiKey !== 'sk_pendiente') {
    chain.push({ provider: new OpenaiImageProvider({ apiKey: openaiKey, quality: 'medium' }), model: 'gpt-image-1', label: 'openai:gpt-image-1' });
  }
  if (gcpProj) {
    const v = new VertexImagenProvider({ projectId: gcpProj });
    chain.push(
      { provider: v, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
      { provider: v, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
    );
  }
  if (hKid && hSecret) {
    chain.push({
      provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
      model: 'flux-pro/kontext/max/text-to-image',
      label: 'higgsfield:flux-pro-kontext',
    });
  }
  chain.push({ provider: new GoogleImagenProvider({ apiKey: googleKey }), model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' });
  console.log(`[largo]     chain providers: ${chain.map((c) => c.label).join(' → ')}`);

  const imageMulti = new ImageGenMultiBlock({
    // Concurrency 3 contra Vertex (1 RPM new accounts) + Higgsfield + AI Studio.
    // VALIDATOR SIEMPRE ON — estándar operativo, no podemos enviar pies con
    // 4 dedos gigantes. fastMode + 1 retry mantiene velocidad razonable.
    concurrency: 3,
    minIntervalMs: 8000,
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
  console.log(`[largo]     imágenes=${sceneTrack.scenes.length}`);
  stepEnd('image-gen-multi', t);

  // B.5.5 scene-animator — Kling primary, Veo fallback
  const klingAk = process.env['KLING_ACCESS_KEY'];
  const klingSk = process.env['KLING_SECRET_KEY'];
  const useKling = Boolean(klingAk && klingSk);
  const ANIM_CONCURRENCY = useKling ? 5 : 4; // Kling resource pack = 5 paralelos
  t = stepStart(`scene-animator (POOL conc ${ANIM_CONCURRENCY} · ${useKling ? 'Kling primary + Veo fallback' : 'Veo only'})`);
  const veo = new VeoClient({ apiKey: googleKey });
  const kling = useKling ? new KlingClient({ accessKey: klingAk!, secretKey: klingSk! }) : null;
  let doneCount = 0;
  const total = sceneTrack.scenes.length;
  const animScenes: typeof sceneTrack.scenes = new Array(total);
  const queue = sceneTrack.scenes.map((s, i) => ({ scene: s, idx: i }));

  // Pool con N workers reales. Cuando uno termina, el siguiente arranca → CERO
  // saturación 1303 porque Kling siempre ve max N submits in-flight.
  async function workerLoop(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { scene, idx } = item;
      if (!scene.imagePath || !existsSync(scene.imagePath)) {
        animScenes[idx] = scene;
        doneCount++;
        continue;
      }
      const imgBuf = await readFile(scene.imagePath);
      const motionPrompt = `${scene.imagePrompt.slice(0, 200)}\n\nMotion: subtle natural movement only — keep SAME composition, character breathes and blinks, gentle 5% camera push-in, no scene changes, watercolor sepia style maintained.`;
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
          doneCount++;
          console.log(`[largo]     [${doneCount}/${total}] scene_${String(scene.index).padStart(2, '0')} OK Kling (${videoBuffer.length} bytes)`);
          succeeded = true;
        } catch (e) {
          console.warn(`[largo]     scene_${scene.index} Kling failed: ${(e as Error).message.slice(0, 100)} — trying Veo...`);
        }
      }
      if (!succeeded) {
        try {
          const videoBuffer = await veo.generate({
            prompt: motionPrompt,
            imageBase64: imgBuf.toString('base64'),
            imageMimeType: 'image/png',
            aspectRatio: '9:16',
            durationSeconds: 8,
            model: 'veo-3.1-lite-generate-preview',
          });
          await writeFile(videoPath, videoBuffer);
          animScenes[idx] = { ...scene, videoPath };
          doneCount++;
          console.log(`[largo]     [${doneCount}/${total}] scene_${String(scene.index).padStart(2, '0')} OK Veo (${videoBuffer.length} bytes)`);
        } catch (e) {
          animScenes[idx] = scene;
          doneCount++;
          const msg = (e as Error).message.slice(0, 150);
          console.warn(`[largo]     [${doneCount}/${total}] scene_${scene.index} FAILED → static. ${msg}`);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ANIM_CONCURRENCY, total) }, () => workerLoop()),
  );
  sceneTrack = { ...sceneTrack, scenes: animScenes.filter(Boolean) };
  const animatedCount = animScenes.filter((s) => s.videoPath).length;
  console.log(`[largo]     ${animatedCount}/${total} escenas animadas`);
  stepEnd('scene-animator', t);

  // B.6 compositor
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
  stepEnd('compositor', t);

  const total_elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n[largo] ============================================`);
  console.log(`[largo] TOTAL: ${total_elapsed}s = ${(Number(total_elapsed)/60).toFixed(1)} min`);
  console.log(`[largo] OUTPUT: ${outputPath}`);
  console.log(`[largo] ============================================`);
}

main().catch((err) => {
  console.error('[largo] FAILED:', err);
  process.exit(1);
});
