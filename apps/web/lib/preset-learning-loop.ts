// preset-learning-loop.ts — M7-B v2 verdadero
//
// LOOP ITERATIVO de auto-aprendizaje de presets desde un video original:
//
//   1) understandVideo(video) → preset v1 (promptTemplate inicial)
//   2) Extraer 1 keyframe representativo del original (frame al midpoint)
//   3) Generar imagen de prueba usando preset.promptTemplate
//   4) compareImagesWithVision(keyframe, imagen-test) → score 0-100 + hint
//   5) Si score >= targetScore → APROBADO, persistir preset final
//   6) Si score < targetScore → pedir a Claude que refine promptTemplate con el hint
//      → volver a paso 3 (max N iteraciones)
//   7) Si agota iteraciones → devolver mejor preset visto + flag exhausted
//
// Es la pieza que el owner pidió: "el sistema aprende los prompts hasta lograr
// coincidencia muy similar, idealmente 100%, y se puede usar para siguientes videos".
//
// Costo por loop (3 iters): ~$0.30-0.80 (1 video-understand + 3 image-gen +
// 3 image-compare + 3 prompt-refine). Tiempo: ~60-180s.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PresetConfig } from '@video-factory/contracts';
import { unifiedJudge } from './unified-judge';
import { z } from 'zod';
import { extractKeyframes } from './frame-extractor';
import {
  buildImageProviderChain,
  generateImageWithReference,
  compareImagesWithVision,
  pickCleanestFrameIndex,
} from './image-gen-tools';
import { autoLearnPresetFromVideo } from './auto-learn-preset';
import { logSystemEvent } from './system-log';

export interface PresetLearningLoopOptions {
  videoPath: string;
  /** Display name del preset auto-aprendido */
  displayNameOverride?: string;
  /** Score mínimo aceptable para aprobar el preset. Default 80. */
  targetScore?: number;
  /** Máximo de iteraciones de refinement. Default 3. */
  maxIterations?: number;
  /** Si true, persistir cada iteración intermedia para auditoría. Default false. */
  persistIntermediates?: boolean;
  /** Modelo Claude para understand + refine. Default 'claude-haiku-4-5'. */
  model?: string;
}

export interface IterationResult {
  iteration: number;
  promptTemplate: string;
  score: number;
  details: {
    palette: number;
    composition: number;
    character: number;
    mood: number;
  };
  hint: string;
  testImagePath: string;
}

export interface PresetLearningLoopResult {
  /** El preset final (aprobado o el mejor visto si exhausted) */
  preset: PresetConfig;
  presetFilePath: string;
  /** Score final que logró (puede ser < target si exhausted) */
  finalScore: number;
  approved: boolean;
  exhausted: boolean;
  iterationsRun: number;
  iterations: IterationResult[];
  keyframeReferencePath: string;
  elapsedSec: number;
}

const REFINER_SYSTEM = `Sos un director de arte experto en image generation con IA. Tu tarea: REFINAR un promptTemplate para que la imagen generada se acerque MÁS al estilo visual de una imagen de referencia.

Recibís:
- El promptTemplate actual (que produjo una imagen con score X)
- El hint del comparador (qué falló: palette, composition, character, mood)
- Los sub-scores del comparador (palette/composition/character/mood individuales)

Tu objetivo: devolver un NUEVO promptTemplate que ataque los puntos débiles SIN romper los puntos fuertes. Estrategias:
  • Si palette score bajo → agregar hex codes / nombres de colores específicos
  • Si composition score bajo → describir encuadre, framing, point of view
  • Si character score bajo → describir mejor sujeto (edad, vestuario, expresión)
  • Si mood score bajo → describir lighting, contraste, mood word ("serene", "tense", "dramatic")
  • También considerá agregar el medium visual (oil painting, 3D render, photoreal, watercolor, vintage comic, etc.) y época/influencia si no estaba explícito

REGLAS:
1. El nuevo promptTemplate debe seguir siendo GENÉRICO (aplicable a cualquier escena del ad, no a una específica). Es un TEMPLATE.
2. Mantener entre 40-120 palabras. Demasiado largo confunde al image generator.
3. NO usar palabras prohibidas: "doctor", "clinic", "medical", "child", "young", "kid", "naked", "blood".
4. Terminar con "CLEAN background, NO text overlay, NO burned-in text — text rendering is done in post-production."

Devolvé EXCLUSIVAMENTE JSON sin markdown:

{
  "refinedPromptTemplate": "<el nuevo prompt template>",
  "reasoning": "<1-2 oraciones explicando qué cambiaste y por qué>"
}`;

const RefinerOutputSchema = z.object({
  refinedPromptTemplate: z.string().min(40).max(800),
  reasoning: z.string().min(10).max(500),
});

interface PromptRefinerInput {
  currentPromptTemplate: string;
  hint: string;
  details: IterationResult['details'];
  overallScore: number;
}

async function refinePromptTemplate(input: PromptRefinerInput): Promise<{
  refinedPromptTemplate: string;
  reasoning: string;
}> {
  const userMsg = `PROMPT TEMPLATE ACTUAL:
"""
${input.currentPromptTemplate}
"""

SCORE GENERAL: ${input.overallScore}/100

SUB-SCORES:
  - palette:     ${input.details.palette}/100
  - composition: ${input.details.composition}/100
  - character:   ${input.details.character}/100
  - mood:        ${input.details.mood}/100

HINT DEL COMPARADOR:
${input.hint}

Refinar el promptTemplate para subir el score. Atacá los sub-scores más bajos.`;

  const result = await unifiedJudge({
    roleSystemPrompt: REFINER_SYSTEM,
    userContent: userMsg,
    schema: RefinerOutputSchema,
    temperature: 0.3, // un poco de variedad para refinement creativo
    maxTokens: 1024,
  });
  if (result.isErr()) {
    throw new Error(
      `Prompt refiner falló (${result.error.type}): ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * Loop iterativo principal. Devuelve el preset aprobado + métricas.
 */
export async function runPresetLearningLoop(
  opts: PresetLearningLoopOptions,
): Promise<PresetLearningLoopResult> {
  const t0 = Date.now();
  const targetScore = opts.targetScore ?? 80;
  const maxIterations = opts.maxIterations ?? 3;

  // PASO 0: generar preset v1 con auto-learn-preset (one-shot)
  const v1 = await autoLearnPresetFromVideo({
    videoPath: opts.videoPath,
    displayNameOverride: opts.displayNameOverride,
    model: opts.model,
  });
  let preset = v1.preset;

  // PASO 1: extraer UN keyframe representativo del video (midpoint)
  const keyframeDir = `${opts.videoPath}.iterloop-keyframes`;
  await mkdir(keyframeDir, { recursive: true });
  const keyframes = await extractKeyframes({
    videoPath: opts.videoPath,
    outputDir: keyframeDir,
    count: 6, // más frames para poder ELEGIR el más limpio como referencia
    widthPx: 720,
  });
  if (keyframes.length === 0) {
    throw new Error('No se pudo extraer keyframe para referencia visual');
  }
  // Elegimos el frame más LIMPIO (sin overlay de texto/UI/mockup de redes) como
  // referencia de estilo. Antes se tomaba ciegamente el del medio — que en ads
  // con mockup de Instagram caía justo en el frame con el texto quemado. Fallback
  // seguro al del medio si el selector no está disponible.
  const cleanIdx = await pickCleanestFrameIndex(keyframes.map((k) => k.filePath));
  const referenceKeyframe = keyframes[cleanIdx] ?? keyframes[Math.floor(keyframes.length / 2)]!;
  // Buffer de la referencia para anclar la generación (image-to-image / Nano Banana).
  const referenceBuffer = await readFile(referenceKeyframe.filePath);

  // PASO 2: loop iterativo de generar → comparar → refinar
  const iterations: IterationResult[] = [];
  let bestIteration: IterationResult | null = null;
  let currentPromptTemplate = preset.visualStyle.promptTemplate;
  const providerChain = buildImageProviderChain();

  // ROBUSTNESS: cada iteración va en su propio try/catch. Si una iter falla
  // (provider de imagen agotó quota, compare timeout, refine schema mismatch),
  // NO perdemos el progreso hecho — rompemos el loop y persistimos el mejor
  // bestIteration visto hasta ese momento. El caller recibe `approved=false`
  // + `exhausted=true` con el preset v1 (o el mejor refinement parcial).
  let loopAbortedEarly = false;
  let abortReason: string | null = null;
  for (let iter = 1; iter <= maxIterations; iter++) {
    try {
      // 2a. Generar imagen de prueba con el promptTemplate actual.
      // Usamos un prompt genérico tipo "the scene depicted" porque queremos
      // testear el STYLE template, no contenido específico.
      const testPromptForGen =
        currentPromptTemplate +
        '\n\nScene content: a representative establishing shot capturing the overall mood and subject of the ad.';
      // Generamos ANCLANDO a la imagen de referencia (Nano Banana image-to-image):
      // fija paleta/iluminación/medium al original — el fix #1 del drift de paleta.
      // Si Nano Banana no está disponible o falla, cae al chain texto-only.
      const gen = await generateImageWithReference(testPromptForGen, referenceBuffer, providerChain);
      const testImagePath = resolve(
        keyframeDir,
        `test_iter${String(iter).padStart(2, '0')}.png`,
      );
      await writeFile(testImagePath, gen.buffer);

      // 2b. Comparar imagen generada contra keyframe del original
      const compare = await compareImagesWithVision(referenceKeyframe.filePath, gen.buffer);

      const iterResult: IterationResult = {
        iteration: iter,
        promptTemplate: currentPromptTemplate,
        score: compare.score,
        details: compare.details,
        hint: compare.hint,
        testImagePath,
      };
      iterations.push(iterResult);
      if (!bestIteration || iterResult.score > bestIteration.score) {
        bestIteration = iterResult;
      }

      // 2c. Decisión: aprobar, exhausted o seguir
      if (iterResult.score >= targetScore) {
        // APROBADO. Actualizar preset con el promptTemplate que funcionó.
        preset = { ...preset, visualStyle: { ...preset.visualStyle, promptTemplate: currentPromptTemplate } };
        break;
      }
      if (iter === maxIterations) {
        // EXHAUSTED tras agotar iteraciones. Volvemos al mejor visto.
        preset = {
          ...preset,
          visualStyle: { ...preset.visualStyle, promptTemplate: bestIteration.promptTemplate },
        };
        break;
      }

      // 2d. Refinar promptTemplate con Claude usando el hint
      const refined = await refinePromptTemplate({
        currentPromptTemplate,
        hint: compare.hint,
        details: compare.details,
        overallScore: compare.score,
      });
      currentPromptTemplate = refined.refinedPromptTemplate;
    } catch (iterErr) {
      // Una iteración falló. Rompemos el loop y devolvemos el mejor visto.
      loopAbortedEarly = true;
      abortReason = (iterErr as Error).message.slice(0, 300);
      // eslint-disable-next-line no-console
      console.warn(`[preset-learning-loop] iter ${iter} falló — abortando loop: ${abortReason}`);
      // Si hay al menos un bestIteration previo, aplicarlo al preset
      if (bestIteration) {
        preset = {
          ...preset,
          visualStyle: { ...preset.visualStyle, promptTemplate: bestIteration.promptTemplate },
        };
      }
      break;
    }
  }

  const finalScore = bestIteration?.score ?? 0;
  const approved = finalScore >= targetScore;
  const exhausted = !approved;
  // Update timestamps en el preset persistido
  preset = { ...preset, updatedAt: new Date().toISOString() };

  // PASO 3: persistir el preset final (sobreescribiendo el v1 inicial)
  // El path ya está calculado en v1.presetFilePath
  await writeFile(v1.presetFilePath, JSON.stringify(preset, null, 2), 'utf-8');

  // Persistir reporte de iteraciones al lado del preset para auditoría
  const reportPath = v1.presetFilePath.replace(/\.preset\.json$/, '.iterations.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        videoPath: opts.videoPath,
        targetScore,
        maxIterations,
        approved,
        exhausted,
        finalScore,
        // Si el loop abortó temprano por error de una iter, queda registrado
        // acá para que el owner sepa por qué el preset no llegó al target.
        loopAbortedEarly,
        abortReason,
        iterations: iterations.map((it) => ({
          iteration: it.iteration,
          score: it.score,
          details: it.details,
          hint: it.hint,
          promptTemplate: it.promptTemplate,
          testImagePath: it.testImagePath,
        })),
        keyframeReferencePath: referenceKeyframe.filePath,
      },
      null,
      2,
    ),
    'utf-8',
  );

  // Log al system event log para auditoría histórica
  void logSystemEvent({
    // 'preset-approved' es el kind apropiado: el loop termina con un preset
    // aprobado (si score>=target) o exhausted (mejor esfuerzo). Ambos casos son
    // "el sistema produjo un preset listo para uso/revisión".
    kind: 'preset-approved',
    data: {
      presetId: preset.id,
      videoPath: opts.videoPath,
      approved,
      exhausted,
      finalScore,
      iterationsRun: iterations.length,
      targetScore,
    },
    summary: `Preset auto-aprendido CON LOOP "${preset.displayName}" — score final ${finalScore}/100 ${approved ? 'APROBADO' : 'exhausted (mejor esfuerzo)'} en ${iterations.length} iter(es)`,
  });

  return {
    preset,
    presetFilePath: v1.presetFilePath,
    finalScore,
    approved,
    exhausted,
    iterationsRun: iterations.length,
    iterations,
    keyframeReferencePath: referenceKeyframe.filePath,
    elapsedSec: (Date.now() - t0) / 1000,
  };
}
