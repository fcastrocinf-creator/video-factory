// Style trainer: loop iterativo de "aprender el estilo visual" de un video.
//
// Pipeline:
//   1. Extrae N keyframes equiespaciados del video original (ffmpeg)
//   2. Analiza el video con Gemini multimodal → AdAnalysis (paleta, narrador, etc.)
//   3. Por cada keyframe:
//        a) Genera una imagen con provider chain usando prompt derivado del análisis
//        b) Compara la generada vs el original con Gemini Vision → {score, hint}
//        c) Si score < THRESHOLD y quedan iters, regenera con prompt + hint
//        d) Si score >= THRESHOLD o se agotan iters, fija la mejor iteración
//   4. Cuando todos los keyframes convergen, construye un preset destilado
//      usando dynamic-preset-builder (con tag "🎓 Entrenado")
//   5. Extrae "ideas generales" del original (resumen ejecutivo Gemini)
//   6. Persiste todo: preset → packages/presets/pending/, trajectory → DB
//
// El frontend pollea el DB cada 2s para mostrar la trayectoria en vivo:
// cada iteración se persiste tan pronto como termina.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { GeminiClient } from '@video-factory/block-scene-planner';
import type { AdAnalysis, BrandConfig } from '@video-factory/contracts';
import { db, trainingVideos } from './db';
import { analyzeAd } from './ad-analyzer';
import { extractKeyframes, type ExtractedKeyframe } from './frame-extractor';
import { buildAndPersistDynamicPreset } from './dynamic-preset-builder';
// Helpers compartidos con rip-fidelity-aligner — un solo source of truth para
// provider chain y comparator (image-gen-tools.ts). NO duplicar código aquí.
import {
  buildImageProviderChain,
  generateImageWithChain,
  compareImagesWithVision,
  type ProviderStep,
} from './image-gen-tools';

// === Configuración ====================================================

/** Umbral de "similitud aceptable" por frame. 92 = visualmente muy similar. */
const SIMILARITY_THRESHOLD = 92;
/** Iteraciones máximas por keyframe antes de quedarse con la mejor. */
const MAX_ITERS_PER_KEYFRAME = 5;
// El modelo Gemini Vision lo maneja ahora image-gen-tools.ts (comparator centralizado).

// === Schema de trayectoria =============================================

export const TrainingIterationSchema = z.object({
  iter: z.number().int().nonnegative(),
  promptUsed: z.string(),
  imagePath: z.string(),
  imageRelPath: z.string(), // relativo al workDir, sirve para servir vía API
  score: z.number().min(0).max(100),
  hint: z.string(),
  provider: z.string(),
  generatedAt: z.string(),
});
export type TrainingIteration = z.infer<typeof TrainingIterationSchema>;

export const TrainingKeyframeSchema = z.object({
  index: z.number().int().nonnegative(),
  sourceTimeSec: z.number().nonnegative(),
  originalFramePath: z.string(),
  originalFrameRelPath: z.string(),
  iterations: z.array(TrainingIterationSchema),
  bestIter: z.number().int().nonnegative(),
  finalScore: z.number().min(0).max(100),
  converged: z.boolean(),
});
export type TrainingKeyframe = z.infer<typeof TrainingKeyframeSchema>;

export const TrainingTrajectorySchema = z.object({
  keyframes: z.array(TrainingKeyframeSchema),
  overallScore: z.number().min(0).max(100),
  converged: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});
export type TrainingTrajectory = z.infer<typeof TrainingTrajectorySchema>;

// === Provider chain ===================================================

// (ProviderStep, buildProviderChain, generateWithChain, compareImages — todo
//  importado desde ./image-gen-tools. Eliminada duplicación masiva ~200 líneas.)

// === Prompt builder per keyframe =======================================

function buildKeyframePrompt(analysis: AdAnalysis, keyframeIdx: number): string {
  // Tomamos la escena del análisis cuyo timestamp esté más cerca del keyframe.
  // Como las escenas del análisis están ordenadas por tiempo, podemos usar
  // proporción simple si tenemos al menos 1.
  const sceneCount = analysis.scenes.length;
  if (sceneCount === 0) {
    return `Vertical 9:16 advertising frame in the editorial style: ${analysis.editorialLine.slice(0, 200)}`;
  }
  const sceneIdx = Math.min(
    sceneCount - 1,
    Math.floor((keyframeIdx / Math.max(1, sceneCount)) * sceneCount),
  );
  const scene = analysis.scenes[sceneIdx]!;

  const characterClause =
    analysis.narratorProfile?.narratorPresent && analysis.narratorProfile.characterCard
      ? ` Character: ${analysis.narratorProfile.characterCard.slice(0, 150)}.`
      : '';

  return `Vertical 9:16 advertising frame.
Scene: ${scene.visualDescription.slice(0, 300)}.${characterClause}
Editorial line (preserve mood): ${analysis.editorialLine.slice(0, 180)}.
Style: match a premium short-form ad aesthetic, single coherent illustrated/photo scene, no text overlay, no watermark.`;
}

// === Training loop ====================================================

export interface TrainStyleOptions {
  trainingId: string;
  videoPath: string;
  workDir: string;
  /** Callback: cada vez que se completa una iteración. Para persistir progreso. */
  onIteration?: (trajectory: TrainingTrajectory, progress: number) => Promise<void>;
  /** Callback: cuando termina el análisis Gemini. */
  onAnalysisDone?: (analysis: AdAnalysis) => Promise<void>;
}

export interface TrainStyleResult {
  trajectory: TrainingTrajectory;
  resultPresetId: string;
  generalIdeas: string[];
  analysis: AdAnalysis;
}

/**
 * Entrena un estilo visual a partir de un video de referencia.
 *
 * Persiste progreso en DB después de cada iteración. El frontend pollea
 * /api/training/[id] cada 2s y muestra la trayectoria viva.
 */
export async function trainStyle(opts: TrainStyleOptions): Promise<TrainStyleResult> {
  const { trainingId, videoPath, workDir, onIteration, onAnalysisDone } = opts;
  await mkdir(workDir, { recursive: true });

  const providers = buildImageProviderChain();
  if (providers.length === 0) {
    throw new Error(
      'No hay providers de imagen configurados (OPENAI_API_KEY / GCP / GOOGLE_AI / HIGGSFIELD / FAL)',
    );
  }

  // 1. Análisis multimodal del video (reusa ad-analyzer)
  const analysis = await analyzeAd({ videoPath });
  if (onAnalysisDone) await onAnalysisDone(analysis);

  // 2. Extraer keyframes
  const keyframesDir = join(workDir, 'keyframes');
  const keyframes = await extractKeyframes({ videoPath, outputDir: keyframesDir });
  if (keyframes.length === 0) {
    throw new Error('No se pudieron extraer keyframes del video');
  }

  // 3. Per-keyframe training loop
  const iterationsDir = join(workDir, 'iterations');
  await mkdir(iterationsDir, { recursive: true });

  const trajectory: TrainingTrajectory = {
    keyframes: [],
    overallScore: 0,
    converged: false,
    startedAt: new Date().toISOString(),
  };

  for (const kf of keyframes) {
    const kfResult = await trainOneKeyframe(
      kf,
      analysis,
      providers,
      iterationsDir,
      workDir,
      async (partialKfState) => {
        // Update trajectory with current keyframe partial state and persist
        const partialTraj: TrainingTrajectory = {
          ...trajectory,
          keyframes: [...trajectory.keyframes, partialKfState],
        };
        const progress = computeProgress(partialTraj, keyframes.length);
        if (onIteration) await onIteration(partialTraj, progress);
      },
    );
    trajectory.keyframes.push(kfResult);
    const progress = computeProgress(trajectory, keyframes.length);
    if (onIteration) await onIteration(trajectory, progress);
  }

  // 4. Overall score + converged
  trajectory.overallScore =
    trajectory.keyframes.reduce((sum, k) => sum + k.finalScore, 0) /
    Math.max(1, trajectory.keyframes.length);
  trajectory.converged = trajectory.keyframes.every((k) => k.converged);
  trajectory.completedAt = new Date().toISOString();

  // 5. Construir el preset destilado con marca-de-fábrica "trained"
  // Usamos un brand "placeholder" mínimo porque buildAndPersistDynamicPreset
  // sólo lo usa para sourceFileName context. El preset real es agnóstico al brand.
  const placeholderBrand: BrandConfig = makePlaceholderBrand();
  const { presetId } = await buildAndPersistDynamicPreset({
    analysis,
    brand: placeholderBrand,
    sourceFileName: `trained-${trainingId.slice(0, 8)}`,
  });

  // 6. Extraer "ideas generales"
  const generalIdeas = await extractGeneralIdeas(analysis);

  return {
    trajectory,
    resultPresetId: presetId,
    generalIdeas,
    analysis,
  };
}

async function trainOneKeyframe(
  kf: ExtractedKeyframe,
  analysis: AdAnalysis,
  providers: ProviderStep[],
  iterationsDir: string,
  workDirRoot: string,
  onIter: (partialKf: TrainingKeyframe) => Promise<void>,
): Promise<TrainingKeyframe> {
  const basePrompt = buildKeyframePrompt(analysis, kf.index);
  let currentPrompt = basePrompt;
  const iterations: TrainingIteration[] = [];
  let bestScore = 0;
  let bestIter = 0;

  for (let iter = 0; iter < MAX_ITERS_PER_KEYFRAME; iter++) {
    let buffer: Buffer;
    let providerLabel: string;
    try {
      const result = await generateImageWithChain(currentPrompt, providers);
      buffer = result.buffer;
      providerLabel = result.providerLabel;
    } catch (e) {
      // Si todos los providers fallaron, guardamos un score 0 y seguimos
      iterations.push({
        iter,
        promptUsed: currentPrompt,
        imagePath: '',
        imageRelPath: '',
        score: 0,
        hint: `Generación falló: ${(e as Error).message.slice(0, 100)}`,
        provider: 'none',
        generatedAt: new Date().toISOString(),
      });
      break;
    }

    const fileName = `frame_${String(kf.index).padStart(2, '0')}_iter_${iter}.png`;
    const filePath = join(iterationsDir, fileName);
    await writeFile(filePath, buffer);
    const relPath = relative(workDirRoot, filePath).replace(/\\/g, '/');

    // Comparar con el original
    let score = 0;
    let hint = '';
    try {
      const cmp = await compareImagesWithVision(kf.filePath, buffer);
      score = cmp.score;
      hint = cmp.hint;
    } catch (e) {
      // Comparador caído — registramos pero seguimos
      hint = `Comparator falló: ${(e as Error).message.slice(0, 100)}`;
      score = 0;
    }

    const originalRelPath = relative(workDirRoot, kf.filePath).replace(/\\/g, '/');

    const iteration: TrainingIteration = {
      iter,
      promptUsed: currentPrompt,
      imagePath: filePath,
      imageRelPath: relPath,
      score,
      hint,
      provider: providerLabel,
      generatedAt: new Date().toISOString(),
    };
    iterations.push(iteration);

    if (score > bestScore) {
      bestScore = score;
      bestIter = iter;
    }

    // Notificar al caller para persistencia
    await onIter({
      index: kf.index,
      sourceTimeSec: kf.sourceTimeSec,
      originalFramePath: kf.filePath,
      originalFrameRelPath: originalRelPath,
      iterations: [...iterations],
      bestIter,
      finalScore: bestScore,
      converged: bestScore >= SIMILARITY_THRESHOLD,
    });

    if (score >= SIMILARITY_THRESHOLD) break;

    // Refinar prompt con el hint para la siguiente iteración
    currentPrompt = `${basePrompt}\n\nCRITICAL ADJUSTMENT (from previous attempt feedback): ${hint}`;
  }

  return {
    index: kf.index,
    sourceTimeSec: kf.sourceTimeSec,
    originalFramePath: kf.filePath,
    originalFrameRelPath: relative(workDirRoot, kf.filePath).replace(/\\/g, '/'),
    iterations,
    bestIter,
    finalScore: bestScore,
    converged: bestScore >= SIMILARITY_THRESHOLD,
  };
}

function computeProgress(trajectory: TrainingTrajectory, totalKeyframes: number): number {
  // 10% reservado al análisis Gemini, 5% al keyframe extraction, 80% al loop,
  // 5% al preset destilado.
  const loopDone = trajectory.keyframes.length / totalKeyframes;
  return Math.min(95, 15 + Math.round(loopDone * 80));
}

// === "Ideas generales" (resumen ejecutivo) ============================

async function extractGeneralIdeas(analysis: AdAnalysis): Promise<string[]> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    return [
      `Línea editorial: ${analysis.editorialLine.slice(0, 100)}`,
      `Hook: ${analysis.hookType}`,
      `Duración: ${analysis.totalDurationSeconds.toFixed(0)}s · ${analysis.scenes.length} escenas`,
    ];
  }
  const client = new GeminiClient({ apiKey });
  try {
    const out = await client.generateJson<{ ideas: string[] }>({
      prompt: `Extract 4-6 "general ideas" (insights/learnings) from this ad analysis. Each idea is ONE sentence in Spanish (neutral) describing a transferable principle (hook mechanic, visual style, narrative arc, tone, CTA pattern) that someone could reuse to create similar ads. Return JSON.

ANALYSIS:
Editorial line: ${analysis.editorialLine}
Hook: ${analysis.hookType}
Summary: ${analysis.summary}
CTA: ${analysis.cta ?? '(none)'}
Narrator: ${JSON.stringify(analysis.narratorProfile ?? {}).slice(0, 200)}
Scenes (first 3): ${analysis.scenes.slice(0, 3).map((s) => s.visualDescription).join(' | ').slice(0, 600)}

Return: { "ideas": ["idea 1", "idea 2", ...] }`,
      systemInstruction:
        'You are an ad strategy analyst. Extract transferable insights, not literal summaries. Use Spanish neutral. Be concise: 4-6 ideas, each ≤25 words.',
      model: 'gemini-2.5-pro',
    });
    return Array.isArray(out.ideas) ? out.ideas.slice(0, 8) : [];
  } catch {
    return [
      `Línea editorial: ${analysis.editorialLine.slice(0, 100)}`,
      `Hook: ${analysis.hookType}`,
    ];
  }
}

// === Helpers ===========================================================

function makePlaceholderBrand(): BrandConfig {
  // Sólo se usa para el sourceFileName del builder. Los demás campos son
  // suficientes para satisfacer Zod sin importar mucho su valor.
  return {
    id: 'training-placeholder',
    displayName: 'Training Placeholder',
    products: [],
    defaultVoice: {
      voiceId: '00000000',
      modelId: 'eleven_multilingual_v2',
      stability: 0.5,
      similarity: 0.7,
      style: 0.3,
      speakerBoost: true,
      speedMultiplier: 1.0,
      gender: 'neutral',
      ageRange: '30-45',
      label: 'placeholder',
    },
    voiceLibrary: [],
    language: 'es',
    brandColors: [],
    toneRules: { avoid: [], prefer: [] },
    ingredients: {
      mustInclude: [],
      mustAvoid: [],
      colorPalette: [],
      assets: [],
      logoPlacement: 'last-scene',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persiste el estado de la trayectoria + progress en DB. Llamado desde el
 * callback `onIteration` del trainStyle.
 */
export async function persistTrajectory(
  trainingId: string,
  trajectory: TrainingTrajectory,
  progress: number,
  currentStep: string,
): Promise<void> {
  await db
    .update(trainingVideos)
    .set({
      trajectoryJson: JSON.stringify(trajectory),
      progress,
      currentStep,
    })
    .where(eq(trainingVideos.id, trainingId));
}
