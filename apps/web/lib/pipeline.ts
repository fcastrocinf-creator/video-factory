import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  GeminiImageProvider,
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
} from '@video-factory/block-image-gen-imagen';
import { VideoGenVeoBlock } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';
import {
  judgeFinalRender,
  runEditorLoop,
  type EditorAction,
  type FinalRenderReport,
} from '@video-factory/block-post-render-judge';
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
import { getVideoDurationSec } from './frame-extractor';
import { generateSingleImageWithChain } from './single-image-fallback';
import { animateScenes } from './scene-animator';
import { regenerateSingleScene } from './regenerate-single-scene';
import { runHolisticReview } from './validator-chat-ia-holistic';
import { fortifyPromptWithAntiPatterns, generateRunReport } from './validator-chat-ia';
import { proposePatchesFromOwnerComments } from './owner-feedback';
import { recordProposedPatch } from './prompt-evolution';
import { getSystemContextForPrompt } from './system-context';
import { logSystemEvent } from './system-log';
import { createScenePatchTracker } from './scene-patch-tracker';

interface RunUpdate {
  status?: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
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
  // v3.2 #114 collaborative mode
  pausedAtSceneIndex?: number | null;
  awaitingApproval?: boolean;
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
  /**
   * Si está, se busca brand.products.find(p => p.id === productId) y se pasa
   * el productName + productDescription al editor IA. CRÍTICO para detectar
   * mismatches semánticos visual-producto (ej. sublingual mostrado como tópico).
   */
  productId?: string | null;
  /**
   * v3.2 #115: modo de ejecución del pipeline.
   *   - 'auto' (default): corre todo sin esperar intervención humana.
   *   - 'collaborative': pausa entre cada scene esperando aprobación del owner
   *     vía POST /api/runs/[id]/resume. Sequential por diseño (concurrency=1).
   */
  mode?: 'auto' | 'collaborative';
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
      // v3.2 #142 (29-may-2026) FIX CRÍTICO: ANTES usábamos spawnSync('ffprobe')
      // crudo, pero ffprobe NO está en el PATH del sistema → fallaba SIEMPRE y
      // defaulteaba a 60s. Eso producía scenes de 6-11s imposibles (el bug de
      // duración que el owner detectó). AHORA usamos getVideoDurationSec() que
      // usa el ffmpeg BUNDLED (@remotion) — el mismo que extrae keyframes y SÍ
      // funciona. Fallback inteligente: estimar desde el texto (~15 char/s ES).
      const probedDuration = await getVideoDurationSec(audioPath);
      const estChars = parsedScript.segments.map((s) => s.text).join(' ').length;
      const realDuration =
        probedDuration && probedDuration > 0.5
          ? probedDuration
          : Math.max(3, estChars / 15);
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
            // v3.2 #142: mismo fix — ffmpeg bundled en vez de ffprobe del sistema.
            const probedDuration = await getVideoDurationSec(audioPath);
            const estChars = parsedScript.segments.map((s) => s.text).join(' ').length;
            const realDuration =
              probedDuration && probedDuration > 0.5
                ? probedDuration
                : Math.max(3, estChars / 15);
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
    //
    // DESACTIVADO 25-may-2026 por decisión del owner: los subtítulos
    // automáticos (Google STT del audio TTS) no tomaban bien las letras.
    // El owner los hace por fuera en post-producción.
    //
    // En lugar del call al provider, generamos un subtitleTrack VACÍO pero
    // válido en estructura (language del brand, words=[], lines=[]) para que
    // el resto del pipeline (compositor, scene-planner) reciba un objeto bien
    // tipado y NO renderice ningún overlay de subs.
    //
    // Para reactivar: descomentar las 3 líneas debajo + comentar el bloque
    // `const subtitleTrack = { ... }` actual.
    //
    // await updateRun(runId, { currentStep: 'subtitles-google', progress: 30 });
    // const subsResult = await subtitlesGoogle.run(audioTrack, ctx);
    // if (subsResult.isErr()) throw subsResult.error;
    // const subtitleTrack = subsResult.value;
    await updateRun(runId, { currentStep: 'subtitles-skipped', progress: 30 });
    const subtitleTrack = {
      language: 'es', // default español neutro — no afecta nada porque no se renderizan subs
      words: [] as Array<{ word: string; startTimeSeconds: number; endTimeSeconds: number }>,
      lines: [] as Array<{
        text: string;
        startTimeSeconds: number;
        endTimeSeconds: number;
        wordRefs: number[];
      }>,
    };
    logger.info(
      { runId, reason: 'owner-disabled-25may2026' },
      'pipeline:subtitles_skipped',
    );

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

    // v3.2 #105: hoisted al scope del pipeline entero para que el closing
    // updateRun pueda leer el advisory generado en cualquier rama.
    let editorAdvisoryMessage: string | null = null;

    if (usesMultiEscena) {
      // ============================================================
      // FLOW MULTI-ESCENA con validators + auto-correction
      // ============================================================

      // B.4 — Scene planner (con narratorProfile y word-level timing)
      // v3.2 #135 (29-may-2026): DETECCIÓN DE FORK.
      // Si existe fork-metadata.json en workDir, este run viene de un fork:
      //   - Saltamos scene-planner (reutilizamos el scene-plan.json copiado)
      //   - Pre-seteamos imagePath/videoPath en las scenes pre-aprobadas
      //   - El scene-animator + VALIDATOR los van a saltar automáticamente
      //     porque ya tienen videoPath (skipIfAnimated más abajo).
      let preApprovedSceneIndices: Set<number> = new Set();
      const forkMetaPath = resolve(workDir, 'fork-metadata.json');
      const isForkedRun = existsSync(forkMetaPath);

      // v3.2 #139: KNOWLEDGE BASE — leer las preferencias visuales del owner
      // acumuladas para este brand+preset y pasarlas al scene-planner para que
      // la PRIMERA generación ya las respete. Esto cierra el gap donde el
      // scene-planner generaba prompts sin ver las correcciones del owner
      // (que solo veía el VALIDATOR reactivamente). Best-effort: si falla, el
      // planner corre sin preferencias.
      let ownerPreferencesForPlanner = '';
      try {
        const { getRelevantCommentsForContext } = await import('./owner-feedback');
        const comments = await getRelevantCommentsForContext({
          brandId,
          presetId,
          limit: 25,
        });
        if (comments.length > 0) {
          // Deduplicar + tomar las más recientes. Cada comment es una
          // corrección que el owner dio en algún run anterior.
          const unique = Array.from(
            new Set(
              comments
                .map((c) => c.comment?.trim())
                .filter((c): c is string => Boolean(c) && c!.length > 5),
            ),
          ).slice(0, 12);
          if (unique.length > 0) {
            ownerPreferencesForPlanner = unique.map((c) => `- ${c}`).join('\n');
            logger.info(
              { runId, brandId, presetId, preferencesCount: unique.length },
              'pipeline:owner_preferences_loaded_for_planner',
            );
          }
        }
      } catch (prefErr) {
        logger.warn(
          { runId, err: (prefErr as Error).message },
          'pipeline:owner_preferences_load_failed',
        );
      }

      let sceneTrack: SceneTrack;
      if (isForkedRun) {
        try {
          const forkMetaRaw = await readFile(forkMetaPath, 'utf-8');
          const forkMeta = JSON.parse(forkMetaRaw) as {
            sourceRunId: string;
            fromSceneIndex: number;
            copiedScenes: number[];
          };
          const planRaw = await readFile(resolve(workDir, 'scene-plan.json'), 'utf-8');
          sceneTrack = JSON.parse(planRaw) as SceneTrack;
          preApprovedSceneIndices = new Set(forkMeta.copiedScenes);
          // Patch imagePath + videoPath de las scenes pre-aprobadas
          for (const scene of sceneTrack.scenes) {
            if (preApprovedSceneIndices.has(scene.index)) {
              const padded = String(scene.index).padStart(2, '0');
              const png = resolve(workDir, `scene_${padded}.png`);
              const mp4 = resolve(workDir, `scene_${padded}.mp4`);
              if (existsSync(png)) scene.imagePath = png;
              if (existsSync(mp4)) scene.videoPath = mp4;
            }
          }
          await updateRun(runId, { currentStep: 'fork-loaded', progress: 45 });
          logger.info(
            {
              runId,
              sourceRunId: forkMeta.sourceRunId,
              fromSceneIndex: forkMeta.fromSceneIndex,
              preApprovedCount: preApprovedSceneIndices.size,
              totalScenes: sceneTrack.scenes.length,
            },
            'pipeline:fork_detected_skipping_planner',
          );
        } catch (forkErr) {
          logger.warn(
            { runId, err: (forkErr as Error).message },
            'pipeline:fork_metadata_unusable_falling_back_to_full_pipeline',
          );
          // Fallback: si fork-metadata está corrupto, corremos planner normal
          await updateRun(runId, { currentStep: 'scene-planner', progress: 40 });
          const planner = new ScenePlannerBlock({
            ownerPreferences: ownerPreferencesForPlanner || undefined,
          });
          const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
          if (planResult.isErr()) throw planResult.error;
          sceneTrack = planResult.value;
        }
      } else {
        await updateRun(runId, { currentStep: 'scene-planner', progress: 40 });
        const planner = new ScenePlannerBlock({
          ownerPreferences: ownerPreferencesForPlanner || undefined,
        });
        const planResult = await planner.run({ parsedScript, subtitleTrack }, ctx);
        if (planResult.isErr()) throw planResult.error;
        sceneTrack = planResult.value;
      }

      // B.4.0 — AUTO-TRIM v3.2 (29-may-2026, owner feedback):
      // El scene-planner reparte tiempo proporcional a CHARACTERS, pero la
      // velocidad de habla varía con pausas/énfasis. Resultado: la escena
      // visual puede "quedar larga" o "cortar antes" del fin real de su
      // narración. Acá usamos audioTrack.segments (timing REAL del TTS por
      // segmento) para mapear cada scene.text a su ventana exacta de audio,
      // de modo que en el video final, cuando la voz deja de hablar el texto
      // de una scene, el clip se corta automáticamente al siguiente.
      //
      // El compositor-remotion ya respeta scene.endTimeSeconds — el clip de
      // 8s de Veo/Kling/Higgsfield se trunca en <Series.Sequence>. Solo hay
      // que recalibrar los timestamps de las scenes y todo lo demás funciona.
      try {
        const before = sceneTrack.scenes.map((s) => ({
          start: s.startTimeSeconds,
          end: s.endTimeSeconds,
        }));
        const { aligned, diagnostics } = alignScenesToAudioTiming(
          sceneTrack,
          audioTrack,
          parsedScript,
        );
        sceneTrack = aligned;
        const afterDurations = sceneTrack.scenes.map((s) =>
          +(s.endTimeSeconds - s.startTimeSeconds).toFixed(2),
        );
        const beforeDurations = before.map((b) => +(b.end - b.start).toFixed(2));
        logger.info(
          {
            runId,
            matchedScenes: diagnostics.matchedScenes,
            totalScenes: diagnostics.totalScenes,
            shiftsSec: diagnostics.shiftsSec.slice(0, 12),
            beforeDurations: beforeDurations.slice(0, 12),
            afterDurations: afterDurations.slice(0, 12),
            audioDuration: audioTrack.durationSeconds.toFixed(2),
          },
          'pipeline:scenes_aligned_to_audio_timing',
        );
      } catch (alignErr) {
        // Si la alineación falla por algún motivo (segments vacíos, etc.),
        // seguimos con el sceneTrack original — el normalize de abajo es la
        // red de seguridad.
        logger.warn(
          { runId, err: (alignErr as Error).message },
          'pipeline:align_scenes_to_audio_failed',
        );
      }

      // B.4.1 — FIX duration mismatch (25-may-2026 post-Test 7 owner feedback):
      // Si la última escena termina ANTES que el audio TTS, extendemos su
      // endTimeSeconds para cubrir hasta audio.duration. Esto evita el bug
      // recurrente de "video se corta y queda negro con audio sonando" que
      // M5 estaba detectando pero NO corrigiendo.
      //
      // La raíz: scene-planner divide el script en frases pero a veces la
      // última frase es corta vs duration audio del TTS (silencio de cierre,
      // breaths, etc.). El compositor renderiza hasta scene.endTimeSeconds
      // y deja el audio sobrando como negro.
      //
      // Fix: stretch la última scene. NO altera el ritmo de las primeras
      // (que ya están sincronizadas con el word-level timing).
      //
      // NOTA: después de B.4.0 esta red de seguridad rara vez activa, pero
      // la dejamos por si audioTrack.segments viene vacío y alignment no corrió.
      const lastScene = sceneTrack.scenes[sceneTrack.scenes.length - 1];
      if (lastScene && audioTrack.durationSeconds > lastScene.endTimeSeconds + 0.3) {
        const gap = audioTrack.durationSeconds - lastScene.endTimeSeconds;
        const originalEnd = lastScene.endTimeSeconds;
        lastScene.endTimeSeconds = audioTrack.durationSeconds;
        // Re-armar sceneTrack con totalDurationSeconds actualizado
        sceneTrack = {
          ...sceneTrack,
          scenes: sceneTrack.scenes,
          totalDurationSeconds: audioTrack.durationSeconds,
        };
        logger.info(
          {
            runId,
            originalLastEnd: originalEnd.toFixed(2),
            audioDuration: audioTrack.durationSeconds.toFixed(2),
            gapClosed: gap.toFixed(2),
          },
          'pipeline:scene_plan_duration_normalized',
        );
      }

      // B.4.4 — FORK PROPAGATION (v3.2 #137, 29-may-2026):
      // Cuando el run es un fork, las scenes pre-aprobadas pasan sin tocar la
      // pausa colaborativa (donde normalmente disparaba la propagación). Eso
      // dejaba a las scenes nuevas SIN aplicar las correcciones cross-run del
      // owner (ej. "mujer de 50 años, no embarazada"). Acá leemos esos
      // comentarios desde owner-feedback-memory y aplicamos propagateCorrections
      // ANTES de image-gen-multi, así las scenes nuevas arrancan con los
      // imagePrompts ya alineados a las lecciones del owner.
      if (isForkedRun && preApprovedSceneIndices.size > 0) {
        try {
          const { getRelevantCommentsForContext } = await import('./owner-feedback');
          const crossRunComments = await getRelevantCommentsForContext({
            brandId,
            presetId,
            limit: 20,
          });
          const combinedComment = crossRunComments
            .map((c) => c.comment)
            .filter((c): c is string => Boolean(c))
            .join('\n\n')
            .trim();
          if (combinedComment.length > 0) {
            const lastPreApproved = Math.max(...Array.from(preApprovedSceneIndices));
            const scenesToEvaluate = sceneTrack.scenes
              .filter((s) => s.index > lastPreApproved)
              .map((s) => ({ index: s.index, imagePrompt: s.imagePrompt, text: s.text }));
            if (scenesToEvaluate.length > 0 && process.env['ANTHROPIC_API_KEY']) {
              await updateRun(runId, {
                currentStep: `fork-propagation · ${scenesToEvaluate.length} scenes`,
                progress: 47,
              });
              const { propagateCorrections } = await import('./propagate-corrections');
              const prop = await propagateCorrections({
                apiKey: process.env['ANTHROPIC_API_KEY'],
                fromSceneIndex: lastPreApproved,
                ownerComment: combinedComment,
                scenesToEvaluate,
                brandContext: {
                  brandId,
                  productName: overrides.productId
                    ? brand.products.find((p) => p.id === overrides.productId)?.name
                    : undefined,
                  styleSummary:
                    [preset.format?.displayName, preset.style?.displayName]
                      .filter(Boolean)
                      .join(' · ') || undefined,
                  language: brand.language?.split('-')[0] ?? 'es',
                },
                logger,
              });
              if (prop && prop.updatedScenes.length > 0) {
                let mutated = 0;
                for (const u of prop.updatedScenes) {
                  if (u.unchanged) continue;
                  const target = sceneTrack.scenes.find((s) => s.index === u.sceneIndex);
                  if (target) {
                    target.imagePrompt = u.newPrompt;
                    mutated++;
                  }
                }
                // v3.2 #138 audit: persistir scene-plan.json en disco con
                // los nuevos prompts para que la UI (que polea
                // /api/runs/[id]/scene-plan) los vea actualizados ANTES de
                // que image-gen-multi empiece a generar.
                if (mutated > 0) {
                  try {
                    await writeFile(
                      resolve(workDir, 'scene-plan.json'),
                      JSON.stringify(sceneTrack, null, 2),
                      'utf-8',
                    );
                  } catch (persistErr) {
                    logger.warn(
                      { runId, err: (persistErr as Error).message },
                      'pipeline:fork_propagation_persist_failed',
                    );
                  }
                }
                logger.info(
                  {
                    runId,
                    forkPropagationMutated: mutated,
                    candidatesCount: scenesToEvaluate.length,
                    rationale: prop.rationale.slice(0, 200),
                  },
                  'pipeline:fork_eager_propagation_applied',
                );
              }
            }
          }
        } catch (propErr) {
          logger.warn(
            { runId, err: (propErr as Error).message },
            'pipeline:fork_eager_propagation_failed',
          );
        }
      }

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

      // v3.2 (29-may-2026): persistir scene-plan.json TEMPRANO con narración
      // por scene + imagePrompts iniciales. Permite que la UI del modo
      // colaborativo (/runs/[id]/build) muestre el "texto del guión narrado
      // en esta escena" desde antes de que termine el animator. Antes solo se
      // escribía al final (B.5.9) y el owner no veía el contexto durante el rip.
      try {
        await writeFile(
          resolve(workDir, 'scene-plan.json'),
          JSON.stringify(sceneTrack, null, 2),
          'utf-8',
        );
        logger.info(
          { runId, scenes: sceneTrack.scenes.length },
          'pipeline:scene_plan_persisted_early',
        );
      } catch (persistErr) {
        logger.warn(
          { runId, err: persistErr },
          'pipeline:scene_plan_early_persist_failed',
        );
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

      // Gemini Image (Nano Banana, modelo gemini-2.5-flash-image) — posicionado
      // ENTRE OpenAI y Vertex Imagen porque:
      //   - Pool de cuota INDEPENDIENTE de Vertex Imagen (que hoy 429ea por la
      //     cuota baja de los proyectos gen-lang-client-* y además muere 24 jun
      //     2026 cuando Google apague Imagen 4). Cuando Vertex falla, Gemini sigue.
      //   - Política de contenido generalmente más permisiva que gpt-image-1 —
      //     mejor para presets pediátricos/médicos/educativos que OpenAI rechaza
      //     (caso del preset doctor + bebé que tumbó OpenAI en testing previo).
      //   - Excelente calidad para ilustración estilizada (comic/acuarela/sepia).
      //   - Es el successor designado por Google a Imagen 4.
      if (googleApiKey) {
        const geminiImageProvider = new GeminiImageProvider({ apiKey: googleApiKey });
        providerChain.push({
          provider: geminiImageProvider,
          model: 'gemini-2.5-flash-image',
          label: 'gemini:nano-banana',
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

      // Hoisted (27-may-2026 v2): scenePatchTracker se necesita en AMBOS modos
      // (rip-fidelity y modo rápido) porque VALIDATOR CHAT IA reporta anti-patrones
      // a este tracker después del scene-animator, fuera del if/else original.
      const scenePatchTracker = createScenePatchTracker({
        runId,
        presetId,
        brandId,
      });

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

        // v2 (27-may-2026): scenePatchTracker hoisted al scope superior (ahora
        // está disponible en AMBOS modos para que VALIDATOR CHAT IA pueda reportar
        // anti-patrones también en modo rip-fidelity).

        // ALTA FIDELIDAD (gated): si el preset trae una imagen de referencia
        // (data-URI en visualStyle.referenceImages), la decodificamos y se la
        // pasamos al bloque para que Nano Banana ancle el estilo a esa imagen.
        // Si el preset NO tiene referencia, queda undefined y el bloque se
        // comporta EXACTAMENTE igual que siempre (cero impacto en otros estilos).
        let presetReferenceImage: Buffer | undefined;
        {
          const refStr = preset.visualStyle?.referenceImages?.[0];
          if (refStr && refStr.startsWith('data:')) {
            try {
              presetReferenceImage = Buffer.from(
                refStr.slice(refStr.indexOf(',') + 1),
                'base64',
              );
              logger.info(
                { runId, presetId, bytes: presetReferenceImage.length },
                'pipeline:preset_reference_image_loaded',
              );
            } catch (e) {
              logger.warn(
                { runId, err: (e as Error).message },
                'pipeline:preset_reference_image_decode_failed',
              );
            }
          }
        }

        const imageMulti = new ImageGenMultiBlock({
          concurrency: 8,
          minIntervalMs: 3500,
          providerChain,
          referenceImage: presetReferenceImage,
          validate: true, // siempre
          // M1 (24-may-2026 post Test 5 feedback): subir agresividad del validator
          // ahora que tenemos budget paid ($5-7/video) — antes 1 retry y score 75
          // dejaban pasar errores que el ojo humano nota. Trade-off: ~+2-3 min de
          // generación pero mucho menos basura. Si esto sigue siendo insuficiente,
          // entra M2 (Claude preview-judge) como segundo par de ojos.
          maxValidationRetries: 3,
          minPassScore: 85,
          validateSequence: true,
          minSequenceScore: 80,
          narratorProfile: sceneTrack.narratorProfile,
          styleBase: sceneTrack.styleBase,
          fastMode: true,
          // M2 — segundo par de ojos con Claude Haiku 4.5. Solo se invoca si
          // ANTHROPIC_API_KEY está configurada (sino, no-op silencioso).
          // Costo extra: ~$0.001-0.003 por imagen validada, ~+2-4s por imagen.
          useClaudeJudge: true,
          claudeJudgeOptions: {
            model: 'claude-haiku-4-5',
            thresholds: {
              minScoreVisual: 80,
              minScoreBrandFit: 75,
              minScoreHookStrength: 70,
              failOnAnyCritical: true,
            },
          },
          brandContext: {
            brandId: brand.id,
            // styleSummary derivado del preset: la combinación más descriptiva
            // que tenemos para el judge (ej. "B-ROLL Animado · Comic / Acuarela Sepia").
            styleSummary: [preset.format?.displayName, preset.style?.displayName]
              .filter(Boolean)
              .join(' · ') || undefined,
            language: brand.language?.split('-')[0] ?? 'es',
            // TODO M3: productName requiere que runPipeline reciba productId
            // explícito (hoy no lo recibe — se almacena en DB pero no se propaga).
          },
          // Script completo (resumen) para que el judge detecte coherencia narrativa global
          scriptFullSummary: parsedScript.segments
            .map((s) => s.text)
            .join(' ')
            .slice(0, 2000),
          // v2 (27-may-2026): callback del loop scene-level → patch del preset.
          // Trackea los patches sugeridos por el judge. Cuando 2+ scenes del
          // mismo run reportan el mismo patch (normalizado), lo registramos
          // como propuesta pendiente en prompt-patches/proposals.jsonl para review.
          // Esto implementa el flujo exacto que pidió el owner: generar → validar →
          // si problema sistémico → corrección permanente al preset.
          onSystemicPatchSuggested: scenePatchTracker.report,
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
        // v3.2 #135: FORK SKIP en image-gen. Si hay scenes pre-aprobadas (con
        // .png ya copiado del run de origen), las apartamos antes de pasar a
        // image-gen-multi (que sobrescribiría los .png). Después de generar,
        // las volvemos a fusionar con sus imagePath originales.
        const trackForGen =
          preApprovedSceneIndices.size > 0
            ? {
                ...sceneTrack,
                scenes: sceneTrack.scenes.filter(
                  (s) => !preApprovedSceneIndices.has(s.index),
                ),
              }
            : sceneTrack;
        const preservedScenes =
          preApprovedSceneIndices.size > 0
            ? sceneTrack.scenes.filter((s) => preApprovedSceneIndices.has(s.index))
            : [];
        const imgResult = await imageMulti.run(trackForGen, imageMultiCtx);
        if (imgResult.isErr()) throw imgResult.error;
        sceneTrackWithImages =
          preservedScenes.length > 0
            ? {
                ...imgResult.value,
                scenes: [...imgResult.value.scenes, ...preservedScenes].sort(
                  (a, b) => a.index - b.index,
                ),
              }
            : imgResult.value;
        if (preservedScenes.length > 0) {
          logger.info(
            {
              runId,
              preservedFromFork: preservedScenes.map((s) => s.index),
              regeneratedCount: imgResult.value.scenes.length,
            },
            'pipeline:fork_scenes_preserved_through_image_gen',
          );
        }
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
      // v3.2 #142 (29-may-2026): Ken Burns para estilos ILUSTRADOS.
      // El image-to-video (Kling/Veo) se DESVÍA de la imagen base en estilos
      // acuarela/sepia/comic — re-encuadra (cuerpo completo → close-up),
      // pierde el concepto, y el clip NO coincide con la estática aprobada.
      // (Bug reportado por el owner múltiples veces.) Para estos estilos
      // usamos la estática aprobada con movimiento Ken Burns cinematográfico
      // (zoom + paneo + parallax, lo hace el compositor): FIEL 100% a lo que
      // el owner aprobó + ahorra la llamada cara a Kling. Para UGC/fotorealista
      // SÍ usamos AI video (Higgsfield drift es menor + Ken Burns sobre foto
      // se ve peor). Heurística sobre el styleBase, igual que el scene-planner.
      //
      // IMPORTANTE: NO salteamos el animator completo (ahí vive la pausa
      // colaborativa + el VALIDATOR). Pasamos skipVideoGen=true para que el
      // animator corra (validando la ESTÁTICA, que es lo que va al video) y
      // pause scene-por-scene, pero sin llamar a Kling/Veo.
      const styleBaseLowerForAnim = (sceneTrackWithImages.styleBase ?? '').toLowerCase();
      const isIllustratedStyle =
        /hand[- ]?illustrated|hand[- ]?drawn|watercolor|acuarela|sepia|comic|cartoon|painted by hand|digital painting|pixar|ghibli|ilustrad|painterly/.test(
          styleBaseLowerForAnim,
        );
      if (isIllustratedStyle) {
        logger.info(
          { runId, styleBasePreview: styleBaseLowerForAnim.slice(0, 80) },
          'pipeline:illustrated_style_using_ken_burns_not_ai_video',
        );
      }
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
            const higgsfieldKeyId = process.env['HIGGSFIELD_KEY_ID'];
            const higgsfieldKeySecret = process.env['HIGGSFIELD_KEY_SECRET'];

            // 25-may-2026 (decisión owner): routing por preset
            //   - UGC / personas reales → Higgsfield Soul (realismo facial superior)
            //   - Animados / B-ROLL Pixar/acuarela/comic → Kling
            //   - Veo siempre como last-resort fallback
            const formatId = preset.format?.id ?? '';
            const styleId = preset.style?.id ?? '';
            const preferHiggsfield =
              formatId.startsWith('ugc-') ||
              /realista|fotorealista|real|ugc/i.test(styleId);

            logger.info(
              { runId, formatId, styleId, preferHiggsfield },
              'pipeline:scene_animator_routing_decision',
            );

            const animated = await animateScenes({
              sceneTrack: sceneTrackWithImages,
              // v3.2 #135: scenes pre-aprobadas (fork) — animator las saltea
              preApprovedSceneIndices,
              // v3.2 #143 (29-may-2026): REVERTIDO el forzado de Ken Burns.
              // El owner quiere ANIMACIÓN REAL (Kling), no imágenes con zoom.
              // Ken Burns queda SOLO como opt-in vía env KEN_BURNS_ONLY=1.
              // El drift de Kling lo arreglamos afinando el motion prompt
              // (bloqueo de encuadre) + cfgScale, no abandonando la animación.
              skipVideoGen: process.env['KEN_BURNS_ONLY'] === '1',
              workDir,
              veoApiKey,
              // Kling para B-ROLL animado (primary cuando preferHiggsfield=false)
              klingAccessKey,
              klingSecretKey,
              klingModel: 'kling-v2-6',
              klingMode: 'std',
              klingDuration: '5',
              // Higgsfield para UGC/realistas (primary cuando preferHiggsfield=true)
              higgsfieldKeyId,
              higgsfieldKeySecret,
              higgsfieldModel: 'dop-turbo',
              preferHiggsfield,
              // v3.2 #116: en modo collaborative concurrency=1 (sequential)
              // para que el owner revise scene por scene en orden.
              // v3.2 #141 (29-may-2026): en auto mode BAJAMOS de 5→2 cuando el
              // VALIDATOR está activo. Root cause de los crashes del dev server:
              // 5 scenes animando + 5 llamadas VALIDATOR simultáneas (cada una
              // con extended thinking + 10 frames base64 + prev images) revienta
              // el heap de Node y el SO mata el proceso sin log limpio. Con
              // concurrency=2 el pico de memoria baja ~60%. Trade-off: ~2x más
              // lento en auto, pero NO se cae. Si no hay VALIDATOR, mantenemos 5.
              concurrency:
                overrides.mode === 'collaborative'
                  ? 1
                  : process.env['ANTHROPIC_API_KEY'] &&
                      !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')
                    ? 2
                    : klingAccessKey && klingSecretKey
                      ? 5
                      : 4,
              mode: overrides.mode,
              model: 'veo-3.1-lite-generate-preview',
              durationSeconds: 8,
              logger,
              // ─────────────────────────────────────────────────────────
              // VALIDATOR CHAT IA — gate post-clip antes de incrustar
              // ─────────────────────────────────────────────────────────
              // Después de animar cada escena, VALIDATOR CHAT IA (Claude
              // Sonnet 4-5) extrae 3 keyframes del clip, los compara entre sí
              // + revisa la imagen estática, y decide right/wrong. Si wrong,
              // re-anima con motion corregido o pide regenerar imagen.
              validator: process.env['ANTHROPIC_API_KEY'] &&
                !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')
                ? {
                    enabled: true,
                    runId,
                    // v3.1 (28-may-2026): subido 2→3 después de ver 3 scenes
                    // del rip e2e quedar WRONG después de 1 retry. Con 3 attempts
                    // tienen otra oportunidad de converger antes de escalar.
                    maxAttempts: 3,
                    totalScenes: sceneTrackWithImages.scenes.length,
                    brandContext: (() => {
                      // Derivar usage form del producto si existe
                      let productUsageForm: string | undefined;
                      let productName: string | undefined;
                      let productDescription: string | undefined;
                      if (overrides.productId) {
                        const product = brand.products.find(
                          (p) => p.id === overrides.productId,
                        );
                        if (product) {
                          productName = product.name;
                          productDescription = product.description;
                          const desc = product.description ?? '';
                          if (/sublingual|bajo la lengua|gotero|gotas/i.test(desc))
                            productUsageForm = 'sublingual';
                          else if (/crema|t[oó]pico|aplicar/i.test(desc))
                            productUsageForm = 'topical';
                          else if (/spray|inhal/i.test(desc))
                            productUsageForm = 'spray';
                          else if (/pastilla|c[aá]psula|tableta|p[ií]ldora/i.test(desc))
                            productUsageForm = 'oral';
                        }
                      }
                      return {
                        brandId: brand.id,
                        productName,
                        productDescription,
                        productUsageForm,
                        styleSummary:
                          [preset.format?.displayName, preset.style?.displayName]
                            .filter(Boolean)
                            .join(' · ') || undefined,
                        // v3.2 #103: pasamos el styleBoilerplate del preset para
                        // que VALIDATOR verifique adherencia explícita al estilo.
                        styleBoilerplate:
                          preset.visualStyle?.styleBoilerplate ??
                          preset.visualStyle?.promptTemplate?.slice(0, 800),
                        // v3.2 #111: presetId para que VALIDATOR pueda buscar
                        // comments cross-run en el mismo brand+preset.
                        presetId,
                        language: brand.language?.split('-')[0] ?? 'es',
                      };
                    })(),
                    scriptFullSummary: parsedScript.segments
                      .map((s) => s.text)
                      .join(' ')
                      .slice(0, 2000),
                    // v2: cuando VALIDATOR (Sonnet, MÁS preciso que Haiku-judge)
                    // detecta un systemicAntiPattern, lo enviamos al MISMO
                    // scenePatchTracker que usa el preview-judge. Sonnet tiene
                    // confidence más alta — sus patterns son mejor señal para
                    // el cerebro evolutivo cross-run.
                    onAntiPatternDetected: (info) => {
                      logger.info(
                        {
                          sceneIndex: info.sceneIndex,
                          category: info.category,
                          severity: info.severity,
                          patternPreview: info.pattern.slice(0, 100),
                          entity: 'VALIDATOR CHAT IA',
                        },
                        'pipeline:validator_chat_ia_anti_pattern_reported_to_tracker',
                      );
                      scenePatchTracker.report({
                        patch: info.pattern,
                        sceneIndex: info.sceneIndex,
                        severity: info.severity,
                        category: info.category,
                        description: info.description,
                      });
                    },
                    // Closure que regenera la imagen cuando VALIDATOR pide.
                    // Reusa regenerateSingleScene con el providerChain ya armado.
                    onRegenerateImage: async ({ scene, correctedImagePrompt, attempt }) => {
                      // v3.2: fortificar el prompt con los anti-patterns del run
                      // ANTES de mandarlo al provider. Esto cierra el loop: el
                      // provider AHORA sabe qué evitar, no solo VALIDATOR.
                      const fortifiedPrompt = await fortifyPromptWithAntiPatterns(
                        correctedImagePrompt,
                        runId,
                      );
                      const antiPatternsApplied = fortifiedPrompt.length > correctedImagePrompt.length;
                      logger.info(
                        {
                          sceneIndex: scene.index,
                          attempt,
                          entity: 'VALIDATOR CHAT IA',
                          promptPreview: correctedImagePrompt.slice(0, 120),
                          antiPatternsAppended: antiPatternsApplied,
                          fortifiedExtraChars: fortifiedPrompt.length - correctedImagePrompt.length,
                        },
                        'pipeline:validator_chat_ia_triggering_image_regen',
                      );
                      const result = await regenerateSingleScene({
                        scene,
                        newPrompt: fortifiedPrompt,
                        workDir,
                        providerChain,
                        reAnimate: false, // la re-animación la maneja el animator
                      });
                      return {
                        updatedScene: result.updatedScene,
                        newStaticImagePath: result.imagePath,
                      };
                    },
                    model: 'claude-sonnet-4-5',
                  }
                : undefined,
              onSceneValidated: (info) => {
                logger.info(
                  {
                    sceneIndex: info.sceneIndex,
                    passed: info.passed,
                    attempts: info.attempts,
                    historyCount: info.historyEntries.length,
                    entity: 'VALIDATOR CHAT IA',
                  },
                  'pipeline:scene_validated_by_validator_chat_ia',
                );
              },
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

            // ─────────────────────────────────────────────────────────
            // VALIDATOR CHAT IA — HOLISTIC SEQUENCE REVIEW
            // ─────────────────────────────────────────────────────────
            // Después de que cada escena pasó por el validator individual,
            // VALIDATOR mira el VIDEO ENTERO como secuencia (contact sheet)
            // y detecta lo que un juez per-scene no puede ver: character
            // drift, palette inconsistencies, pacing monotone, hook débil,
            // CTA débil. Persiste el verdict para que la UI lo muestre.
            if (
              process.env['ANTHROPIC_API_KEY'] &&
              !process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')
            ) {
              try {
                const holisticT0 = Date.now();
                const holistic = await runHolisticReview({
                  runId,
                  sceneTrack: sceneTrackWithImages,
                  brandContext: (() => {
                    let productUsageForm: string | undefined;
                    let productName: string | undefined;
                    let productDescription: string | undefined;
                    if (overrides.productId) {
                      const product = brand.products.find(
                        (p) => p.id === overrides.productId,
                      );
                      if (product) {
                        productName = product.name;
                        productDescription = product.description;
                        const desc = product.description ?? '';
                        if (/sublingual|bajo la lengua|gotero|gotas/i.test(desc))
                          productUsageForm = 'sublingual';
                        else if (/crema|t[oó]pico|aplicar/i.test(desc))
                          productUsageForm = 'topical';
                      }
                    }
                    return {
                      brandId: brand.id,
                      productName,
                      productDescription,
                      productUsageForm,
                      styleSummary:
                        [preset.format?.displayName, preset.style?.displayName]
                          .filter(Boolean)
                          .join(' · ') || undefined,
                      language: brand.language?.split('-')[0] ?? 'es',
                    };
                  })(),
                  scriptFullSummary: parsedScript.segments
                    .map((s) => s.text)
                    .join(' ')
                    .slice(0, 2000),
                  logger,
                });
                if (holistic.verdict) {
                  logger.info(
                    {
                      runId,
                      globalVerdict: holistic.verdict.globalVerdict,
                      regenerateRecCount:
                        holistic.verdict.recommendedRegenerateIndices.length,
                      elapsedMs: Date.now() - holisticT0,
                      entity: 'VALIDATOR CHAT IA',
                    },
                    'pipeline:validator_chat_ia_holistic_done',
                  );

                  // v3.2 #98: AUTO-LOOP post-holistic — si holistic recomienda
                  // regenerar scenes, lo hacemos en este momento. Cada scene se
                  // regenera con la fix del holistic appended + anti-patterns
                  // fortificados. No re-validamos individualmente acá (eso
                  // duplicaría tiempo). El compositor leerá el sceneTrackWithImages
                  // actualizado.
                  const recommended = holistic.verdict.recommendedRegenerateIndices;
                  const MAX_AUTO_REGEN = 5; // límite defensivo para no explotar latencia
                  // v3.3 (fix-consent): NUNCA auto-regenerar escenas pre-aprobadas por
                  // el owner (fork). Son inmutables — las excluimos antes de regenerar.
                  const toRegenerate = recommended
                    .filter((i) => !preApprovedSceneIndices.has(i))
                    .slice(0, MAX_AUTO_REGEN);
                  if (toRegenerate.length > 0) {
                    logger.info(
                      {
                        runId,
                        sceneIndices: toRegenerate,
                        entity: 'VALIDATOR CHAT IA',
                      },
                      'pipeline:auto_loop_post_holistic_triggering',
                    );
                    for (const sceneIdx of toRegenerate) {
                      const sceneToFix = sceneTrackWithImages.scenes.find(
                        (s) => s.index === sceneIdx,
                      );
                      if (!sceneToFix) continue;
                      // Construir hint del holistic para esta scene específica
                      const relevantIssue = holistic.verdict.issues.find(
                        (i) => i.affectedSceneIndices.includes(sceneIdx),
                      );
                      const holisticHint = relevantIssue
                        ? `\n\nHOLISTIC REVIEW FEEDBACK — correct this systemic issue: [${relevantIssue.severity}/${relevantIssue.category}] ${relevantIssue.description}${relevantIssue.fix ? '. Fix recommendation: ' + relevantIssue.fix : ''}.`
                        : '\n\nHOLISTIC REVIEW — this scene was flagged for regeneration to improve sequence coherence.';
                      const newPrompt = sceneToFix.imagePrompt + holisticHint;
                      // Fortificar con anti-patterns del run
                      const fortifiedPrompt = await fortifyPromptWithAntiPatterns(
                        newPrompt,
                        runId,
                      );
                      try {
                        const r = await regenerateSingleScene({
                          scene: sceneToFix,
                          newPrompt: fortifiedPrompt,
                          workDir,
                          providerChain,
                          reAnimate: false, // re-animar fuera del loop por costo
                        });
                        // Reemplazar scene en sceneTrackWithImages
                        sceneTrackWithImages = {
                          ...sceneTrackWithImages,
                          scenes: sceneTrackWithImages.scenes.map((s) =>
                            // v3.3 fix: al regenerar la imagen sin re-animar, limpiamos
                            // videoPath para que el compositor use la imagen NUEVA (Ken
                            // Burns) en vez del clip viejo que ya no corresponde.
                            s.index === sceneIdx ? { ...r.updatedScene, videoPath: undefined } : s,
                          ),
                        };
                        logger.info(
                          {
                            runId,
                            sceneIndex: sceneIdx,
                            providerUsed: r.providerUsed,
                            entity: 'VALIDATOR CHAT IA',
                          },
                          'pipeline:auto_loop_post_holistic_scene_regenerated',
                        );
                      } catch (e) {
                        logger.warn(
                          {
                            runId,
                            sceneIndex: sceneIdx,
                            err: (e as Error).message,
                            entity: 'VALIDATOR CHAT IA',
                          },
                          'pipeline:auto_loop_post_holistic_scene_regen_failed',
                        );
                      }
                    }
                  }
                } else {
                  logger.warn(
                    { runId, err: holistic.error?.message },
                    'pipeline:validator_chat_ia_holistic_failed',
                  );
                  // v3.3 fix: el fallo del holistic NO debe quedar invisible — el owner
                  // debe saber que la revisión global del video no corrió.
                  if (!editorAdvisoryMessage) {
                    editorAdvisoryMessage = `La revisión holística (video completo) no se pudo completar: ${holistic.error?.message ?? 'error desconocido'}. El video se entrega, pero sin ese chequeo final.`;
                  }
                }
              } catch (e) {
                logger.warn(
                  { runId, err: (e as Error).message },
                  'pipeline:validator_chat_ia_holistic_threw',
                );
              }
            }
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
            // v3.3 fix: que el owner sepa que la animación falló (el video sale con
            // imágenes estáticas en vez de clips animados).
            if (!editorAdvisoryMessage) {
              editorAdvisoryMessage = `La animación de escenas falló (${(e as Error).message.slice(0, 150)}). El video se entrega con imágenes estáticas + Ken Burns en vez de clips animados.`;
            }
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

      // v3.2 #104: generar run-report.md autogenerado del trabajo de VALIDATOR.
      // Owner-readable summary: stats, per-scene table con scores cuantificados,
      // anti-patterns, recomendaciones para futuros runs. Se genera ahora porque
      // el scene-animator + validator ya completaron.
      try {
        const reportPath = await generateRunReport(runId);
        if (reportPath) {
          logger.info(
            { runId, reportPath, entity: 'VALIDATOR CHAT IA' },
            'pipeline:validator_chat_ia_run_report_generated',
          );
        }
      } catch (reportErr) {
        logger.warn(
          { runId, err: (reportErr as Error).message, entity: 'VALIDATOR CHAT IA' },
          'pipeline:validator_chat_ia_run_report_failed',
        );
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

      // ============================================================
      // M5 — POST-RENDER JUDGE (IA validator del video terminado)
      // ============================================================
      // Después del compositor, validamos con Claude:
      //   - Coverage: cada scene tiene visual (imagePath/videoPath existe)
      //   - Duration: audio vs scene plan vs video final coherentes
      //   - Visual quality sample: re-juzgamos 3 scenes (primera/medio/última)
      //   - Subtítulos: text quality (sin gibberish, idioma OK, ortografía)
      //
      // Persistido a {workDir}/post-render-report.json para visibilidad.
      // NUNCA bloquea el completed status — best-effort observability.
      try {
        const subtitleSegments = subtitleTrack?.lines?.map(
          (l: { text: string; startTimeSeconds: number; endTimeSeconds: number }) => ({
            text: l.text,
            startSec: l.startTimeSeconds,
            endSec: l.endTimeSeconds,
          }),
        );
        // Helper: re-genera el report técnico desde el scene-track actual
        const buildReport = async (): Promise<FinalRenderReport | null> => {
          const r = await judgeFinalRender({
            runId,
            workDir,
            scenes: sceneTrackWithImages.scenes.map((s) => ({
              index: s.index,
              text: s.text,
              startTimeSeconds: s.startTimeSeconds,
              endTimeSeconds: s.endTimeSeconds,
              imagePath: s.imagePath ?? undefined,
              videoPath: s.videoPath ?? undefined,
              imagePrompt: s.imagePrompt,
            })),
            audioPath: audioTrack.filePath,
            finalVideoPath: outputPath,
            subtitleSegments,
            brandContext: {
              brandId: brand.id,
              styleSummary: [preset.format?.displayName, preset.style?.displayName]
                .filter(Boolean)
                .join(' · ') || undefined,
              // 25-may-2026 (owner feedback): pasar info del producto para que el
              // editor IA detecte mismatches semánticos visual-producto (ej. "solo
              // unas gotas" + visual mostrando echando en la mano para un producto
              // sublingual → CRITICAL bug semántico).
              productName: overrides.productId
                ? brand.products.find((p) => p.id === overrides.productId)?.name
                : undefined,
              productDescription: overrides.productId
                ? brand.products.find((p) => p.id === overrides.productId)?.description
                : undefined,
            },
          });
          return r.isOk() ? r.value : null;
        };
        // Helper: re-renderiza el video con el scene-track actual (sin re-generar
        // imágenes/animaciones — solo el compositor Remotion ~2-3 min).
        const rerenderCompositor = async (): Promise<void> => {
          const newJob: RenderJob = { ...renderJob, sceneTrack: sceneTrackWithImages };
          const r = await compositorRemotion.run(newJob, compCtx);
          if (r.isErr()) throw r.error;
        };

        const initialReport = await buildReport();
        if (initialReport) {
          await writeFile(
            resolve(workDir, 'post-render-report.json'),
            JSON.stringify(initialReport, null, 2),
            'utf-8',
          );

          // M6 v1 (25-may-2026): loop conversacional iterativo. Editor IA emite
          // ACCIONES ejecutables. El pipeline las ejecuta (extend/trim duration
          // → modificar scene.endTimeSeconds + re-render compositor) y re-someter
          // el video. Max 3 iteraciones hasta approve o manual-fix.
          const executor = {
            async executeAction(action: EditorAction): Promise<FinalRenderReport> {
              logger.info({ runId, action }, 'pipeline:editor_action_executing');
              // v3.3 (fix-consent): el Editor IA NUNCA debe mutar/regenerar una escena
              // que el owner ya aprobó (pre-aprobada vía fork). Son inmutables.
              const targetIdx = (action as { sceneIndex?: number }).sceneIndex;
              if (targetIdx != null && preApprovedSceneIndices.has(targetIdx)) {
                logger.warn(
                  { runId, sceneIndex: targetIdx },
                  'pipeline:editor_skip_preapproved_scene',
                );
                return (await buildReport()) ?? initialReport;
              }
              if (
                action.type === 'extend-duration' ||
                action.type === 'trim-duration'
              ) {
                const scene = sceneTrackWithImages.scenes.find((s) => s.index === action.sceneIndex);
                if (scene) {
                  scene.endTimeSeconds = action.newEndTimeSeconds;
                  sceneTrackWithImages.totalDurationSeconds = Math.max(
                    sceneTrackWithImages.totalDurationSeconds,
                    action.newEndTimeSeconds,
                  );
                  await rerenderCompositor();
                }
              } else if (action.type === 'adjust-prompt') {
                const scene = sceneTrackWithImages.scenes.find((s) => s.index === action.sceneIndex);
                if (scene) {
                  scene.imagePrompt = action.newImagePrompt;
                  // No re-genera imagen — guarda el prompt para futuras runs.
                  // El video actual sigue con la imagen existente.
                }
              } else if (action.type === 'regenerate-scene') {
                // M6 v2 (25-may-2026): executor REAL para regenerate-scene.
                // Llama a regenerateSingleScene que reusa el providerChain del
                // image-gen-multi para re-generar SOLO la escena pedida (sin
                // re-rendear el resto). Si la scene era animada, NO re-animamos
                // automáticamente — el editor verá la nueva imagen y decidirá.
                const scene = sceneTrackWithImages.scenes.find((s) => s.index === action.sceneIndex);
                if (scene) {
                  try {
                    const regen = await regenerateSingleScene({
                      scene,
                      newPrompt: action.newImagePrompt,
                      workDir,
                      providerChain,
                      reAnimate: false, // animator complejo de pasar acá — TODO
                    });
                    // Actualizar el scene-track por scene.index (no por posición).
                    // v3.3 fix: limpiar videoPath — la imagen cambió y NO re-animamos,
                    // así el compositor usa la imagen nueva en vez del clip viejo.
                    sceneTrackWithImages = {
                      ...sceneTrackWithImages,
                      scenes: sceneTrackWithImages.scenes.map((s) =>
                        s.index === action.sceneIndex
                          ? { ...regen.updatedScene, videoPath: undefined }
                          : s,
                      ),
                    };
                    logger.info(
                      {
                        runId,
                        sceneIndex: action.sceneIndex,
                        providerUsed: regen.providerUsed,
                        elapsedSec: regen.elapsedSec,
                        errors: regen.errors,
                      },
                      'pipeline:editor_regenerate_scene_done',
                    );
                    // Re-render compositor con la nueva imagen
                    await rerenderCompositor();
                  } catch (e) {
                    logger.warn(
                      {
                        runId,
                        sceneIndex: action.sceneIndex,
                        err: (e as Error).message,
                      },
                      'pipeline:editor_regenerate_scene_failed',
                    );
                    // No throw — devolvemos report sin cambios y el editor verá
                    // que el problema persiste → escalará a manual-fix en iter 3.
                  }
                }
              }
              const updated = await buildReport();
              return updated ?? initialReport;
            },
          };

          // M9: inyectar contexto del proyecto al editor IA
          let projectContext: string | undefined;
          try {
            projectContext = await getSystemContextForPrompt();
          } catch (e) {
            logger.warn({ err: (e as Error).message }, 'pipeline:system_context_fetch_failed');
          }
          const loopResult = await runEditorLoop(initialReport, executor, {
            projectContext,
          });
          if (loopResult.isOk()) {
            const r = loopResult.value;
            // Persistir conversación completa para auditoría
            const convoMd = [
              `# Editor IA — Conversación iterativa`,
              `# Run: ${runId}`,
              ``,
              `**Aprobado:** ${r.approved ? '✅ SÍ' : '❌ NO'}`,
              `**Iteraciones:** ${r.iterations} / 3`,
              `**Manual fix requerido:** ${r.manualFixRequired ? 'sí' : 'no'}`,
              `**Loop exhausted:** ${r.exhausted ? 'sí' : 'no'}`,
              ``,
              ...r.conversation.flatMap((turn) => [
                `## Iteración ${turn.iteration}`,
                ``,
                `**Severity:** ${turn.verdict.severity}`,
                ``,
                `**Veredicto:** ${turn.verdict.verdict}`,
                ``,
                '**Acción:** ```json',
                JSON.stringify(turn.verdict.actions[0], null, 2),
                '```',
                ``,
              ]),
            ].join('\n');
            await writeFile(
              resolve(workDir, 'editor-conversation.md'),
              convoMd,
              'utf-8',
            );

            if (r.approved) {
              logger.info(
                {
                  runId,
                  iterations: r.iterations,
                  finalSeverity: r.finalVerdict?.severity,
                  finalVerdict: r.finalVerdict?.verdict.slice(0, 200),
                },
                'pipeline:editor_loop_APPROVED',
              );
            } else {
              // v3.2 #105 (28-may-2026): ESCAPE HATCH GRACEFUL.
              // Antes: throw Error → outer catch marca status='failed' →
              // owner queda sin video aunque final.mp4 ya existe en disco.
              // Ahora: persistir advisory + setear flag para que el closing
              // updateRun use status='completed-with-warnings'. Owner recibe
              // el video Y las instrucciones manual-fix. Mejor que el peor
              // caso posible (no entregar nada).
              const finalVerdict = r.finalVerdict?.verdict ?? 'Sin veredicto';
              const finalActions =
                r.finalVerdict?.actions
                  .map((a) =>
                    a.type === 'manual-fix'
                      ? `manual-fix: ${a.humanSteps.join('; ')}`
                      : a.type,
                  )
                  .join(' | ') ?? '';
              const advisoryMessage =
                `Editor IA marcó el video con advisories (${r.iterations}/3 iter${r.exhausted ? ', exhausted' : ''}). ` +
                `Final verdict: ${finalVerdict}. ` +
                `Acciones recomendadas: ${finalActions}. ` +
                `El video se entrega tal cual — revisá las advisories y decidí si re-lanzar con prompts corregidos.`;
              logger.warn(
                {
                  runId,
                  iterations: r.iterations,
                  exhausted: r.exhausted,
                  manualFixRequired: r.manualFixRequired,
                  finalSeverity: r.finalVerdict?.severity,
                  verdict: finalVerdict,
                  actions: finalActions,
                  escapeHatch: true,
                },
                'pipeline:editor_loop_advisory_entregando_video_con_warnings',
              );
              editorAdvisoryMessage = advisoryMessage;
              // Persistir advisory en archivo para que la UI lo encuentre
              try {
                await writeFile(
                  resolve(workDir, 'editor-advisory.md'),
                  `# Editor IA Advisory\n\n_Run:_ \`${runId}\`\n_Iteraciones:_ ${r.iterations}/3${r.exhausted ? ' (exhausted)' : ''}\n_Severity:_ ${r.finalVerdict?.severity ?? 'unknown'}\n\n## Verdict final\n\n${finalVerdict}\n\n## Acciones recomendadas\n\n${finalActions}\n\n## Recomendación\n\nEl video se entregó tal cual. Si las advisories son aceptables, puedes usarlo. Si no, relanza un nuevo run con prompts corregidos o escala a un preset diferente.\n`,
                  'utf-8',
                );
              } catch {
                /* best-effort */
              }
              // NO throw — dejamos que el pipeline continúe al closing exitoso
            }
          } else {
            logger.warn(
              { runId, err: loopResult.error },
              'pipeline:editor_loop_error',
            );
            // v3.3 fix: el fallo del editor loop NO debe quedar invisible.
            if (!editorAdvisoryMessage) {
              editorAdvisoryMessage =
                'El Editor IA no pudo completar su revisión post-render. El video se entrega tal cual, sin ese chequeo final.';
            }
          }
        } else {
          logger.warn({ runId }, 'pipeline:initial_report_null');
        }
      } catch (e) {
        // v3.2 #105: ya NO re-throw. El escape hatch handler dentro del
        // bloque guarda el advisory en editorAdvisoryMessage. Si por alguna
        // razón el editor tira otro error (no esperado), lo loggeamos como
        // warning y seguimos — no bloquea la entrega del video.
        logger.warn(
          { runId, err: (e as Error).message, editorErrorButContinuing: true },
          'pipeline:editor_loop_threw_continuing_with_advisory',
        );
        if (!editorAdvisoryMessage) {
          editorAdvisoryMessage = `Editor IA falló con excepción (${(e as Error).message.slice(0, 200)}). El video se entrega tal cual.`;
        }
      }
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
    // v3.2 #105: si el editor IA emitió advisory, usamos status nuevo en lugar
    // de 'completed' simple. El video SÍ se entrega, pero el owner sabe que
    // hay advisories que revisar.
    const finalStatus: 'completed' | 'completed-with-warnings' = editorAdvisoryMessage
      ? 'completed-with-warnings'
      : 'completed';
    await updateRun(runId, {
      status: finalStatus,
      currentStep: null,
      progress: 100,
      outputPath,
      durationSeconds: audioTrack.durationSeconds,
      estimatedCostUsd: costSummary.totalUsd,
      imageCount: costSummary.imageCount,
      ttsCharsBilled: costSummary.ttsChars,
      // Persistir el advisory en errorMessage (sin perderlo). El owner lo verá.
      ...(editorAdvisoryMessage ? { errorMessage: editorAdvisoryMessage } : {}),
      completedAt: new Date(),
    });

    logger.info(
      { runId, outputPath, multiEscena: usesMultiEscena, costUsd: costSummary.totalUsd.toFixed(3) },
      'pipeline:completed',
    );

    // M9: auto-log al system-log para que el chat IA tenga contexto histórico
    void logSystemEvent({
      kind: 'run-completed',
      data: {
        runId,
        brandId,
        presetId,
        costUsd: Number(costSummary.totalUsd.toFixed(3)),
        imageCount: costSummary.imageCount,
        durationSeconds: audioTrack.durationSeconds,
      },
      summary: `Run ${runId.slice(0, 8)} completed · brand=${brandId} preset=${presetId} cost=$${costSummary.totalUsd.toFixed(2)}`,
    });

    // v3.2 #113: cerebro evolutivo — convertir owner comments cross-run en
    // preset patches propuestos. Si N+ comments en runs distintos hablan de la
    // misma categoría, persistir como propuesta pending en /admin. NO se aplica
    // automáticamente — owner aprueba/rechaza.
    try {
      const candidates = await proposePatchesFromOwnerComments(brandId, presetId);
      if (candidates.length > 0) {
        logger.info(
          {
            runId,
            candidatesCount: candidates.length,
            categories: candidates.map((c) => c.category),
            entity: 'VALIDATOR CHAT IA',
          },
          'pipeline:owner_comments_propose_patches',
        );
        for (const c of candidates) {
          try {
            await recordProposedPatch({
              pattern: {
                patternId: `owner-comments_${brandId}_${presetId.slice(0, 20)}_${c.category}_${Date.now().toString(36)}`,
                category: 'visual-quality-low', // genérico
                affectedBlock: 'scene-planner',
                occurrenceCount: c.occurrenceCount,
                affectedRunIds: c.runIds.slice(0, 10),
                description: `Owner repeatedly flagged ${c.category} issues in runs of ${brandId}/${presetId} (${c.occurrenceCount} comments across ${c.runIds.length} distinct runs). Representative comments: ${c.representativeComments.map((rc) => `"${rc.slice(0, 100)}"`).join('; ')}`,
                severityScore: Math.min(5, c.occurrenceCount * 0.5),
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
              },
              targetFilePath: 'packages/blocks/scene-planner/src/block.ts',
              targetPromptVarName: 'systemInstruction',
              patchType: 'addition',
              oldText: null,
              newText: '\n\n' + c.proposedNegativeInstruction,
              reasoning: `Owner intervened ${c.occurrenceCount} times across ${c.runIds.length} runs flagging ${c.category}. Synthesized from comments: ${c.representativeComments.join(' | ').slice(0, 300)}`,
              expectedImprovement: `Reduce ${c.category} issues in future runs of ${presetId}`,
              confidence: c.confidence,
              proposedByModel: 'owner-feedback-aggregator',
            });
          } catch (e) {
            logger.warn(
              { runId, category: c.category, err: (e as Error).message },
              'pipeline:owner_comment_patch_persist_failed',
            );
          }
        }
      }
    } catch (e) {
      logger.warn(
        { runId, err: (e as Error).message },
        'pipeline:owner_comments_propose_failed',
      );
    }

    // Feedback loop (M7 #3, 25-may-2026): registrar juicio 'run-success' por
    // este preset. Weight 1.0 — uso exitoso real. Si la run fue un rip
    // (referenceVideoPath), también registramos 'used-for-rip' para tracking de
    // adopción. Best-effort.
    try {
      const { recordPresetJudgment } = await import('@video-factory/core');
      void recordPresetJudgment({
        presetId,
        kind: 'run-success',
        weight: 1.0,
        context: {
          runId,
          brandId,
          costUsd: Number(costSummary.totalUsd.toFixed(3)),
          imageCount: costSummary.imageCount,
          durationSeconds: audioTrack.durationSeconds,
        },
      });
      if (overrides.referenceVideoPath) {
        void recordPresetJudgment({
          presetId,
          kind: 'used-for-rip',
          weight: 1.0,
          context: { runId, brandId },
        });
      }
    } catch {
      // best-effort
    }

    // AUTO-LEARN POST-RIP (M7-B v3, 25-may-2026):
    // Si este run fue un rip de alta fidelidad (tiene referenceVideoPath), al
    // terminar disparamos en background el loop iterativo de aprendizaje de
    // preset hasta lograr 95% similitud. El preset queda persistido en
    // packages/presets/pending/ listo para reutilizar en /create con futuros
    // videos del mismo estilo. Fire-and-forget — NO bloquea la respuesta al run.
    if (overrides.referenceVideoPath) {
      const refVideoPath = overrides.referenceVideoPath;
      void (async () => {
        try {
          const { runPresetLearningLoop } = await import('./preset-learning-loop');
          logger.info(
            { runId, refVideoPath },
            'pipeline:auto-learn-loop-started',
          );
          const learnResult = await runPresetLearningLoop({
            videoPath: refVideoPath,
            targetScore: 95, // owner requirement: similitud muy alta
            maxIterations: 4,
            displayNameOverride: `🎯 Auto-learned from rip ${runId.slice(0, 8)}`,
          });
          logger.info(
            {
              runId,
              presetId: learnResult.preset.id,
              approved: learnResult.approved,
              exhausted: learnResult.exhausted,
              finalScore: learnResult.finalScore,
              iterations: learnResult.iterationsRun,
              elapsedSec: learnResult.elapsedSec.toFixed(1),
            },
            'pipeline:auto-learn-loop-completed',
          );
        } catch (learnErr) {
          logger.warn(
            {
              runId,
              err: (learnErr as Error).message.slice(0, 300),
            },
            'pipeline:auto-learn-loop-failed',
          );
        }
      })();
    }

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
    // M9: auto-log fallo del run
    void logSystemEvent({
      kind: 'run-failed',
      data: {
        runId,
        brandId,
        presetId,
        errorMessage: message.slice(0, 500),
      },
      summary: `Run ${runId.slice(0, 8)} FAILED · brand=${brandId} · ${message.slice(0, 100)}`,
    });
    // Feedback loop (M7 #3): registrar 'run-failed' por este preset. Weight 1.0.
    try {
      const { recordPresetJudgment } = await import('@video-factory/core');
      void recordPresetJudgment({
        presetId,
        kind: 'run-failed',
        weight: 1.0,
        context: { runId, brandId, errorMessage: message.slice(0, 300) },
      });
    } catch {
      // best-effort
    }
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
    // v3.2 #123: reportar el error al sistema de auto-fix para que Claude
    // analice y proponga (o aplique) un fix automáticamente.
    try {
      const { reportPipelineError } = await import('./auto-fix');
      await reportPipelineError(error instanceof Error ? error : new Error(message), {
        runId,
        step: 'pipeline-outer',
      });
    } catch {
      /* best-effort, no afecta el flujo */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-TRIM v3.2 (29-may-2026): alineación de escenas a timing real del audio
// ─────────────────────────────────────────────────────────────────────────────
//
// PROBLEMA: scene-planner divide la duración total proporcional al CHAR COUNT
// del texto de cada escena. Pero la velocidad real de habla varía: pausas entre
// frases, énfasis, signos de puntuación. Resultado: una escena puede cortar
// VISUALMENTE antes/después de que el narrador termine de hablar su texto.
//
// El owner lo describió así (29-may-2026):
//   "no quedará como 'muy larga' para lo que se hablará?
//    No se si se puede pedir un recorte automático para que cuando la voz
//    deje de hablar la escena se corte"
//
// SOLUCIÓN: usar audioTrack.segments[] (timings REALES por segmento del script
// devueltos por ElevenLabs/OpenAI) para mapear cada scene.text al segmento que
// lo contiene y derivar scene.endTimeSeconds del endTime real del último
// segmento que esa scene cubre.
//
// El compositor ya respeta scene.endTimeSeconds — el clip animado de 8s (Veo/
// Kling/Higgsfield) se corta automáticamente en scene.endTimeSeconds porque
// PlanoEscenas usa <Series.Sequence durationInFrames=...> que limita el render
// a esa ventana. Asi que solo tenemos que ajustar scene.endTimeSeconds y todo
// lo demás funciona pixel-perfect.
type MinimalSceneTrack = {
  scenes: Array<{ startTimeSeconds: number; endTimeSeconds: number; text: string } & Record<string, unknown>>;
  totalDurationSeconds: number;
  [k: string]: unknown;
};
type MinimalAudioTrack = {
  durationSeconds: number;
  segments: Array<{ text: string; startTimeSeconds: number; endTimeSeconds: number }>;
};
type MinimalParsedScript = {
  segments: Array<{ text: string }>;
};

function alignScenesToAudioTiming<T extends MinimalSceneTrack>(
  sceneTrack: T,
  audioTrack: MinimalAudioTrack,
  parsedScript: MinimalParsedScript,
): { aligned: T; diagnostics: { shiftsSec: number[]; matchedScenes: number; totalScenes: number } } {
  // Si no tenemos segments útiles, devolvemos el track tal cual (defensive).
  if (!audioTrack.segments || audioTrack.segments.length === 0) {
    return {
      aligned: sceneTrack,
      diagnostics: { shiftsSec: [], matchedScenes: 0, totalScenes: sceneTrack.scenes.length },
    };
  }

  // Construir un único "fullScript" concatenando los segments del parsedScript.
  // Acumulamos también las posiciones de char (startChar..endChar) de cada
  // segmento para mapear char→tiempo después.
  const SEP = ' '; // espacio simple entre segments
  type SegRange = { startChar: number; endChar: number; startSec: number; endSec: number };
  const segRanges: SegRange[] = [];
  const scriptParts: string[] = [];
  let cursorChar = 0;
  const segCount = Math.min(audioTrack.segments.length, parsedScript.segments.length);

  for (let i = 0; i < segCount; i++) {
    const partText = parsedScript.segments[i]?.text ?? audioTrack.segments[i]?.text ?? '';
    const audioSeg = audioTrack.segments[i]!;
    const startChar = cursorChar;
    const endChar = startChar + partText.length;
    segRanges.push({
      startChar,
      endChar,
      startSec: audioSeg.startTimeSeconds,
      endSec: audioSeg.endTimeSeconds,
    });
    scriptParts.push(partText);
    cursorChar = endChar + SEP.length;
  }
  const fullScript = scriptParts.join(SEP);
  const totalChars = fullScript.length;

  if (totalChars === 0 || segRanges.length === 0) {
    return {
      aligned: sceneTrack,
      diagnostics: { shiftsSec: [], matchedScenes: 0, totalScenes: sceneTrack.scenes.length },
    };
  }

  // Mapea una posición de char → segundos. Interpola dentro del segRange que
  // contiene esa posición. Si está fuera, extrapola linealmente.
  const charToSec = (charPos: number): number => {
    for (const r of segRanges) {
      if (charPos >= r.startChar && charPos <= r.endChar) {
        const rangeChars = Math.max(1, r.endChar - r.startChar);
        const ratio = (charPos - r.startChar) / rangeChars;
        return r.startSec + (r.endSec - r.startSec) * ratio;
      }
    }
    // Fallback lineal global
    return (charPos / Math.max(1, totalChars)) * audioTrack.durationSeconds;
  };

  // Para cada scene, buscar su text dentro de fullScript usando un cursor que
  // avanza monotonicamente. Si no encuentra match exacto, usa una heurística:
  // tomar las primeras 12 palabras de scene.text y matcherarlas. Si tampoco,
  // mantener la posición proporcional original.
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedScript = normalize(fullScript);

  let searchCursor = 0;
  const matched: Array<{ startChar: number; endChar: number }> = [];
  let matchedCount = 0;

  for (let i = 0; i < sceneTrack.scenes.length; i++) {
    const scene = sceneTrack.scenes[i]!;
    const needle = normalize(scene.text);
    if (needle.length === 0) {
      matched.push({ startChar: searchCursor, endChar: searchCursor });
      continue;
    }
    let foundAt = normalizedScript.indexOf(needle, searchCursor);
    if (foundAt === -1) {
      // Fallback: probar con las primeras 8 palabras (Gemini a veces parafrasea
      // ligeramente el texto entre escenas).
      const firstWords = needle.split(' ').slice(0, 8).join(' ');
      if (firstWords.length >= 6) {
        foundAt = normalizedScript.indexOf(firstWords, searchCursor);
      }
    }
    if (foundAt === -1) {
      // Sin match: usamos la posición proporcional según orden de escenas
      const ratio = i / sceneTrack.scenes.length;
      const proportionalStart = Math.round(ratio * totalChars);
      matched.push({
        startChar: Math.max(searchCursor, proportionalStart),
        endChar: Math.max(searchCursor, proportionalStart) + needle.length,
      });
    } else {
      matched.push({ startChar: foundAt, endChar: foundAt + needle.length });
      searchCursor = foundAt + needle.length;
      matchedCount++;
    }
  }

  // Convertir char→sec y armar las nuevas escenas. Forzamos monotonía:
  // scene[i].startTimeSeconds = scene[i-1].endTimeSeconds.
  const shifts: number[] = [];
  const newScenes = sceneTrack.scenes.map((scene, i) => {
    const m = matched[i]!;
    let startSec = i === 0 ? 0 : -1;
    let endSec = charToSec(m.endChar);
    if (i === 0) {
      startSec = 0;
    }
    // Ajustaremos start después con el cursor monotónico
    const originalEnd = scene.endTimeSeconds;
    shifts.push(Number((endSec - originalEnd).toFixed(2)));
    return { ...scene, startTimeSeconds: startSec, endTimeSeconds: endSec };
  });

  // Fix monotonicidad + no overlap + última scene cubre hasta audioDuration.
  for (let i = 0; i < newScenes.length; i++) {
    const s = newScenes[i]!;
    if (i > 0) {
      s.startTimeSeconds = newScenes[i - 1]!.endTimeSeconds;
    }
    // Cada scene debe durar al menos 0.5s (evita escenas-fantasma de 0.1s
    // por errores de matching). Si quedó muy corta, extendemos.
    const MIN_SCENE_DURATION = 0.5;
    if (s.endTimeSeconds - s.startTimeSeconds < MIN_SCENE_DURATION) {
      s.endTimeSeconds = s.startTimeSeconds + MIN_SCENE_DURATION;
    }
  }

  // Última scene siempre termina exactamente en audio.duration (sin colas mudas).
  const last = newScenes[newScenes.length - 1];
  if (last) {
    last.endTimeSeconds = audioTrack.durationSeconds;
    if (last.endTimeSeconds <= last.startTimeSeconds) {
      // edge case: si el ajuste de monotonicidad empujó startTimeSeconds más
      // allá del audio, retrocedemos para garantizar duración mínima
      last.startTimeSeconds = Math.max(0, audioTrack.durationSeconds - 1);
    }
  }

  // round3 final
  for (const s of newScenes) {
    s.startTimeSeconds = Math.round(s.startTimeSeconds * 1000) / 1000;
    s.endTimeSeconds = Math.round(s.endTimeSeconds * 1000) / 1000;
  }

  const aligned = {
    ...sceneTrack,
    scenes: newScenes,
    totalDurationSeconds: audioTrack.durationSeconds,
  } as T;

  return {
    aligned,
    diagnostics: {
      shiftsSec: shifts,
      matchedScenes: matchedCount,
      totalScenes: sceneTrack.scenes.length,
    },
  };
}
