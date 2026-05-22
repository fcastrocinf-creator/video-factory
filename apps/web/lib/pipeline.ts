import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createLogger, type BlockContext } from '@video-factory/core';
import type { RenderJob, SceneTrack, VideoTrack } from '@video-factory/contracts';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { narratorAnalyzer } from '@video-factory/block-narrator-analyzer';
import { ttsElevenLabs } from '@video-factory/block-tts-elevenlabs';
import { ttsOpenai } from '@video-factory/block-tts-openai';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
// imageGenImagen legacy ya no se usa: el chain de single-image-fallback lo reemplaza.
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';
import { ImageGenMultiBlock, type ProviderStep } from '@video-factory/block-image-gen-multi';
import {
  FalProvider,
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
} from '@video-factory/block-image-gen-imagen';
import { VideoGenVeoBlock } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';
import { db, runs } from './db';
import { loadBrand, loadPreset } from './brand-preset-loader';
import { outputPathFor, workDirFor } from './paths';
import { CostTracker } from './cost-tracker';
import {
  checkTtsCache,
  copyFromCache,
  saveToCache,
  ttsCacheKeyFromScript,
} from './tts-cache';
import { refineSceneTrackWithIngredients } from './ingredients-vision-refiner';
import { generateSingleImageWithChain } from './single-image-fallback';
import { animateScenes } from './scene-animator';

interface RunUpdate {
  status?: 'pending' | 'running' | 'completed' | 'failed';
  currentStep?: string | null;
  progress?: number;
  outputPath?: string;
  errorMessage?: string;
  durationSeconds?: number;
  startedAt?: Date;
  completedAt?: Date;
  workDir?: string;
  estimatedCostUsd?: number;
  imageCount?: number;
  ttsCharsBilled?: number;
}

async function updateRun(runId: string, updates: RunUpdate): Promise<void> {
  await db.update(runs).set(updates).where(eq(runs.id, runId));
}

export interface PipelineOverrides {
  voiceOverride?: string | null;
  narratorGenderOverride?: 'male' | 'female' | 'neutral' | null;
  /**
   * Si está, activa el modo "Ripeo de alta fidelidad": antes del image-gen-multi
   * normal, se llama a rip-fidelity-aligner que extrae keyframes del referenceVideoPath
   * y genera cada escena en un loop iterativo contra esos keyframes hasta 95%
   * similitud. Más lento (~10-15 min) y más caro (~$2-3) pero produce imágenes
   * mucho más cercanas al estilo del original.
   */
  referenceVideoPath?: string | null;
}

export async function runPipeline(
  runId: string,
  brandId: string,
  presetId: string,
  scriptText: string,
  overrides: PipelineOverrides = {},
): Promise<void> {
  const logger = createLogger(runId);
  const workDir = workDirFor(runId);
  const outputPath = outputPathFor(runId);

  try {
    const [brandLoaded, preset] = await Promise.all([loadBrand(brandId), loadPreset(presetId)]);

    // Voice override desde la UI: si el usuario eligió una voz específica en el
    // dropdown, la sobreescribimos en brand.defaultVoice antes de que TTS la use.
    let brand = brandLoaded;
    if (overrides.voiceOverride) {
      const candidates = [brand.defaultVoice, ...(brand.voiceLibrary ?? [])];
      const chosen = candidates.find((v) => v.voiceId === overrides.voiceOverride);
      if (chosen) {
        brand = { ...brand, defaultVoice: chosen };
        logger.info(
          { runId, voiceId: chosen.voiceId, label: chosen.label, source: 'ui-override' },
          'pipeline:voice_override_applied',
        );
      } else {
        logger.warn(
          { runId, requested: overrides.voiceOverride },
          'pipeline:voice_override_not_found_falling_back',
        );
      }
    }

    await mkdir(workDir, { recursive: true });

    const ctx: BlockContext = { runId, workDir, logger, brand, preset };

    await updateRun(runId, {
      status: 'running',
      currentStep: 'script-processor',
      progress: 5,
      workDir,
      startedAt: new Date(),
    });

    // B.1 — Script processor
    const scriptInputResult = scriptProcessor.validateInput({
      rawText: scriptText,
      language: brand.language.split('-')[0] ?? 'es',
    });
    if (scriptInputResult.isErr()) {
      throw new Error(`Input inválido: ${scriptInputResult.error.message}`);
    }
    const parsedResult = await scriptProcessor.run(scriptInputResult.value, ctx);
    if (parsedResult.isErr()) throw parsedResult.error;
    let parsedScript = parsedResult.value;

    // B.1.5 — Narrator analyzer (CRÍTICO: corre ANTES de TTS para que la voz
    // se elija según el gender inferido del guion. Si el usuario forzó gender
    // override desde la UI, se respeta.)
    await updateRun(runId, { currentStep: 'narrator-analyzer', progress: 10 });
    if (overrides.narratorGenderOverride) {
      parsedScript = {
        ...parsedScript,
        narratorProfile: {
          gender: overrides.narratorGenderOverride,
          ageRange: parsedScript.narratorProfile?.ageRange ?? '40-55',
          characterCard: parsedScript.narratorProfile?.characterCard ?? '',
          narratorPresent: true,
        },
      };
      logger.info(
        { runId, gender: overrides.narratorGenderOverride, source: 'ui-override' },
        'pipeline:narrator_gender_override_applied',
      );
    } else {
      const narratorResult = await narratorAnalyzer.run(parsedScript, ctx);
      if (narratorResult.isErr()) throw narratorResult.error;
      parsedScript = narratorResult.value;
    }
    logger.info(
      { runId, narratorProfile: parsedScript.narratorProfile },
      'pipeline:narrator_resolved',
    );

    // B.2 — TTS con cache + fallback automático.
    //
    // 1) Cache hit: si ya generamos audio para el MISMO script + voz + provider,
    //    copiamos el mp3 cacheado a workDir/audio.mp3 y saltamos la llamada al API.
    //    Ahorra ~10s y los chars facturados.
    // 2) ElevenLabs primero (mejor calidad). Si falla quota/auth → OpenAI fallback.
    // 3) Tras generar fresh, guardamos al cache para reuse en futuros runs.
    const costTracker = new CostTracker();
    await updateRun(runId, { currentStep: 'tts-elevenlabs', progress: 15 });

    const evVoice = brand.defaultVoice;
    const elevenlabsCacheKey = ttsCacheKeyFromScript(
      parsedScript,
      evVoice.voiceId,
      evVoice.modelId,
      evVoice.speedMultiplier,
      'elevenlabs',
    );
    const elevenlabsHit = await checkTtsCache(elevenlabsCacheKey);

    let audioResult: Awaited<ReturnType<typeof ttsElevenLabs.run>>;
    if (elevenlabsHit) {
      logger.info({ runId, cachedPath: elevenlabsHit }, 'pipeline:tts_cache_hit');
      const audioPath = resolve(workDir, 'audio.mp3');
      await copyFromCache(elevenlabsHit, audioPath);
      // Necesitamos AudioTrack. Levantamos timing aproximado desde la duración del mp3.
      // El bloque elevenlabs lo derivaba; acá reconstruimos a mano para evitar la
      // llamada al API. Probamos el mp3 con ffprobe para duración real.
      const { spawnSync } = await import('node:child_process');
      const ffprobeArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath];
      const r = spawnSync('ffprobe', ffprobeArgs);
      const realDuration = r.status === 0 ? parseFloat(r.stdout.toString().trim()) : 60;
      audioResult = {
        isOk: () => true,
        isErr: () => false,
        value: {
          filePath: audioPath,
          durationSeconds: realDuration,
          sampleRate: 44100,
          channels: 1,
          format: 'mp3',
          segments: parsedScript.segments.map((s, i, arr) => ({
            text: s.text,
            startTimeSeconds: (i * realDuration) / arr.length,
            endTimeSeconds: ((i + 1) * realDuration) / arr.length,
          })),
        },
      } as Awaited<ReturnType<typeof ttsElevenLabs.run>>;
    } else {
      audioResult = await ttsElevenLabs.run(parsedScript, ctx);
      if (audioResult.isErr()) {
        const errCode = audioResult.error.code;
        const isQuotaOrAuth = /API_(401|402|429)/i.test(errCode) || /quota|unauthorized|payment/i.test(audioResult.error.message);
        if (isQuotaOrAuth) {
          logger.warn(
            { runId, primaryError: audioResult.error.message, primaryCode: errCode },
            'pipeline:tts_elevenlabs_failed_falling_back_to_openai',
          );
          await updateRun(runId, { currentStep: 'tts-openai-fallback' });
          // Cache key del fallback es distinto (provider distinto)
          const openaiCacheKey = ttsCacheKeyFromScript(
            parsedScript,
            'openai-default',
            'tts-1',
            1.0,
            'openai',
          );
          const openaiHit = await checkTtsCache(openaiCacheKey);
          if (openaiHit) {
            logger.info({ runId, cachedPath: openaiHit }, 'pipeline:tts_cache_hit_openai');
            const audioPath = resolve(workDir, 'audio.mp3');
            await copyFromCache(openaiHit, audioPath);
            const { spawnSync } = await import('node:child_process');
            const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
            const realDuration = r.status === 0 ? parseFloat(r.stdout.toString().trim()) : 60;
            audioResult = {
              isOk: () => true,
              isErr: () => false,
              value: {
                filePath: audioPath,
                durationSeconds: realDuration,
                sampleRate: 44100,
                channels: 1,
                format: 'mp3',
                segments: parsedScript.segments.map((s, i, arr) => ({
                  text: s.text,
                  startTimeSeconds: (i * realDuration) / arr.length,
                  endTimeSeconds: ((i + 1) * realDuration) / arr.length,
                })),
              },
            } as Awaited<ReturnType<typeof ttsElevenLabs.run>>;
          } else {
            audioResult = await ttsOpenai.run(parsedScript, ctx);
            if (audioResult.isOk()) {
              await saveToCache(audioResult.value.filePath, openaiCacheKey);
              const chars = parsedScript.segments.map((s) => s.text).join(' ').length;
              costTracker.addTts('openai', chars);
            }
          }
        }
      } else {
        // Hit fresh ElevenLabs: guardar al cache
        await saveToCache(audioResult.value.filePath, elevenlabsCacheKey);
        const chars = parsedScript.segments.map((s) => s.text).join(' ').length;
        costTracker.addTts('elevenlabs', chars);
      }
    }
    if (audioResult.isErr()) throw audioResult.error;
    const audioTrack = audioResult.value;

    // B.3 — Subtitles
    await updateRun(runId, { currentStep: 'subtitles-google', progress: 30 });
    const subsResult = await subtitlesGoogle.run(audioTrack, ctx);
    if (subsResult.isErr()) throw subsResult.error;
    const subtitleTrack = subsResult.value;

    // BRANCH POR ESTRATEGIA DEL PRESET
    //
    // CRITERIO: estrategia decide CUÁNTAS escenas (one vs many). visualEngine
    // decide CÓMO renderizar cada escena (static vs animated). Son ortogonales.
    //
    //   multi_escena + imagen4  → N escenas estáticas (B-ROLL Estático, VSL, UGC B-ROLL)
    //   multi_escena + veo-*    → N escenas animadas (B-ROLL Animado, Voice Over Animado)
    //   plano_fijo  + imagen4   → 1 imagen estática (legacy plano fijo)
    //   plano_fijo  + veo-*     → 1 imagen + Veo talking head (legacy)
    const usesMultiEscena = preset.estrategia === 'multi_escena';
    const wantsAnimation = preset.visualEngine.startsWith('veo-');
    const isAnimatedFormat =
      preset.format?.id === 'b-roll-animated' || preset.format?.id === 'voiceover-animated';
    // El flujo legacy (plano_fijo) usa Veo solo cuando NO es multi-escena (1 imagen + animación).
    // Para multi-escena con animación, cada escena se anima en el compositor con motion fuerte.
    const usesVeo = wantsAnimation && !usesMultiEscena;

    if (usesMultiEscena) {
      // ============================================================
      // FLOW MULTI-ESCENA con validators + auto-correction
      // ============================================================

      // B.4 — Scene planner (con narratorProfile y word-level timing)
      await updateRun(runId, { currentStep: 'scene-planner', progress: 40 });
      const planner = new ScenePlannerBlock({});
      const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
      if (planResult.isErr()) throw planResult.error;
      let sceneTrack = planResult.value;

      // B.4.5 — Ingredients visual loop: refinar imagePrompts con GPT-4o vision
      // para escenas que mencionan productos / assets de la marca. Solo aplica
      // si la marca tiene assets en su biblioteca (sino, devuelve el track sin cambios).
      if (brand.ingredients?.assets && brand.ingredients.assets.length > 0) {
        await updateRun(runId, { currentStep: 'ingredients-vision-refine', progress: 48 });
        try {
          const refined = await refineSceneTrackWithIngredients(sceneTrack, brand);
          const changed = refined.scenes.filter(
            (s, i) => s.imagePrompt !== sceneTrack.scenes[i]?.imagePrompt,
          ).length;
          if (changed > 0) {
            logger.info({ runId, refinedScenes: changed }, 'pipeline:ingredients_refined');
            // Cada llamada GPT-4o vision: ~$0.003 (input + output)
            for (let i = 0; i < changed; i++) {
              costTracker.addGeminiVision('flash', 1); // approximation
            }
          }
          sceneTrack = refined;
        } catch (e) {
          logger.warn({ err: (e as Error).message }, 'pipeline:ingredients_refine_failed');
        }
      }

      // B.5 — Image-gen-multi con validators per-scene + sequence-level + auto-regen
      await updateRun(runId, { currentStep: 'image-gen-multi', progress: 55 });
      // Provider chain — orden de fallback automático cuando un step agota quota:
      //   1: OpenAI gpt-image-1 (primario, sin daily caps, ~$0.04/img medium, ~15-30s)
      //   2-4: Vertex AI Imagen (project quota) — si GCP creds seteadas
      //   5-7: Google AI Studio Imagen (Tier 1, daily caps 170/día)
      //   8: Higgsfield Flux Pro Kontext (si keys seteadas)
      //   9-10: fal.ai (Flux Pro / Dev) — si FAL_API_KEY seteada
      const openaiApiKey = process.env['OPENAI_API_KEY'];
      const googleApiKey = process.env['GOOGLE_AI_API_KEY'];
      const falApiKey = process.env['FAL_API_KEY'];
      const gcpProjectId = process.env['GCP_PROJECT_ID'];
      const gcpCredentials = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      const providerChain: ProviderStep[] = [];

      // OpenAI gpt-image-1 como primario — sin daily caps, billing directo OpenAI
      if (openaiApiKey && openaiApiKey !== 'sk_pendiente') {
        const openaiProvider = new OpenaiImageProvider({
          apiKey: openaiApiKey,
          quality: 'medium', // balance precio/calidad
        });
        providerChain.push({
          provider: openaiProvider,
          model: 'gpt-image-1',
          label: 'openai:gpt-image-1',
        });
      }

      // Vertex AI como secundario (sin daily caps, project quota)
      if (gcpProjectId && gcpCredentials) {
        const vertexProvider = new VertexImagenProvider({ projectId: gcpProjectId });
        providerChain.push(
          { provider: vertexProvider, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
          { provider: vertexProvider, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
          { provider: vertexProvider, model: 'imagen-4.0-ultra-generate-001', label: 'vertex:ultra' },
        );
      }
      // AI Studio Imagen como terciario (cuando vuelva su daily quota). Sólo si
      // GOOGLE_AI_API_KEY está configurada; si no, lo saltamos sin romper la chain.
      if (googleApiKey) {
        const googleProvider = new GoogleImagenProvider({ apiKey: googleApiKey });
        providerChain.push(
          { provider: googleProvider, model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' },
          { provider: googleProvider, model: 'imagen-4.0-generate-001', label: 'aistudio:std' },
          { provider: googleProvider, model: 'imagen-4.0-ultra-generate-001', label: 'aistudio:ultra' },
        );
      }
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
      }
      if (falApiKey) {
        const falProvider = new FalProvider({ apiKey: falApiKey, defaultModel: 'fal-ai/flux-pro/v1.1' });
        providerChain.push(
          { provider: falProvider, model: 'fal-ai/flux-pro/v1.1', label: 'fal:flux-pro-v1.1' },
          { provider: falProvider, model: 'fal-ai/flux/dev', label: 'fal:flux-dev' },
        );
      }
      // === MODO ALTA FIDELIDAD: rip-fidelity-aligner ===
      // Si recibimos un referenceVideoPath (modo "Ripeo fiel"), antes del image-gen
      // normal corremos un loop iterativo que genera CADA escena y la compara contra
      // un keyframe del original, refinando el prompt hasta lograr ≥95% similitud
      // o agotar intentos. Las imágenes resultantes se persisten en workDir/scene_XX.png
      // y luego saltamos el ImageGenMultiBlock (las imágenes ya están). El validator V3
      // se puede correr opcionalmente sobre las imágenes resultantes — por ahora
      // confiamos en el comparador per-scene como suficiente.
      let sceneTrackWithImages: SceneTrack;
      if (overrides.referenceVideoPath) {
        await updateRun(runId, { currentStep: 'rip-fidelity-aligner', progress: 55 });
        logger.info(
          { runId, referenceVideoPath: overrides.referenceVideoPath, scenes: sceneTrack.scenes.length },
          'pipeline:rip_fidelity_starting',
        );
        // Detectamos si el estilo es photo-realistic para que el aligner priorice
        // Flux/gpt-image-1 en el chain.
        const styleBaseLower = (sceneTrack.styleBase ?? '').toLowerCase();
        const preferRealistic =
          /phone[- ]?shot|smartphone|selfie|hand[- ]?held|photo[- ]?realistic|dslr|stock footage|real woman|real man|real person|amateur|ugc|natural lighting/.test(
            styleBaseLower,
          ) &&
          !/hand[- ]?illustrated|hand[- ]?drawn|watercolor|sepia[- ]?tone|comic[- ]?style|cartoon|painted by hand|digital painting/.test(
            styleBaseLower,
          );
        const { alignScenesToReferenceVideo } = await import('./rip-fidelity-aligner');
        // Para el reviewer semántico: targetLanguage del brand (es/es-CL/en/etc.)
        // y productName del primer producto del brand (o null si no hay).
        const targetLanguage = brand.language.split('-')[0] ?? 'es';
        const productName = brand.products[0]?.name ?? null;
        const aligned = await alignScenesToReferenceVideo({
          sceneTrack,
          referenceVideoPath: overrides.referenceVideoPath,
          workDir,
          logger,
          preferRealistic,
          targetLanguage,
          productName,
          onSceneDone: (sceneIdx, score, attempts) => {
            // Actualizamos progress aproximado por escena (55-78% es el rango
            // que el image-gen normal usaría también)
            const pct = Math.min(
              78,
              55 + Math.round(((sceneIdx + 1) / sceneTrack.scenes.length) * 23),
            );
            void updateRun(runId, { progress: pct }).catch((dbErr) => {
              logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
            });
            logger.info(
              { sceneIdx, score: score.toFixed(1), attempts },
              'pipeline:rip_fidelity_scene_done',
            );
          },
        });
        sceneTrackWithImages = aligned.sceneTrack;
        logger.info(
          {
            runId,
            avgScore: aligned.avgScore.toFixed(1),
            converged: aligned.perScene.filter((s) => s.converged).length,
            total: aligned.perScene.length,
          },
          'pipeline:rip_fidelity_done',
        );
        // (cost tracking de las imágenes se hace en el for-loop común más abajo,
        // después del if/else — no duplicar aquí.)
      } else {
        // MODO RÁPIDO (default): image-gen-multi con validator V3 — flujo histórico
        // VALIDATOR SIEMPRE ACTIVO — estándar operativo. La animación NO enmascara
        // defectos anatómicos (pies con 4 dedos gigantes, manos extras, fusiones).
        const imageMulti = new ImageGenMultiBlock({
          concurrency: 8,
          minIntervalMs: 3500,
          providerChain,
          validate: true, // siempre
          maxValidationRetries: 1,
          minPassScore: 75,
          validateSequence: false,
          minSequenceScore: 75,
          narratorProfile: sceneTrack.narratorProfile,
          styleBase: sceneTrack.styleBase,
          fastMode: true,
        });
        const imageMultiCtx: BlockContext = {
          ...ctx,
          onBlockProgress: (subPct) => {
            const globalPct = Math.min(78, 55 + Math.round(subPct * 0.23));
            void updateRun(runId, { progress: globalPct }).catch((dbErr) => {
              logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
            });
          },
        };
        const imgResult = await imageMulti.run(sceneTrack, imageMultiCtx);
        if (imgResult.isErr()) throw imgResult.error;
        sceneTrackWithImages = imgResult.value;
      }
      // Cost tracking: asumimos OpenAI gpt-image-1 medium para todas las escenas
      // (es el primary del chain). Las regens cuestan extra: se loggean también.
      // Una mejora futura sería que el block reporte el provider real por escena.
      for (const _ of sceneTrackWithImages.scenes) {
        costTracker.addImage('openai', 'medium');
      }

      // B.5.5 — SCENE ANIMATOR: cuando el format es animated (b-roll-animated o
      // voiceover-animated), animamos cada imagen con Veo image-to-video. Esto
      // produce clips MP4 reales (personaje respira, cámara empuja, micro motion)
      // en lugar de solo CSS transforms. Costo: ~$3-12 extra. Se puede deshabilitar
      // con DISABLE_REAL_ANIMATION=1 para forzar fallback a Remotion CSS.
      const disableRealAnimation = process.env['DISABLE_REAL_ANIMATION'] === '1';
      if (isAnimatedFormat && !disableRealAnimation) {
        const veoApiKey = process.env['GOOGLE_AI_API_KEY'];
        if (veoApiKey) {
          await updateRun(runId, { currentStep: 'scene-animator', progress: 78 });
          logger.info(
            { runId, sceneCount: sceneTrackWithImages.scenes.length },
            'pipeline:scene_animator_starting',
          );
          try {
            const klingAccessKey = process.env['KLING_ACCESS_KEY'];
            const klingSecretKey = process.env['KLING_SECRET_KEY'];
            const animated = await animateScenes({
              sceneTrack: sceneTrackWithImages,
              workDir,
              veoApiKey,
              // Si Kling está configurado, es primary (más rápido + más concurrencia)
              klingAccessKey,
              klingSecretKey,
              klingModel: 'kling-v2-6',
              klingMode: 'std',
              klingDuration: '5',
              // Kling resource pack típico = 5 concurrentes (code 1303 si pasamos).
              // KlingClient internamente retry-with-backoff cualquier 1303 residual.
              concurrency: klingAccessKey && klingSecretKey ? 5 : 4,
              model: 'veo-3.1-lite-generate-preview',
              durationSeconds: 8,
              logger,
              onProgress: (d, t) => {
                const pct = Math.min(99, 78 + Math.round((d / t) * 2));
                void updateRun(runId, { progress: pct }).catch((dbErr) => {
                  logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
                });
              },
            });
            sceneTrackWithImages = animated;
            const animatedCount = animated.scenes.filter((s) => s.videoPath).length;
            logger.info(
              { animatedCount, total: animated.scenes.length },
              'pipeline:scene_animator_done',
            );
            // Cada clip Veo ~$0.10-0.40, lo loggeamos como image-gen del provider 'higgsfield'
            // (placeholder de costo medio — refinar después con precio real Veo).
            for (let i = 0; i < animatedCount; i++) {
              costTracker.addImage('higgsfield', 'high');
            }
          } catch (e) {
            logger.warn(
              { err: (e as Error).message },
              'pipeline:scene_animator_failed_falling_back_to_css',
            );
            // sceneTrackWithImages sigue con solo imagePath, Remotion usará Img+CSS
          }
        } else {
          logger.warn(
            { runId },
            'pipeline:scene_animator_skipped_no_veo_api_key',
          );
        }
      }

      // B.5.9 — Persistir el sceneTrack final como scene-plan.json en el workDir.
      // Es la fuente de verdad para: (a) las correcciones posteriores, (b) el
      // EDITOR MANUAL de composición — que lee este JSON para mostrar las piezas
      // de cada escena y reescribe acá los ajustes del usuario. Incluye el campo
      // `composition` (geometría libre) cuando el aligner lo generó.
      try {
        await writeFile(
          resolve(workDir, 'scene-plan.json'),
          JSON.stringify(sceneTrackWithImages, null, 2),
          'utf-8',
        );
      } catch (persistErr) {
        logger.warn({ runId, err: persistErr }, 'pipeline:scene_plan_persist_failed');
      }

      // B.6 — Compositor con sceneTrack
      await updateRun(runId, { currentStep: 'compositor-remotion', progress: 80 });
      const renderJob: RenderJob = {
        runId,
        brandId,
        presetId,
        parsedScript,
        audioTrack,
        subtitleTrack,
        imagePath: sceneTrackWithImages.scenes[0]?.imagePath ?? '',
        sceneTrack: sceneTrackWithImages,
        animatedScenes: isAnimatedFormat,
        outputPath,
        resolution: [1080, 1920],
        fps: 30,
        status: 'pending',
      };

      // Persistir el RenderJob completo como render-job.json. El endpoint de
      // RE-RENDER (editor de composición) lo recarga, le inyecta el sceneTrack
      // editado, y vuelve a correr SOLO el compositor — sin regenerar imágenes.
      try {
        await writeFile(
          resolve(workDir, 'render-job.json'),
          JSON.stringify(renderJob, null, 2),
          'utf-8',
        );
      } catch (persistErr) {
        logger.warn({ runId, err: persistErr }, 'pipeline:render_job_persist_failed');
      }

      const compCtx: BlockContext = {
        ...ctx,
        onBlockProgress: (subPct) => {
          const globalPct = Math.min(99, 80 + Math.round(subPct * 0.19));
          void updateRun(runId, { progress: globalPct }).catch((dbErr) => {
            logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
          });
        },
      };
      const renderResult = await compositorRemotion.run(renderJob, compCtx);
      if (renderResult.isErr()) throw renderResult.error;
    } else {
      // ============================================================
      // FLOW LEGACY: una sola imagen (+ Veo opcional)
      // ============================================================

      // Legacy plano_fijo: ahora con provider chain (OpenAI primary, no solo AI Studio)
      await updateRun(runId, { currentStep: 'image-gen-imagen', progress: 50 });
      const imageAsset = await generateSingleImageWithChain({
        workDir,
        brand,
        preset,
      });
      // Cost approx para single image OpenAI medium
      costTracker.addImage('openai', 'medium');

      let videoTrack: VideoTrack | undefined;
      if (usesVeo) {
        await updateRun(runId, { currentStep: 'video-gen-veo', progress: 60 });
        const targetDuration = audioTrack.durationSeconds;
        const clipCount = Math.max(1, Math.ceil(targetDuration / 8));
        const veoBlock = new VideoGenVeoBlock({ targetDurationSeconds: targetDuration, clipCount });
        const veoCtx: BlockContext = {
          ...ctx,
          onBlockProgress: (subPct) => {
            const globalPct = Math.min(75, 60 + Math.round(subPct * 0.15));
            void updateRun(runId, { progress: globalPct }).catch((dbErr) => {
              logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
            });
          },
        };
        const veoResult = await veoBlock.run(imageAsset, veoCtx);
        if (veoResult.isErr()) {
          logger.warn(
            { runId, err: veoResult.error.message, code: veoResult.error.code },
            'pipeline:veo_failed_falling_back_to_plano_fijo',
          );
          await updateRun(runId, { currentStep: 'video-gen-veo-skipped' });
        } else {
          videoTrack = veoResult.value;
        }
      }

      await updateRun(runId, { currentStep: 'compositor-remotion', progress: 80 });
      const renderJob: RenderJob = {
        runId,
        brandId,
        presetId,
        parsedScript,
        audioTrack,
        subtitleTrack,
        imagePath: imageAsset.filePath,
        videoTrack,
        animatedScenes: false, // flujo legacy plano_fijo no usa multi-scene animation
        outputPath,
        resolution: [1080, 1920],
        fps: 30,
        status: 'pending',
      };
      const compCtx: BlockContext = {
        ...ctx,
        onBlockProgress: (subPct) => {
          const globalPct = Math.min(99, 80 + Math.round(subPct * 0.19));
          void updateRun(runId, { progress: globalPct }).catch((dbErr) => {
            logger.warn({ err: dbErr }, 'pipeline:progress_update_failed');
          });
        },
      };
      const renderResult = await compositorRemotion.run(renderJob, compCtx);
      if (renderResult.isErr()) throw renderResult.error;
    }

    const costSummary = costTracker.summary;
    await updateRun(runId, {
      status: 'completed',
      currentStep: null,
      progress: 100,
      outputPath,
      durationSeconds: audioTrack.durationSeconds,
      estimatedCostUsd: costSummary.totalUsd,
      imageCount: costSummary.imageCount,
      ttsCharsBilled: costSummary.ttsChars,
      completedAt: new Date(),
    });

    logger.info(
      { runId, outputPath, multiEscena: usesMultiEscena, costUsd: costSummary.totalUsd.toFixed(3) },
      'pipeline:completed',
    );

    // Si este run usó un preset aprendido (learned-*), generamos un GIF preview
    // para que /create lo muestre como thumbnail. Best-effort: si ffmpeg no está
    // disponible o falla, el preset queda sin preview pero sigue funcional.
    if (presetId.startsWith('learned-')) {
      try {
        const { generateLearnedPresetPreview } = await import('./preset-preview-generator');
        const result = await generateLearnedPresetPreview(presetId, outputPath);
        if (result.success) {
          logger.info(
            { runId, presetId, previewPath: result.previewPath },
            'pipeline:learned_preset_preview_generated',
          );
        }
      } catch (previewErr) {
        logger.warn(
          { runId, presetId, err: (previewErr as Error).message },
          'pipeline:learned_preset_preview_failed',
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId, error: message }, 'pipeline:failed');
    try {
      await updateRun(runId, {
        status: 'failed',
        errorMessage: message,
        completedAt: new Date(),
      });
    } catch (dbErr) {
      // Si hasta el update de "failed" falla, el run queda en estado "running"
      // hasta limpieza manual. Loggeamos para forense.
      logger.error(
        { runId, dbErr: dbErr instanceof Error ? dbErr.message : String(dbErr) },
        'pipeline:failed_status_persist_failed',
      );
    }
  }
}
