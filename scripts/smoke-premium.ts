// Smoke premium: 30 escenas cinemáticas con Gemini 2.5 Pro + Imagen 4 + hard cuts.
// Reusa audio cacheado. Costo ~$2/video.

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
  FalProvider,
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
} from '@video-factory/block-image-gen-imagen';
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

// targetSceneCount ahora se deriva de la duración REAL del audio dentro del
// scene-planner (25 escenas/min). Si querés forzar, pasalo aquí.
const TARGET_SCENES: number | undefined = undefined;

// Ruta al ffprobe bundleado por Remotion (Windows). Lo usamos para leer la
// duración REAL del mp3 — la estimación del script-processor difiere ±10s.
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
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  if (r.status !== 0) {
    throw new Error(`ffprobe falló: ${r.stderr.toString()}`);
  }
  const sec = parseFloat(r.stdout.toString().trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`ffprobe duración inválida: "${r.stdout}"`);
  }
  return sec;
}

async function main() {
  const runId = `premium-${randomUUID().slice(0, 8)}`;
  const workDir = resolve(REPO_ROOT, 'storage', 'runs', runId);
  await mkdir(workDir, { recursive: true });

  const brand = BrandConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, 'packages/brands/vitaly.brand.json'), 'utf-8')),
  );
  const preset = PresetConfigSchema.parse(
    JSON.parse(
      await readFile(resolve(REPO_ROOT, 'packages/presets/educativo_premium.preset.json'), 'utf-8'),
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`[premium] workDir=${workDir}`);

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

  // B.1.5 — Narrator analyzer (necesario ANTES de decidir si cached audio sirve)
  const narratorRes = await narratorAnalyzer.run(parsedScript, ctx);
  if (narratorRes.isErr()) throw narratorRes.error;
  parsedScript = narratorRes.value;
  const narratorGender = parsedScript.narratorProfile?.gender ?? 'neutral';
  const brandVoiceGender = brand.defaultVoice.gender;

  // Decisión de audio: si narratorGender matchea con brand.defaultVoice.gender,
  // podemos reusar el cached audio (más rápido). Si no, REGENERAR para que la
  // voz coincida con el personaje narrador.
  const audioPath = resolve(workDir, 'audio.mp3');
  let realAudioDuration: number;

  const cachedAudioCompatible =
    existsSync(SOURCE_AUDIO) &&
    (narratorGender === 'neutral' || narratorGender === brandVoiceGender);

  if (cachedAudioCompatible) {
    await copyFile(SOURCE_AUDIO, audioPath);
    realAudioDuration = probeAudioDurationSeconds(audioPath);
    // eslint-disable-next-line no-console
    console.log(
      `[premium] usando cached audio (narrator.gender=${narratorGender} match brand.defaultVoice.gender=${brandVoiceGender})`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[premium] narrator.gender=${narratorGender} ≠ brand.defaultVoice.gender=${brandVoiceGender} — intentando TTS FRESH con voice-selector activo`,
    );
    let ttsRes = await ttsElevenLabs.run(parsedScript, ctx);
    if (ttsRes.isErr()) {
      const errCode = ttsRes.error.code;
      const isQuotaOrAuth = /API_(401|402|429)/i.test(errCode) || /quota|unauthorized|payment/i.test(ttsRes.error.message);
      if (isQuotaOrAuth) {
        // eslint-disable-next-line no-console
        console.log(`[premium] ElevenLabs falló (${errCode}). Intentando OpenAI TTS como fallback...`);
        ttsRes = await ttsOpenai.run(parsedScript, ctx);
      }
    }
    if (ttsRes.isErr()) {
      // ElevenLabs quota o error: fallback a cached audio si existe.
      // El usuario verá voz femenina del cached, pero el resto del pipeline
      // (validators, overlays) sí va a correr fresh sobre las nuevas imágenes.
      // eslint-disable-next-line no-console
      console.warn(
        `[premium] TTS falló (${ttsRes.error.code}: ${ttsRes.error.message.slice(0, 120)}). Cayendo a cached audio.`,
      );
      if (!existsSync(SOURCE_AUDIO)) {
        throw new Error(
          `TTS falló y no hay cached audio en ${SOURCE_AUDIO}. Cargá créditos ElevenLabs o setea otro audio fuente.`,
        );
      }
      await copyFile(SOURCE_AUDIO, audioPath);
    } else if (!existsSync(audioPath)) {
      const fresh = ttsRes.value.filePath;
      await copyFile(fresh, audioPath);
    }
    realAudioDuration = probeAudioDurationSeconds(audioPath);
  }

  // Actualizamos parsedScript.estimatedDurationSeconds con duración REAL
  parsedScript = { ...parsedScript, estimatedDurationSeconds: realAudioDuration };
  // eslint-disable-next-line no-console
  console.log(`[premium] audioReal=${realAudioDuration.toFixed(2)}s`);

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

  // B.3 subtitles-google (necesario para timing word-level que usa scene-planner v2)
  const subs = await subtitlesGoogle.run(audioTrack, ctx);
  if (subs.isErr()) throw subs.error;
  const subtitleTrack = subs.value;
  // eslint-disable-next-line no-console
  console.log(`[premium] B.3 OK: ${subtitleTrack.lines.length} líneas, ${subtitleTrack.words.length} palabras`);

  // Dump subtitleTrack para debug (audio real 64s vs estimación 73s — quiero ver
  // qué endTimeSeconds tiene la última palabra para detectar el bug de cola).
  await writeFile(resolve(workDir, 'subtitles.debug.json'), JSON.stringify(subtitleTrack, null, 2));
  const lastWordEnd = Math.max(0, ...subtitleTrack.words.map((w) => w.endTimeSeconds));
  // eslint-disable-next-line no-console
  console.log(`[premium] subtitle last-word end = ${lastWordEnd.toFixed(2)}s (audio real ${realAudioDuration.toFixed(2)}s)`);

  // B.1.5 scene-planner v2 con timing word-level (auto-deriva targetSceneCount de duración real)
  const planner = new ScenePlannerBlock(
    TARGET_SCENES !== undefined ? { targetSceneCount: TARGET_SCENES } : {},
  );
  const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
  if (planResult.isErr()) throw planResult.error;
  const sceneTrack = planResult.value;
  // eslint-disable-next-line no-console
  console.log(`[premium] Scene-planner OK: ${sceneTrack.scenes.length} escenas`);
  for (const s of sceneTrack.scenes) {
    // eslint-disable-next-line no-console
    console.log(
      `  [${s.index}] ${s.startTimeSeconds.toFixed(1)}-${s.endTimeSeconds.toFixed(1)}s "${s.text.slice(0, 50)}" → ${s.imagePrompt.slice(0, 80)}...`,
    );
  }

  // Persistimos el plan a disco como checkpoint — si un re-run quiere reusar el plan
  // (ej. después de un quota error) puede cargar este JSON en lugar de re-planificar.
  await writeFile(
    resolve(workDir, 'scene-plan.json'),
    JSON.stringify(sceneTrack, null, 2),
  );

  // eslint-disable-next-line no-console
  console.log(
    `[premium] NarratorProfile: gender=${sceneTrack.narratorProfile?.gender ?? '?'} age=${sceneTrack.narratorProfile?.ageRange ?? '?'} present=${sceneTrack.narratorProfile?.narratorPresent ?? false}`,
  );
  if (sceneTrack.narratorProfile?.characterCard) {
    // eslint-disable-next-line no-console
    console.log(`[premium] CharacterCard: "${sceneTrack.narratorProfile.characterCard}"`);
  }

  // B.4-multi v3 con PROVIDER CHAIN.
  //   1: OpenAI gpt-image-1 (primario, sin daily caps, ~$0.04/img medium, ~15-30s)
  //   2-4: Vertex AI Imagen (project quota) — si GCP creds seteadas
  //   5-7: Google AI Studio Imagen (Tier 1, daily caps duros 170/día)
  //   8: Higgsfield Flux Pro Kontext (si keys seteadas)
  //   9-10: fal.ai (Flux Pro / Dev) — si FAL_API_KEY seteada
  const openaiApiKey = process.env['OPENAI_API_KEY'];
  const googleApiKey = process.env['GOOGLE_AI_API_KEY']!;
  const falApiKey = process.env['FAL_API_KEY'];
  const gcpProjectId = process.env['GCP_PROJECT_ID'];
  const gcpCredentials = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  const googleProvider = new GoogleImagenProvider({ apiKey: googleApiKey });
  const providerChain: ProviderStep[] = [];

  // OpenAI gpt-image-1 primario (sin daily caps, billing directo OpenAI)
  if (openaiApiKey && openaiApiKey !== 'sk_pendiente') {
    const openaiProvider = new OpenaiImageProvider({
      apiKey: openaiApiKey,
      quality: 'medium',
    });
    providerChain.push({
      provider: openaiProvider,
      model: 'gpt-image-1',
      label: 'openai:gpt-image-1',
    });
    console.log('[premium] OpenAI gpt-image-1 primario (~$0.04/img, sin daily caps)');
  } else {
    console.log('[premium] OPENAI_API_KEY no seteada o placeholder');
  }

  // Vertex AI segundo si está configurado (sin daily caps, ~7s/img Fast)
  if (gcpProjectId && gcpCredentials) {
    const vertexProvider = new VertexImagenProvider({ projectId: gcpProjectId });
    providerChain.push(
      { provider: vertexProvider, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
      { provider: vertexProvider, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
      { provider: vertexProvider, model: 'imagen-4.0-ultra-generate-001', label: 'vertex:ultra' },
    );
    console.log(`[premium] Vertex AI secundario (project=${gcpProjectId})`);
  }

  // AI Studio como terciario (cuando vuelva su quota)
  providerChain.push(
    { provider: googleProvider, model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' },
    { provider: googleProvider, model: 'imagen-4.0-generate-001', label: 'aistudio:std' },
    { provider: googleProvider, model: 'imagen-4.0-ultra-generate-001', label: 'aistudio:ultra' },
  );

  const higgsfieldKeyId = process.env['HIGGSFIELD_KEY_ID'];
  const higgsfieldKeySecret = process.env['HIGGSFIELD_KEY_SECRET'];
  if (higgsfieldKeyId && higgsfieldKeySecret) {
    const higgsfieldProvider = new HiggsfieldImageProvider({
      keyId: higgsfieldKeyId,
      keySecret: higgsfieldKeySecret,
    });
    providerChain.push({
      provider: higgsfieldProvider,
      model: 'flux-pro/kontext/max/text-to-image',
      label: 'higgsfield:flux-pro-kontext',
    });
    console.log('[premium] Higgsfield habilitado (Flux Pro Kontext Max)');
  } else {
    console.log('[premium] Higgsfield no configurado (faltan HIGGSFIELD_KEY_ID / KEY_SECRET)');
  }

  if (falApiKey) {
    const falProvider = new FalProvider({ apiKey: falApiKey, defaultModel: 'fal-ai/flux-pro/v1.1' });
    providerChain.push(
      { provider: falProvider, model: 'fal-ai/flux-pro/v1.1', label: 'fal:flux-pro-v1.1' },
      { provider: falProvider, model: 'fal-ai/flux/dev', label: 'fal:flux-dev' },
    );
    console.log('[premium] fal.ai habilitado como fallback (Flux Pro v1.1 + Flux Dev)');
  } else {
    console.log('[premium] FAL_API_KEY no seteada');
  }

  const imageMulti = new ImageGenMultiBlock({
    // Vertex AI cuentas nuevas tienen ~5 RPM default. Hasta pedir aumento de quota,
    // mantenemos concurrency conservadora.
    concurrency: 2,
    minIntervalMs: 6000, // 1 request cada 6s = ~10 RPM máx, seguro bajo el cap
    maxApiRetries: 3,
    providerChain,
    validate: true,
    maxValidationRetries: 3, // panel de especialistas + 3 retries para alcanzar perfección
    minPassScore: 80, // panel multispecialist es más confiable → podemos exigir 80
    validateSequence: false,
    minSequenceScore: 75,
    narratorProfile: sceneTrack.narratorProfile,
    styleBase: sceneTrack.styleBase,
    fastMode: true,
  });
  const imgResult = await imageMulti.run(sceneTrack, ctx);
  if (imgResult.isErr()) throw imgResult.error;
  const sceneTrackWithImages = imgResult.value;
  // eslint-disable-next-line no-console
  console.log(`[premium] B.4-multi OK: ${sceneTrackWithImages.scenes.length} imágenes`);

  // B.5 compositor
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
  console.log(`[premium] B.5 OK: ${outputPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[premium] FAILED:', err);
  process.exit(1);
});
