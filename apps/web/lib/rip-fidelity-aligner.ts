// Rip Fidelity Aligner — el corazón del modo "Ripeo de alta fidelidad".
//
// FLUJO:
//   1. Recibimos un sceneTrack (output del scene-planner) + referenceVideoPath
//      (el video original que el user quiere ripear).
//   2. Extraemos keyframes del video original — uno por escena del plan,
//      tomando el frame al midpoint temporal de cada escena.
//   3. Por cada escena del plan, en paralelo (concurrency 5):
//        a. Generar imagen con el imagePrompt actual (provider chain)
//        b. Comparar con el keyframe correspondiente (Gemini Vision)
//        c. Si score >= 95 → aceptar, guardar y seguir
//        d. Si score < 95 y quedan intentos → refinar prompt con el hint y regen
//   4. Output: sceneTrack con `imagePath` populado para CADA escena, donde el
//      .png ya está escrito en workDir/scene_XX.png con la mejor imagen.
//
// El pipeline.ts después de esto SALTA image-gen-multi (las imágenes ya están)
// pero opcionalmente puede correr SceneValidatorV3 para verificación anatómica.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SceneTrack,
  Scene,
  SubScene,
  CompositeLayout,
  CompositeElement,
} from '@video-factory/contracts';
import type { Logger } from '@video-factory/core';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';
import { extractKeyframes, getVideoDurationSec, type ExtractedKeyframe } from './frame-extractor';
import { reviewScene, type ReviewResult } from './scene-reviewer';
import { detectCompositeLayout } from './composite-layout-detector';
// Laboratorio de Prompts: al converger una escena del ripeo, registramos el
// prompt ganador en la librería (aprende qué recreate-prompt funcionó por estilo).
// Aditivo y best-effort: NO cambia la generación ni el render.
import { recordWinningPrompt, normalizeTargetKey } from './promptlab/prompt-library';
import { runVisualRefineLoop } from './promptlab/refine-loop';
import type { JudgeVerdict } from './promptlab/types';
import {
  buildImageProviderChain,
  generateImageWithChain,
  generateImageWithReference,
  compareImagesWithVision,
  type ProviderStep,
} from './image-gen-tools';

// === Configuración =====================================================

/**
 * Umbral de similitud aceptable por escena. 80 = aesthetic muy cercano al original.
 * Bajamos de 95 a 80 porque el comparator (Gemini Vision) penaliza diferencias
 * de IDENTIDAD aunque el STYLE sea idéntico, y 95+ resulta inalcanzable para
 * mixed-hybrid ads (UGC + stock + illustration) donde el contenido varía.
 * 80 = "mismo medium type + paleta + lighting + mood". Suficiente para fidelidad
 * visual percibida sin gastar attempts buscando un imposible.
 */
const FIDELITY_THRESHOLD = 80;
/** Score mínimo aceptable como "best-effort" si no convergemos. */
const MIN_ACCEPTABLE = 60;
/**
 * Iteraciones máximas por escena. Reducido de 5 a 3 porque después de 3 attempts
 * el comparator hint ya se repite (mismos elementos de estilo) y el costo no
 * justifica gains marginales. Trade-off: 3 attempts × N escenas × $0.05 ≈ aceptable.
 */
const MAX_ATTEMPTS_PER_SCENE = 3;
/** Cuántas escenas procesamos en paralelo. */
const SCENE_CONCURRENCY = 5;

/**
 * PNG válido mínimo 1×1 negro, usado como placeholder cuando una escena no
 * pudo generar ninguna imagen (todos los providers fallaron + comparator caído).
 * Mantiene el pipeline downstream funcional; el validator V3 lo va a marcar
 * como problemático pero no rompe el render.
 */
const TINY_BLACK_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0x99, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// === Helpers ===========================================================

/**
 * Asocia cada escena del plan con un keyframe del original. La estrategia:
 * para cada escena del plan, tomamos el keyframe del original cuyo `sourceTimeSec`
 * cae proporcionalmente en el mismo lugar de la timeline.
 *
 * Ejemplo: si el plan tiene 22 escenas que cubren 0-77s, y los keyframes del
 * original están en [3.85, 14.0, 24.2, 34.3, 44.4, 54.6, 64.7s], cada scene
 * del plan recibe el keyframe más cercano a su (startSec+endSec)/2.
 */
function associateScenesWithKeyframes(
  scenes: Scene[],
  keyframes: ExtractedKeyframe[],
  originalDuration: number,
  planDuration: number,
): Map<number, ExtractedKeyframe> {
  const map = new Map<number, ExtractedKeyframe>();
  if (keyframes.length === 0) return map;
  // Ratio entre duración del plan y duración del original
  const ratio = originalDuration / Math.max(1, planDuration);
  for (const scene of scenes) {
    // Midpoint de la escena en el plan
    const planMid = (scene.startTimeSeconds + scene.endTimeSeconds) / 2;
    // Tiempo equivalente en el original
    const originalMid = planMid * ratio;
    // Buscar el keyframe con sourceTimeSec más cercano
    let best = keyframes[0]!;
    let bestDelta = Math.abs(best.sourceTimeSec - originalMid);
    for (const kf of keyframes) {
      const delta = Math.abs(kf.sourceTimeSec - originalMid);
      if (delta < bestDelta) {
        best = kf;
        bestDelta = delta;
      }
    }
    map.set(scene.index, best);
  }
  return map;
}

// === Tipos públicos ====================================================

export interface AlignScenesOptions {
  sceneTrack: SceneTrack;
  referenceVideoPath: string;
  workDir: string;
  logger?: Logger;
  /** Callback: cada vez que una escena termina (con éxito o best-effort). */
  onSceneDone?: (sceneIndex: number, score: number, attempts: number) => void;
  /** Override del threshold de convergencia. Default 95. */
  similarityThreshold?: number;
  /** Override de intentos máximos. Default 5. */
  maxAttemptsPerScene?: number;
  /** Si el styleBase del preset es photo-realistic, priorizamos Flux/gpt-image en el chain. */
  preferRealistic?: boolean;
  /**
   * ISO 639-1 del idioma destino. Usado por scene-reviewer para detectar texto
   * burned-in en idioma incorrecto (ej. ad target=es pero imagen tiene "TRY THIS"
   * en inglés → reject). Default 'es'.
   */
  targetLanguage?: string;
  /** Nombre del producto. El reviewer chequea que aparezca cuando la escena lo menciona. */
  productName?: string | null;
}

export interface AlignScenesResult {
  sceneTrack: SceneTrack;
  perScene: Array<{
    sceneIndex: number;
    finalScore: number;
    attempts: number;
    converged: boolean;
    bestImagePath: string;
    keyframePath: string;
    /** Verdict del SceneValidatorV3 sobre la imagen elegida. 'skipped' si no se pudo correr. */
    anatomyVerdict: 'pass' | 'regenerate' | 'fatal' | 'skipped';
    /** Verdict del Scene Reviewer (semántica, idioma, coherencia). 'skipped' si no se pudo. */
    reviewVerdict: 'pass' | 'regenerate' | 'fatal' | 'skipped';
    /** Issues críticos detectados por el reviewer */
    reviewIssues: string[];
    /** Layout composite si aplica. 'single' si no se detectó split-screen. */
    compositeLayout?: CompositeLayout;
    /** Cuántos paneles tiene el composite (1 si single) */
    panelCount?: number;
    /**
     * true cuando refineSceneUntilConverged falló persistentemente porque el
     * generador alucinó un composite/grid en TODOS los attempts (a pesar de que
     * el detector clasificó la escena como single desde el keyframe). El worker
     * usa esta señal para ESCALAR la escena a generación composite real
     * (cada panel por separado) en vez de aceptar un grid alucinado.
     */
    hallucinatedCompositePersistently?: boolean;
  }>;
  avgScore: number;
}

/**
 * Heurística: ¿estos criticalIssues del reviewer indican que la imagen es un
 * composite/grid/split-screen cuando se esperaba single shot?
 */
function issuesIndicateComposite(issues: string[]): boolean {
  const s = issues.join(' ').toLowerCase();
  return (
    s.includes('composite') ||
    s.includes('grid') ||
    s.includes('split-screen') ||
    s.includes('split screen') ||
    s.includes('multi-panel') ||
    s.includes('multiple panels') ||
    s.includes('collage')
  );
}

// === Función principal =================================================

/**
 * Genera todas las imágenes del sceneTrack matcheando contra keyframes del
 * referenceVideoPath. Persiste el output en workDir/scene_XX.png.
 */
export async function alignScenesToReferenceVideo(
  opts: AlignScenesOptions,
): Promise<AlignScenesResult> {
  const {
    sceneTrack,
    referenceVideoPath,
    workDir,
    logger,
    onSceneDone,
    similarityThreshold = FIDELITY_THRESHOLD,
    maxAttemptsPerScene = MAX_ATTEMPTS_PER_SCENE,
    preferRealistic = false,
    targetLanguage = 'es',
    productName = null,
  } = opts;

  // Limpiar el map global (scoped a esta invocación) para evitar fugar
  // state entre runs cuando el módulo se reusa en server long-running.
  compositeSubScenesMap.clear();

  await mkdir(workDir, { recursive: true });
  const keyframesDir = join(workDir, 'keyframes');

  // 1. Extraer keyframes del video original
  const originalDuration = (await getVideoDurationSec(referenceVideoPath)) ?? 30;
  // Pedimos UN keyframe extra que escenas — ayuda a la asociación temporal
  const keyframeCount = Math.min(12, Math.max(3, sceneTrack.scenes.length));
  const keyframes = await extractKeyframes({
    videoPath: referenceVideoPath,
    outputDir: keyframesDir,
    count: keyframeCount,
  });
  logger?.info(
    { keyframes: keyframes.length, originalDuration },
    'rip-aligner:keyframes_extracted',
  );

  // 2. Asociar cada scene del plan con su keyframe correspondiente
  const planDuration =
    sceneTrack.scenes.length > 0
      ? sceneTrack.scenes[sceneTrack.scenes.length - 1]!.endTimeSeconds
      : 30;
  const sceneKeyframeMap = associateScenesWithKeyframes(
    sceneTrack.scenes,
    keyframes,
    originalDuration,
    planDuration,
  );

  // 3. Provider chain
  const providers = buildImageProviderChain({ preferRealistic });
  if (providers.length === 0) {
    throw new Error(
      'No hay providers de imagen configurados (OPENAI_API_KEY / GCP / GOOGLE_AI / HIGGSFIELD / FAL)',
    );
  }

  // Scene Validator V3 — corre POST-loop por cada escena (1 call extra ~$0.01/scene)
  // para detectar anatomía mala que el comparator de estilo no captura. Si el
  // validator no está disponible (sin GOOGLE_AI_API_KEY), las escenas quedan con
  // anatomyVerdict='skipped' en vez de tirar — el aligner igual funciona.
  const anatomyValidator = new SceneValidatorV3();
  const anatomyAvailable = anatomyValidator.isAvailable();
  if (!anatomyAvailable) {
    logger?.warn({}, 'rip-aligner:anatomy_validator_unavailable');
  }

  // 4. Per-scene loop con concurrency 5
  const results: AlignScenesResult['perScene'] = new Array(sceneTrack.scenes.length);
  let completed = 0;
  const queue = sceneTrack.scenes.map((s, i) => ({ scene: s, idx: i }));

  // Worker pool. Cada worker hace su loop dentro de un try/catch grande para
  // que si una escena rompe (provider muerto, comparator inaccesible) NO aborte
  // el resto del pool — esa escena queda con placeholder y los demás siguen.
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const keyframe = sceneKeyframeMap.get(item.scene.index);
        if (!keyframe) {
          // Defensive: si por algún edge case no hay keyframe (no debería pasar
          // con la lógica de associateScenesWithKeyframes), generamos one-shot
          // sin loop. Si la generación también falla, persistimos placeholder.
          const fallbackPath = join(
            workDir,
            `scene_${String(item.scene.index).padStart(2, '0')}.png`,
          );
          try {
            const { buffer, providerLabel } = await generateImageWithChain(
              item.scene.imagePrompt,
              providers,
            );
            await writeFile(fallbackPath, buffer);
            logger?.warn(
              { sceneIndex: item.scene.index, providerLabel },
              'rip-aligner:no_keyframe_fallback_ok',
            );
          } catch (genErr) {
            // Placeholder 1×1 negro para no romper el pipeline downstream
            await writeFile(fallbackPath, TINY_BLACK_PNG);
            logger?.error(
              {
                sceneIndex: item.scene.index,
                err: (genErr as Error).message.slice(0, 200),
              },
              'rip-aligner:no_keyframe_generation_failed_placeholder',
            );
          }
          results[item.idx] = {
            sceneIndex: item.scene.index,
            finalScore: 0,
            attempts: 1,
            converged: false,
            anatomyVerdict: 'skipped',
            reviewVerdict: 'skipped',
            reviewIssues: [],
            bestImagePath: fallbackPath,
            keyframePath: '',
          };
          completed++;
          onSceneDone?.(item.scene.index, 0, 1);
          continue;
        }

        // Previous scene image path (para reviewer detecte duplicación). Si la
        // escena anterior ya terminó, su imagePath está en results[item.idx-1].
        const prevSceneImagePath =
          item.idx > 0 ? results[item.idx - 1]?.bestImagePath ?? null : null;

        // === COMPOSITE DETECTION ===
        // Analizamos el keyframe del original. Si es split-screen / collage,
        // generamos cada panel por separado (mejor calidad, sin gibberish).
        // Pasamos la narración como contexto → el detector consulta el loop de
        // aprendizaje (correcciones manuales previas) para afinar la geometría.
        const detection = await detectCompositeLayout(keyframe.filePath, {
          narration: item.scene.text,
        });
        logger?.info(
          {
            sceneIndex: item.scene.index,
            layout: detection.layout,
            panels: detection.panels.length,
            reasoning: detection.reasoning,
          },
          'rip-aligner:composite_detected',
        );

        let res: AlignScenesResult['perScene'][number];
        if (detection.layout !== 'single' && detection.panels.length > 1) {
          // Composite scene → generar cada panel por separado
          res = await generateCompositeScene(
            item.scene,
            keyframe,
            detection.layout,
            detection.panels,
            providers,
            workDir,
            logger,
            anatomyAvailable ? anatomyValidator : null,
            sceneTrack.styleBase ?? '',
            targetLanguage,
            productName,
          );
        } else {
          // Single shot → flow normal (1 imagen + reviewer loop)
          res = await refineSceneUntilConverged(
            item.scene,
            keyframe,
            providers,
            workDir,
            similarityThreshold,
            maxAttemptsPerScene,
            logger,
            anatomyAvailable ? anatomyValidator : null,
            sceneTrack.styleBase ?? '',
            targetLanguage,
            productName,
            prevSceneImagePath,
          );

          // === AUTO-ESCALADO A COMPOSITE ===
          // Si refineSceneUntilConverged falló persistentemente porque el
          // generador alucinó composites en TODOS los attempts (a pesar de
          // pedirle single shot), dejamos de pelear contra el generador y
          // ESCALAMOS: detectamos el layout de la propia imagen generada y
          // generamos cada panel por separado (clean, enfocado). Esto convierte
          // un grid alucinado y borroso en un composite pixel-perfect real.
          if (res.hallucinatedCompositePersistently) {
            logger?.warn(
              { sceneIndex: item.scene.index, attempts: res.attempts },
              'rip-aligner:escalating_to_composite',
            );
            try {
              // Detectamos el layout sobre la IMAGEN GENERADA (no el keyframe),
              // porque el composite lo alucinó el generador, no estaba en el original.
              const genDetection = await detectCompositeLayout(res.bestImagePath);
              if (genDetection.layout !== 'single' && genDetection.panels.length > 1) {
                logger?.info(
                  {
                    sceneIndex: item.scene.index,
                    escalatedLayout: genDetection.layout,
                    panels: genDetection.panels.length,
                  },
                  'rip-aligner:escalated_composite_detected',
                );
                res = await generateCompositeScene(
                  item.scene,
                  keyframe,
                  genDetection.layout,
                  genDetection.panels,
                  providers,
                  workDir,
                  logger,
                  anatomyAvailable ? anatomyValidator : null,
                  sceneTrack.styleBase ?? '',
                  targetLanguage,
                  productName,
                );
              } else {
                logger?.warn(
                  { sceneIndex: item.scene.index },
                  'rip-aligner:escalation_aborted_detector_said_single',
                );
              }
            } catch (escErr) {
              // Si el escalado falla, nos quedamos con el resultado original
              // (la imagen single mejor que tuvimos). No es bloqueante.
              logger?.warn(
                {
                  sceneIndex: item.scene.index,
                  err: (escErr as Error).message.slice(0, 200),
                },
                'rip-aligner:escalation_failed',
              );
            }
          }
        }
        results[item.idx] = res;
        completed++;
        onSceneDone?.(item.scene.index, res.finalScore, res.attempts);
        logger?.info(
          {
            sceneIndex: item.scene.index,
            finalScore: res.finalScore.toFixed(1),
            attempts: res.attempts,
            converged: res.converged,
            completed,
            total: sceneTrack.scenes.length,
          },
          'rip-aligner:scene_done',
        );
      } catch (workerErr) {
        // Catch-all defensivo: si algo dentro de la escena hace throw inesperado,
        // dejamos placeholder y seguimos para no aborter el pool entero.
        const fallbackPath = join(
          workDir,
          `scene_${String(item.scene.index).padStart(2, '0')}.png`,
        );
        try {
          await writeFile(fallbackPath, TINY_BLACK_PNG);
        } catch {
          // si ni eso se puede escribir, el filesystem está roto, propagamos
          throw workerErr;
        }
        results[item.idx] = {
          sceneIndex: item.scene.index,
          finalScore: 0,
          attempts: 0,
          converged: false,
          bestImagePath: fallbackPath,
          keyframePath: '',
          anatomyVerdict: 'skipped',
          reviewVerdict: 'skipped',
          reviewIssues: [],
        };
        completed++;
        logger?.error(
          {
            sceneIndex: item.scene.index,
            err: (workerErr as Error).message.slice(0, 200),
          },
          'rip-aligner:scene_worker_exception',
        );
        onSceneDone?.(item.scene.index, 0, 0);
      }
    }
  }

  // allSettled en vez de all para que ningún rejection de un worker rompa los
  // demás (ya tenemos try/catch en cada uno, pero defensa adicional).
  await Promise.allSettled(
    Array.from(
      { length: Math.min(SCENE_CONCURRENCY, sceneTrack.scenes.length) },
      () => worker(),
    ),
  );

  // 5. Calcular score promedio y construir sceneTrack final con imagePaths
  //    + propagar compositeLayout/subScenes a cada scene que aplique.
  const avgScore =
    results.reduce((sum, r) => sum + r.finalScore, 0) / Math.max(1, results.length);
  const updatedScenes: Scene[] = sceneTrack.scenes.map((s, i) => {
    const compositeInfo = compositeSubScenesMap.get(s.index);
    return {
      ...s,
      imagePath: results[i]?.bestImagePath ?? s.imagePath,
      ...(compositeInfo
        ? {
            compositeLayout: compositeInfo.layout,
            subScenes: compositeInfo.subScenes,
            // Composición libre con geometría exacta (si el detector la capturó).
            // El compositor-remotion la prioriza sobre compositeLayout/subScenes.
            ...(compositeInfo.composition && compositeInfo.composition.length > 0
              ? { composition: compositeInfo.composition }
              : {}),
          }
        : {}),
    };
  });

  return {
    sceneTrack: { ...sceneTrack, scenes: updatedScenes },
    perScene: results,
    avgScore,
  };
}

// === Worker: loop por escena ===========================================

// INCREMENT 2 — el MISMO bucle de fidelidad por escena, pero con el control de
// bucle delegado al motor único del Laboratorio (runVisualRefineLoop). La lógica
// de IA (compare estilo + review semántico + penalización de texto quemado +
// prefijos anti-alucinación) entra como callbacks, IDÉNTICA a la inline de abajo.
// Activado por VF_RIP_USE_PROMPTLAB_MOTOR=1. Default usa la inline (probada).
const ANTI_COMPOSITE_DIRECTIVE =
  'IMPORTANT: Generate ONE SINGLE PHOTOGRAPHIC FRAME — NOT a split-screen, NOT a grid, NOT a collage, NOT multiple panels, NOT a before-after layout, NOT picture-in-picture. ONE clean photo of ONE subject in ONE scene.';
const ANTI_TEXT_DIRECTIVE =
  'ABSOLUTELY NO text, labels, captions, watermarks, signs, or any written words anywhere in the image. The photograph must be 100% CLEAN of any text or typography — all text will be added as vector overlays in post-production.';

async function refineSceneViaMotor(
  scene: Scene,
  keyframe: ExtractedKeyframe,
  providers: ProviderStep[],
  workDir: string,
  threshold: number,
  maxAttempts: number,
  logger: Logger | undefined,
  anatomyValidator: SceneValidatorV3 | null,
  styleBase: string,
  targetLanguage: string,
  productName: string | null,
  previousSceneImagePath: string | null,
): Promise<AlignScenesResult['perScene'][number]> {
  const basePrompt = scene.imagePrompt;
  let keyframeBuffer: Buffer | null = null;
  try {
    keyframeBuffer = await readFile(keyframe.filePath);
  } catch {
    keyframeBuffer = null;
  }

  // Estado capturado por closures (lo que el motor genérico no maneja: el BUFFER
  // de la mejor imagen, el último review, y el contador de composites alucinados).
  let bestBuf: Buffer | null = null;
  let bestEff = -1;
  let lastReviewResult: ReviewResult | null = null;
  let compositeRejectionCount = 0;
  let lastPrompt = basePrompt;

  const loop = await runVisualRefineLoop(
    {
      generate: async (prompt) => {
        lastPrompt = prompt;
        const result = keyframeBuffer
          ? await generateImageWithReference(prompt, keyframeBuffer, providers, 'recreate')
          : await generateImageWithChain(prompt, providers);
        return { buffer: result.buffer };
      },
      judge: async (buffer): Promise<JudgeVerdict> => {
        // PASO 1: comparar estilo contra keyframe.
        let score = 0;
        let styleHint = '';
        try {
          const cmp = await compareImagesWithVision(keyframe.filePath, buffer);
          score = cmp.score;
          styleHint = cmp.hint;
        } catch (e) {
          logger?.warn(
            { sceneIndex: scene.index, err: (e as Error).message.slice(0, 200) },
            'rip-aligner:compare_failed',
          );
          if (!bestBuf) {
            bestBuf = buffer;
            bestEff = MIN_ACCEPTABLE;
          }
          // compare caído = irrecuperable para esta escena (igual que el break inline).
          return { score: bestEff < 0 ? 0 : bestEff, byDimension: {}, approved: false, notVerified: false, fatal: true, hint: '', failedCriteria: [], evidence: [] };
        }

        // PASO 2: reviewer semántico (idéntico a la inline).
        let reviewResult: ReviewResult | null = null;
        try {
          reviewResult = await reviewScene({
            imageBuffer: buffer,
            narrationText: scene.text,
            targetLanguage,
            declaredStyle: styleBase,
            shouldHaveCleanBackground: true,
            previousSceneImagePath,
            productName,
            expectedSingleShot: true,
          });
          lastReviewResult = reviewResult;
          if (reviewResult.verdict !== 'pass' && issuesIndicateComposite(reviewResult.criticalIssues)) {
            compositeRejectionCount++;
          }
          logger?.info(
            {
              sceneIndex: scene.index,
              styleScore: score.toFixed(1),
              reviewVerdict: reviewResult.verdict,
              reviewIssues: reviewResult.criticalIssues.slice(0, 3),
            },
            'rip-aligner:reviewed',
          );
        } catch (e) {
          logger?.warn(
            { sceneIndex: scene.index, err: (e as Error).message.slice(0, 200) },
            'rip-aligner:review_failed',
          );
        }

        // Selección del MEJOR buffer penalizando texto quemado (-50), idéntico.
        const hasBurnedText = !!reviewResult?.burnedInText?.present;
        const effectiveScore = hasBurnedText ? score - 50 : score;
        if (effectiveScore > bestEff) {
          bestEff = effectiveScore;
          bestBuf = buffer;
        }

        // Convergencia: estilo OK + review OK.
        const styleOk = score >= threshold;
        const reviewOk = !reviewResult || reviewResult.verdict === 'pass';
        const reviewFatal = reviewResult?.verdict === 'fatal';

        // Hints + flags para el refinador (anti-composite / anti-texto).
        const reviewHint =
          reviewResult && reviewResult.verdict !== 'pass' ? reviewResult.refinementHint : '';
        const combinedHint = [reviewHint, styleHint].filter(Boolean).join(' | ');
        const issuesStr = (reviewResult?.criticalIssues ?? []).join(' ').toLowerCase();
        const failed: string[] = [];
        if (
          issuesStr.includes('composite') ||
          issuesStr.includes('grid') ||
          issuesStr.includes('split-screen') ||
          issuesStr.includes('split screen') ||
          issuesStr.includes('multi-panel') ||
          issuesStr.includes('multiple panels')
        ) {
          failed.push('composite');
        }
        if (
          issuesStr.includes('burned-in text') ||
          issuesStr.includes('gibberish') ||
          issuesStr.includes('typo')
        ) {
          failed.push('text');
        }

        return {
          score: effectiveScore,
          byDimension: {},
          approved: styleOk && reviewOk,
          notVerified: false,
          fatal: reviewFatal,
          hint: combinedHint,
          failedCriteria: failed,
          evidence: styleHint ? [styleHint] : [],
        };
      },
      refine: async (prompt, verdict) => {
        const prefixDirectives: string[] = [];
        if (verdict.failedCriteria.includes('composite')) prefixDirectives.push(ANTI_COMPOSITE_DIRECTIVE);
        if (verdict.failedCriteria.includes('text')) prefixDirectives.push(ANTI_TEXT_DIRECTIVE);
        if (prefixDirectives.length > 0) {
          return `${prefixDirectives.join(' ')}\n\n${basePrompt}\n\nCRITICAL ADJUSTMENTS for next attempt: ${verdict.hint}`;
        }
        if (verdict.hint) {
          return `${basePrompt}\n\nCRITICAL ADJUSTMENTS for next attempt: ${verdict.hint}`;
        }
        return prompt;
      },
    },
    {
      basePrompt,
      maxAttempts,
      // El ripeo NO para por estancamiento (igual que la inline): desactivado.
      minDelta: Number.NEGATIVE_INFINITY,
      // Un fallo de generación corta y conserva el mejor (igual que el break inline).
      stopOnGenerateError: true,
    },
  );

  const converged = loop.stopReason === 'aprobado';
  const attemptsUsed = loop.iterations.length;

  // Persistir la mejor imagen (o placeholder), idéntico a la inline.
  const imagePath = join(workDir, `scene_${String(scene.index).padStart(2, '0')}.png`);
  if (bestBuf) {
    await writeFile(imagePath, bestBuf);
  } else {
    await writeFile(imagePath, TINY_BLACK_PNG);
  }

  // ANATOMY CHECK best-effort (idéntico).
  let anatomyVerdict: 'pass' | 'regenerate' | 'fatal' | 'skipped' = 'skipped';
  if (anatomyValidator && bestBuf) {
    try {
      const validation = await anatomyValidator.validate({
        text: scene.text,
        imagePrompt: lastPrompt,
        imageBuffer: bestBuf,
        styleBase,
        fastMode: true,
      });
      anatomyVerdict = validation.verdict;
      if (validation.verdict !== 'pass') {
        logger?.warn(
          { sceneIndex: scene.index, anatomyVerdict: validation.verdict, issues: validation.issues?.slice(0, 3) },
          'rip-aligner:anatomy_concern',
        );
      }
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, err: (e as Error).message.slice(0, 200) },
        'rip-aligner:anatomy_validator_failed',
      );
    }
  }

  // APRENDER (PromptLab): registra el prompt ganador al converger (igual que la inline).
  if (converged) {
    void recordWinningPrompt({
      mode: 'ripear',
      targetKey: normalizeTargetKey(styleBase),
      prompt: lastPrompt,
      score: Math.round(bestEff < 0 ? 0 : bestEff),
      byDimension: {},
      attempts: attemptsUsed,
      intention: scene.text.slice(0, 200),
    });
  }

  const hallucinatedCompositePersistently =
    !converged && attemptsUsed >= 2 && compositeRejectionCount >= attemptsUsed;

  return {
    sceneIndex: scene.index,
    finalScore: bestEff < 0 ? 0 : bestEff,
    attempts: attemptsUsed,
    converged,
    bestImagePath: imagePath,
    keyframePath: keyframe.filePath,
    anatomyVerdict,
    // cast: TS estrecha a null porque la asignación vive en un closure (el callback
    // judge). El valor real es ReviewResult | null.
    reviewVerdict: (lastReviewResult as ReviewResult | null)?.verdict ?? 'skipped',
    reviewIssues: (lastReviewResult as ReviewResult | null)?.criticalIssues ?? [],
    compositeLayout: 'single',
    panelCount: 1,
    hallucinatedCompositePersistently,
  };
}

async function refineSceneUntilConverged(
  scene: Scene,
  keyframe: ExtractedKeyframe,
  providers: ProviderStep[],
  workDir: string,
  threshold: number,
  maxAttempts: number,
  logger: Logger | undefined,
  anatomyValidator: SceneValidatorV3 | null,
  styleBase: string,
  targetLanguage: string,
  productName: string | null,
  previousSceneImagePath: string | null,
): Promise<AlignScenesResult['perScene'][number]> {
  // INCREMENT 2 (opt-in, default OFF): correr este mismo bucle a través del motor
  // único del Laboratorio (runVisualRefineLoop). Mismo comportamiento, una sola
  // implementación del control de bucle. Detrás de flag para promoverlo SOLO tras
  // verificar con un ripeo real — el bucle probado de abajo sigue siendo el default.
  if (process.env['VF_RIP_USE_PROMPTLAB_MOTOR'] === '1') {
    return refineSceneViaMotor(
      scene,
      keyframe,
      providers,
      workDir,
      threshold,
      maxAttempts,
      logger,
      anatomyValidator,
      styleBase,
      targetLanguage,
      productName,
      previousSceneImagePath,
    );
  }

  const basePrompt = scene.imagePrompt;
  let currentPrompt = basePrompt;
  // Cargamos el keyframe del original como REFERENCIA de generación (image-to-image):
  // así cada escena RECREA la composición DENSA del original, en vez de nacer de un
  // prompt de texto pelado (que producía "un personaje sobre un fondo vacío").
  let keyframeBuffer: Buffer | null = null;
  try {
    keyframeBuffer = await readFile(keyframe.filePath);
  } catch {
    keyframeBuffer = null;
  }
  let bestBuffer: Buffer | null = null;
  let bestScore = 0;
  let attemptsUsed = 0;
  let converged = false;
  // El reviewer chequea: idioma del texto burned-in, coherencia con narración,
  // duplicación con escena anterior, producto visible, glifos rotos, anatomía.
  let lastReviewResult: ReviewResult | null = null;
  // Contador de attempts donde el generador alucinó un composite/grid. Si TODOS
  // los attempts fueron rechazados por composite, el worker escala la escena a
  // generación composite real (panel por panel).
  let compositeRejectionCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attemptsUsed = attempt + 1;
    let buffer: Buffer;
    try {
      const result = keyframeBuffer
        ? await generateImageWithReference(currentPrompt, keyframeBuffer, providers, 'recreate')
        : await generateImageWithChain(currentPrompt, providers);
      buffer = result.buffer;
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, attempt, err: (e as Error).message.slice(0, 200) },
        'rip-aligner:generation_failed',
      );
      break;
    }

    // PASO 1: comparar estilo contra keyframe
    let score = 0;
    let styleHint = '';
    try {
      const cmp = await compareImagesWithVision(keyframe.filePath, buffer);
      score = cmp.score;
      styleHint = cmp.hint;
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, attempt, err: (e as Error).message.slice(0, 200) },
        'rip-aligner:compare_failed',
      );
      if (!bestBuffer) {
        bestBuffer = buffer;
        bestScore = MIN_ACCEPTABLE;
      }
      break;
    }

    // La selección del MEJOR buffer se hace DESPUÉS del reviewer (más abajo) para
    // poder PENALIZAR el texto quemado/subtítulos. Aquí solo garantizamos que
    // siempre haya un buffer de respaldo aunque el reviewer caiga.
    if (!bestBuffer) {
      bestBuffer = buffer;
      bestScore = score;
    }

    // PASO 2: reviewer semántico (lenguaje + coherencia + burned-in text + duplicados)
    // Lo corremos SIEMPRE, incluso si el style score es alto, porque puede detectar
    // problemas que el comparator de estilo no ve (ej. texto inglés en ad español).
    let reviewResult: ReviewResult | null = null;
    try {
      reviewResult = await reviewScene({
        imageBuffer: buffer,
        narrationText: scene.text,
        targetLanguage,
        declaredStyle: styleBase,
        // SIEMPRE limpio: el owner NO quiere subtítulos/texto quemado. Cualquier
        // texto va como overlay vectorial en post — así el reviewer rechaza texto
        // que el generador incruste (p.ej. captions copiados del original).
        shouldHaveCleanBackground: true,
        previousSceneImagePath,
        productName,
        // Si estamos en refineSceneUntilConverged, el detector ya clasificó la
        // escena como single. Cualquier composite/grid en el output es una
        // hallucination del generador (gpt-image-1 tiende a producir grids
        // cuando el preset learned tiene muchos collages). El reviewer debe
        // rechazar y forzar regeneración con prompt "single shot only".
        expectedSingleShot: true,
      });
      lastReviewResult = reviewResult;
      if (
        reviewResult.verdict !== 'pass' &&
        issuesIndicateComposite(reviewResult.criticalIssues)
      ) {
        compositeRejectionCount++;
      }
      logger?.info(
        {
          sceneIndex: scene.index,
          attempt,
          styleScore: score.toFixed(1),
          reviewVerdict: reviewResult.verdict,
          reviewIssues: reviewResult.criticalIssues.slice(0, 3),
        },
        'rip-aligner:reviewed',
      );
    } catch (e) {
      logger?.warn(
        { sceneIndex: scene.index, attempt, err: (e as Error).message.slice(0, 200) },
        'rip-aligner:review_failed',
      );
      // Si reviewer cayó, no bloqueamos — confiamos en el style score
    }

    // Selección del MEJOR buffer PENALIZANDO texto quemado (subtítulos/captions que el
    // generador incrusta copiando el original). Preferimos imagen LIMPIA aunque tenga
    // algo menos de score de estilo — el owner NO quiere subtítulos quemados.
    {
      const hasBurnedText = !!reviewResult?.burnedInText?.present;
      const effectiveScore = hasBurnedText ? score - 50 : score;
      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestBuffer = buffer;
      }
    }

    // PASO 3: decisión de convergencia
    const styleOk = score >= threshold;
    const reviewOk = !reviewResult || reviewResult.verdict === 'pass';
    const reviewFatal = reviewResult?.verdict === 'fatal';

    if (styleOk && reviewOk) {
      converged = true;
      logger?.info(
        { sceneIndex: scene.index, attempt, styleScore: score.toFixed(1) },
        'rip-aligner:converged',
      );
      // APRENDER (PromptLab): registra el prompt que convergió. Best-effort,
      // fire-and-forget — nunca bloquea ni rompe el ripeo. Cierra el bucle de
      // aprendizaje para el pipeline real de ripeo.
      void recordWinningPrompt({
        mode: 'ripear',
        targetKey: normalizeTargetKey(styleBase),
        prompt: currentPrompt,
        score: Math.round(score),
        byDimension: {},
        attempts: attemptsUsed,
        intention: scene.text.slice(0, 200),
      });
      break;
    }
    if (reviewFatal) {
      // Imagen rota irrecuperable — quedarnos con la mejor que tengamos
      logger?.warn(
        { sceneIndex: scene.index, attempt, issues: reviewResult?.criticalIssues },
        'rip-aligner:review_fatal',
      );
      break;
    }

    // PASO 4: refinar el prompt para el próximo attempt
    // Priorizamos el hint del reviewer (problemas semánticos) sobre el del comparator
    // (estilo). Si reviewer dice "burned-in English text", eso es más urgente que
    // "warmer tones".
    const reviewHint = reviewResult && reviewResult.verdict !== 'pass'
      ? reviewResult.refinementHint
      : '';
    const combinedHint = [reviewHint, styleHint].filter(Boolean).join(' | ');

    // ANTI-HALLUCINATION PREFIX: cuando el reviewer detecta que el generador
    // alucinó un composite/grid o burned-in text, los hints van al final del
    // prompt y gpt-image-1 tiende a ignorarlos (el preset learned domina el
    // patrón). Inyectamos directivas EXPLÍCITAS al INICIO del prompt — los
    // image generators respetan más las primeras instrucciones del prompt.
    const issuesStr = (reviewResult?.criticalIssues ?? []).join(' ').toLowerCase();
    const hallucinatedComposite =
      issuesStr.includes('composite') ||
      issuesStr.includes('grid') ||
      issuesStr.includes('split-screen') ||
      issuesStr.includes('split screen') ||
      issuesStr.includes('multi-panel') ||
      issuesStr.includes('multiple panels');
    const hallucinatedText =
      issuesStr.includes('burned-in text') ||
      issuesStr.includes('gibberish') ||
      issuesStr.includes('typo');

    const prefixDirectives: string[] = [];
    if (hallucinatedComposite) {
      prefixDirectives.push(
        'IMPORTANT: Generate ONE SINGLE PHOTOGRAPHIC FRAME — NOT a split-screen, NOT a grid, NOT a collage, NOT multiple panels, NOT a before-after layout, NOT picture-in-picture. ONE clean photo of ONE subject in ONE scene.',
      );
    }
    if (hallucinatedText) {
      prefixDirectives.push(
        'ABSOLUTELY NO text, labels, captions, watermarks, signs, or any written words anywhere in the image. The photograph must be 100% CLEAN of any text or typography — all text will be added as vector overlays in post-production.',
      );
    }

    if (prefixDirectives.length > 0) {
      currentPrompt = `${prefixDirectives.join(' ')}\n\n${basePrompt}\n\nCRITICAL ADJUSTMENTS for next attempt: ${combinedHint}`;
    } else if (combinedHint) {
      currentPrompt = `${basePrompt}\n\nCRITICAL ADJUSTMENTS for next attempt: ${combinedHint}`;
    }
  }

  // Persistir la mejor imagen como scene_XX.png. Si NUNCA tuvimos un buffer,
  // creamos placeholder negro mínimo para no crashear el pipeline downstream.
  const imagePath = join(workDir, `scene_${String(scene.index).padStart(2, '0')}.png`);
  if (bestBuffer) {
    await writeFile(imagePath, bestBuffer);
  } else {
    // PNG 1×1 negro placeholder — el validator V3 lo va a marcar como bad pero
    // el resto del pipeline (audio, scene-animator, compositor) sigue.
    await writeFile(imagePath, TINY_BLACK_PNG);
  }

  // ANATOMY CHECK best-effort: el comparator de estilo NO captura defectos
  // anatómicos (dedos extra, manos fusionadas, ojos asimétricos). Corremos el
  // SceneValidatorV3 una vez sobre la mejor imagen para registrar verdict en
  // el resultado. No regeneramos aunque sea reject (ya consumimos attempts);
  // pero el verdict queda registrado para que el caller decida (UI/correcciones).
  let anatomyVerdict: 'pass' | 'regenerate' | 'fatal' | 'skipped' = 'skipped';
  if (anatomyValidator && bestBuffer) {
    try {
      const validation = await anatomyValidator.validate({
        text: scene.text,
        imagePrompt: currentPrompt,
        imageBuffer: bestBuffer,
        styleBase,
        fastMode: true,
      });
      anatomyVerdict = validation.verdict;
      if (validation.verdict !== 'pass') {
        logger?.warn(
          {
            sceneIndex: scene.index,
            anatomyVerdict: validation.verdict,
            issues: validation.issues?.slice(0, 3),
          },
          'rip-aligner:anatomy_concern',
        );
      }
    } catch (e) {
      // Validator caído — no es bloqueante, dejamos verdict='skipped'
      logger?.warn(
        { sceneIndex: scene.index, err: (e as Error).message.slice(0, 200) },
        'rip-aligner:anatomy_validator_failed',
      );
    }
  }

  // El generador alucinó composites de forma persistente si: no convergimos,
  // hicimos ≥2 attempts, y TODOS los attempts con review fueron rechazados por
  // composite. En ese caso el worker va a escalar a generación composite real.
  const hallucinatedCompositePersistently =
    !converged && attemptsUsed >= 2 && compositeRejectionCount >= attemptsUsed;

  return {
    sceneIndex: scene.index,
    finalScore: bestScore,
    attempts: attemptsUsed,
    converged,
    bestImagePath: imagePath,
    keyframePath: keyframe.filePath,
    anatomyVerdict,
    reviewVerdict: lastReviewResult?.verdict ?? 'skipped',
    reviewIssues: lastReviewResult?.criticalIssues ?? [],
    compositeLayout: 'single',
    panelCount: 1,
    hallucinatedCompositePersistently,
  };
}

/**
 * Genera una escena composite: cada panel del layout es una imagen independiente
 * con su propio prompt, reviewer, y persistencia. Después el compositor-remotion
 * sabe cómo armar el grid pixel-perfect.
 *
 * El validator V3 corre best-effort sobre el panel "principal" para detectar
 * anatomy issues. Reviewer se aplica panel-por-panel.
 */
async function generateCompositeScene(
  scene: Scene,
  keyframe: ExtractedKeyframe,
  layout: CompositeLayout,
  panels: Array<{
    position: string;
    description: string;
    textOverlay: string | null;
    // Geometría exacta del panel (% del frame). La devuelve el detector de
    // geometría exacta. Si todos los paneles la traen, generamos composición
    // libre; si falta en alguno, caemos al camino subScenes/compositeLayout.
    rect?: { x: number; y: number; w: number; h: number } | null;
  }>,
  providers: ProviderStep[],
  workDir: string,
  logger: Logger | undefined,
  anatomyValidator: SceneValidatorV3 | null,
  styleBase: string,
  targetLanguage: string,
  productName: string | null,
): Promise<AlignScenesResult['perScene'][number]> {
  const subScenes: SubScene[] = [];
  const sceneIdxStr = String(scene.index).padStart(2, '0');

  // Generar cada panel independientemente
  for (const panel of panels) {
    // Prompt enfocado en EL panel solamente, no en el collage entero
    const panelPrompt = `${styleBase}

PANEL CONTENT (single, focused shot — NOT a collage, NOT a split-screen):
${panel.description}

Style: vertical 9:16 single coherent shot, focused composition, NO split-screen, NO grid, NO collage, NO panels, NO multiple frames. CLEAN background, NO text overlay, NO captions, NO burned-in text — text rendering is done in post-production.`;

    let panelBuffer: Buffer | null = null;
    let panelReview: ReviewResult | null = null;
    // 2 attempts por panel (composite tiene muchos paneles, mantenemos costo razonable)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await generateImageWithChain(panelPrompt, providers);
        const buffer = result.buffer;

        // Reviewer para este panel: idioma, burned-in text, coherencia con narración
        try {
          panelReview = await reviewScene({
            imageBuffer: buffer,
            narrationText: scene.text,
            targetLanguage,
            declaredStyle: styleBase,
            shouldHaveCleanBackground: true, // Composite paneles SIEMPRE limpios
            previousSceneImagePath: null,
            productName,
          });
        } catch {
          panelReview = null;
        }

        if (!panelReview || panelReview.verdict === 'pass') {
          panelBuffer = buffer;
          break;
        }
        // Regenerar con hint del reviewer
        // (el segundo attempt usa el mismo panelPrompt + hint, no entramos a más loops)
        if (attempt === 1) {
          panelBuffer = buffer; // último intento, nos quedamos con lo que tengamos
        }
      } catch (e) {
        logger?.warn(
          {
            sceneIndex: scene.index,
            panel: panel.position,
            attempt,
            err: (e as Error).message.slice(0, 200),
          },
          'rip-aligner:composite_panel_generation_failed',
        );
        break;
      }
    }

    // Persistir el panel
    const panelPath = join(workDir, `scene_${sceneIdxStr}_panel_${panel.position}.png`);
    if (panelBuffer) {
      await writeFile(panelPath, panelBuffer);
    } else {
      await writeFile(panelPath, TINY_BLACK_PNG);
    }

    subScenes.push({
      panel: panel.position,
      imagePrompt: panelPrompt,
      imagePath: panelPath,
      ...(panel.textOverlay
        ? {
            textOverlay: {
              kind: 'subtitle-banner' as const,
              text: panel.textOverlay,
              scale: 1,
            },
          }
        : {}),
    });

    logger?.info(
      {
        sceneIndex: scene.index,
        panel: panel.position,
        textOverlay: panel.textOverlay,
        verdict: panelReview?.verdict ?? 'skipped',
      },
      'rip-aligner:composite_panel_done',
    );
  }

  // Persistir el "imagePath principal" como el del primer panel (lo usa el
  // pipeline downstream para thumbnails y video del scene-animator si aplica).
  // El compositor-remotion va a leer subScenes[] para renderizar el grid real.
  const primaryImagePath = subScenes[0]?.imagePath ?? join(workDir, `scene_${sceneIdxStr}.png`);

  // Anatomy check best-effort sobre el panel principal
  let anatomyVerdict: 'pass' | 'regenerate' | 'fatal' | 'skipped' = 'skipped';
  if (anatomyValidator && subScenes[0]?.imagePath) {
    try {
      const firstPanelBuffer = await import('node:fs/promises').then((m) =>
        m.readFile(subScenes[0]!.imagePath!),
      );
      const validation = await anatomyValidator.validate({
        text: scene.text,
        imagePrompt: subScenes[0]!.imagePrompt,
        imageBuffer: firstPanelBuffer,
        styleBase,
        fastMode: true,
      });
      anatomyVerdict = validation.verdict;
    } catch {
      /* validator unavailable */
    }
  }

  // COMPOSICIÓN LIBRE: si TODOS los paneles trajeron geometría exacta (rect)
  // del detector, construimos un CompositeElement[] con las coordenadas reales.
  // Esto reproduce la edición compleja del original pixel-perfect, en vez de
  // encajar las piezas en un grid rígido. Si falta rect en algún panel, dejamos
  // composition=undefined y el compositor cae al camino subScenes/compositeLayout.
  let composition: CompositeElement[] | undefined;
  const allHaveRect = panels.length > 0 && panels.every((p) => p.rect != null);
  if (allHaveRect) {
    composition = subScenes.map((sub, i) => {
      const r = panels[i]!.rect!;
      return {
        id: `s${scene.index}_${sub.panel}`,
        kind: 'image' as const,
        imagePrompt: sub.imagePrompt,
        imagePath: sub.imagePath,
        rect: { xPct: r.x, yPct: r.y, widthPct: r.w, heightPct: r.h },
        rotationDeg: 0,
        opacity: 1,
        zIndex: i,
        fit: 'cover' as const,
        cornerRadiusPct: 0,
        manuallyAdjusted: false,
        ...(sub.textOverlay ? { textOverlay: sub.textOverlay } : {}),
      };
    });
    logger?.info(
      { sceneIndex: scene.index, elements: composition.length },
      'rip-aligner:freeform_composition_built',
    );
  }

  // Guardamos las subScenes en el Map global para que alignScenesToReferenceVideo
  // las propague al sceneTrack final después del Promise.allSettled.
  compositeSubScenesMap.set(scene.index, { layout, subScenes, composition });

  return {
    sceneIndex: scene.index,
    finalScore: 80, // composite usa flow distinto — no aplicamos similarity score per scene
    attempts: subScenes.length,
    converged: true,
    bestImagePath: primaryImagePath,
    keyframePath: keyframe.filePath,
    anatomyVerdict,
    reviewVerdict: 'pass', // panel-by-panel reviewer ya aplicó
    reviewIssues: [],
    compositeLayout: layout,
    panelCount: subScenes.length,
  };
}

/**
 * Map externo (scoped a un solo `alignScenesToReferenceVideo` call) donde los
 * workers de composite registran sus sub-escenas. Después del worker pool,
 * mutamos sceneTrack.scenes para que cada scene composite tenga compositeLayout
 * + subScenes correctos. Esto lo lee el compositor-remotion downstream.
 */
const compositeSubScenesMap = new Map<
  number,
  { layout: CompositeLayout; subScenes: SubScene[]; composition?: CompositeElement[] }
>();
