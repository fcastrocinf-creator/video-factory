// Pipeline de correcciones: dado un run completado y un mensaje del usuario,
// genera una versión nueva del video con los ajustes pedidos.
//
// Flujo:
//   1. Parsea el mensaje con Gemini → time range + intent + new direction
//   2. Identifica escenas afectadas (intersección por tiempo o índice)
//   3. Copia archivos comunes (audio, subtítulos, escenas no afectadas) al nuevo workDir
//   4. Para cada escena afectada:
//        - asset uploaded (image) → copia como scene_XX.png
//        - asset uploaded (video) → guarda como videoPath (compositor lo usa)
//        - solo prompt → regenera con OpenAI usando prompt modificado
//   5. Re-renderiza final.mp4 con Remotion
//
// El validator NO corre sobre las escenas corregidas: el usuario tomó la decisión
// editorial, no queremos que el modelo la pise.

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createLogger, type BlockContext } from '@video-factory/core';
import {
  SceneTrackSchema,
  SubtitleTrackSchema,
  type AudioTrack,
  type RenderJob,
  type Scene,
  type SceneTrack,
  type SubtitleTrack,
} from '@video-factory/contracts';
import { GeminiClient } from '@video-factory/block-scene-planner';
import {
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
  ImageProviderError,
  type ImageProvider,
} from '@video-factory/block-image-gen-imagen';
import { SceneValidatorV3 } from '@video-factory/block-scene-validator';
import { subtitlesGoogle } from '@video-factory/block-subtitles-google';
import { KlingClient } from '@video-factory/block-video-gen-veo';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';
import { db, runs } from './db';
import { loadBrand, loadPreset } from './brand-preset-loader';
import { outputPathFor, workDirFor } from './paths';

/**
 * Helper: corre N workers en paralelo sobre un queue de items. Mantiene la
 * concurrencia capped en `concurrency`. Usado para regeneración + animación de
 * escenas afectadas.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, idx) => ({ item, idx }));
  async function loop(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      results[next.idx] = await worker(next.item, next.idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => loop()),
  );
  return results;
}

export interface ApplyCorrectionOptions {
  originalRunId: string;
  newRunId: string;
  correctionMessage: string;
  uploadedAssetPath: string | null;
  uploadedAssetIsVideo: boolean;
}

interface CorrectionParse {
  startSec: number;
  endSec: number;
  // Si el mensaje menciona índices de escena directamente (ej "escena 5, 7, 10"),
  // los devolvemos en sceneIndices. Tiene prioridad sobre time range.
  sceneIndices: number[] | null;
  intent: 'regenerate' | 'replace';
  newDirection: string; // breve descripción del cambio (lo que sí se quiere ver)
  // Si true (DEFAULT), mantener composición original (mismo encuadre, personajes,
  // ambiente) y solo aplicar la corrección puntual. Si false, regenerar libre.
  // El hilo del video se preserva a menos que el usuario indique explícitamente
  // que quiere algo radicalmente distinto.
  preserveComposition: boolean;
  reasoning: string;
}

async function updateRun(runId: string, updates: Record<string, unknown>): Promise<void> {
  await db.update(runs).set(updates).where(eq(runs.id, runId));
}

async function parseCorrectionMessage(
  message: string,
  sceneTrack: SceneTrack,
  hasUploadedAsset: boolean,
  uploadedAssetIsVideo: boolean,
): Promise<CorrectionParse> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY no configurada para parsear corrección.');
  const client = new GeminiClient({ apiKey });

  const sceneSummary = sceneTrack.scenes
    .map((s) => `  [${s.index}] ${s.startTimeSeconds.toFixed(1)}-${s.endTimeSeconds.toFixed(1)}s: "${s.text.slice(0, 70)}"`)
    .join('\n');

  const totalDuration = sceneTrack.totalDurationSeconds.toFixed(1);
  const intentHint = hasUploadedAsset
    ? uploadedAssetIsVideo
      ? 'El usuario adjuntó un MP4 — intent debe ser "replace" (lo usaremos como videoPath de las escenas afectadas).'
      : 'El usuario adjuntó una imagen — intent debe ser "replace" (la usaremos como imagePath de las escenas afectadas).'
    : 'No hay archivo adjunto — intent debe ser "regenerate" (regeneramos con un nuevo prompt).';

  const prompt = `El usuario corrigió un video que ya se generó. El video dura ${totalDuration}s y tiene estas escenas:
${sceneSummary}

Mensaje del usuario: "${message}"

${intentHint}

Extrae del mensaje:
- startSec / endSec: rango de tiempo afectado. Si el usuario dice "del segundo 8 al 12" → startSec=8, endSec=12. Si dice "la imagen 5" o "escena 5" → mappear a startTimeSeconds/endTimeSeconds de esa escena. Si no menciona rango ni índice, asume TODO el video (startSec=0, endSec=${totalDuration}).
- sceneIndices: lista de índices si el usuario nombra escenas explícitamente (ej "imagen 5 y 7" → [5, 7]). null si solo dio rango temporal.
- newDirection: descripción CORTA y POSITIVA de lo que se quiere ver (no lo que está mal). Ej: "una mujer con expresión natural sin tantos detalles abstractos". Máx 150 caracteres.
- preserveComposition: TRUE por DEFAULT (preservar el hilo del video). FALSE solo si el usuario pide un cambio RADICAL/ESTRUCTURAL de la escena.
   * preserveComposition=TRUE cuando: el usuario reporta un DEFECTO PUNTUAL (mano con 4 dedos, ojo distorsionado, texto roto, anatomía incorrecta, color raro, expresión equivocada) o pide un AJUSTE MENOR (más cálido, más luminoso, menos abstracto, sin elementos x).
   * preserveComposition=FALSE solo cuando: el usuario pide REEMPLAZAR la escena por una completamente distinta (otro personaje, otra ubicación, otro objeto), o sube un asset propio.
   * Ejemplos:
     - "le falta un dedo en la mano" → TRUE (defecto puntual)
     - "el texto se ve mal" → TRUE (defecto puntual)
     - "más realista, sin tantas líneas" → TRUE (ajuste de estilo)
     - "cambia por una mujer en una cocina" → FALSE (cambio radical)
     - "ponme un paisaje en vez de la persona" → FALSE (cambio radical)
- reasoning: en una oración por qué interpretaste así.

Responde EXCLUSIVAMENTE este JSON:
{
  "startSec": <number>,
  "endSec": <number>,
  "sceneIndices": <integer[] | null>,
  "intent": "regenerate" | "replace",
  "newDirection": "<string>",
  "preserveComposition": <bool>,
  "reasoning": "<string>"
}`;

  const raw = await client.generateJson<Partial<CorrectionParse>>({
    prompt,
    model: 'gemini-2.5-flash',
  });
  // Defaults seguros si Gemini omite algún field
  return {
    startSec: raw.startSec ?? 0,
    endSec: raw.endSec ?? sceneTrack.totalDurationSeconds,
    sceneIndices: raw.sceneIndices ?? null,
    intent: raw.intent ?? (hasUploadedAsset ? 'replace' : 'regenerate'),
    newDirection: raw.newDirection ?? message.slice(0, 150),
    // DEFAULT TRUE: el hilo del video se preserva a menos que el usuario indique
    // explícitamente que quiere algo distinto.
    preserveComposition: raw.preserveComposition !== false,
    reasoning: raw.reasoning ?? '',
  };
}

function pickAffectedScenes(sceneTrack: SceneTrack, parse: CorrectionParse): Scene[] {
  // Si el usuario nombró índices explícitos, esos mandan
  if (parse.sceneIndices && parse.sceneIndices.length > 0) {
    const set = new Set(parse.sceneIndices);
    return sceneTrack.scenes.filter((s) => set.has(s.index));
  }
  // Si no, intersectamos por tiempo
  return sceneTrack.scenes.filter(
    (s) => s.startTimeSeconds < parse.endSec && s.endTimeSeconds > parse.startSec,
  );
}

async function loadOriginalSceneTrack(originalWorkDir: string): Promise<SceneTrack> {
  const planPath = resolve(originalWorkDir, 'scene-plan.json');
  if (!existsSync(planPath)) {
    throw new Error(`scene-plan.json no encontrado en ${originalWorkDir}`);
  }
  const content = await readFile(planPath, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`scene-plan.json corrupto en ${originalWorkDir}: ${(e as Error).message}`);
  }
  // En algunos runs, las escenas pueden venir SIN imagePath en el JSON original
  // pero las imágenes EXISTEN en scene_XX.png. Reconciliamos abajo.
  return SceneTrackSchema.parse(raw);
}

async function loadOriginalSubtitles(originalWorkDir: string, language: string): Promise<SubtitleTrack | null> {
  const subPath = resolve(originalWorkDir, 'subtitles.debug.json');
  if (!existsSync(subPath)) {
    // No existe: el caller debe regenerar subs con audio.mp3 (correction-pipeline lo hace).
    return null;
  }
  const content = await readFile(subPath, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`subtitles.debug.json corrupto en ${originalWorkDir}: ${(e as Error).message}`);
  }
  // Validamos con schema en vez de cast ciego — protege contra subs viejos con
  // formato distinto cuando evolucione el schema.
  return SubtitleTrackSchema.parse(raw);
}

export async function applyCorrection(opts: ApplyCorrectionOptions): Promise<void> {
  const { originalRunId, newRunId, correctionMessage, uploadedAssetPath, uploadedAssetIsVideo } =
    opts;
  const logger = createLogger(newRunId);

  try {
    // 1. Cargar run original desde DB
    const originalResult = await db.select().from(runs).where(eq(runs.id, originalRunId)).limit(1);
    const original = originalResult[0];
    if (!original) throw new Error(`Run original ${originalRunId} no encontrado en DB`);
    if (!original.workDir) throw new Error(`Run original sin workDir`);

    const [brand, preset] = await Promise.all([
      loadBrand(original.brandId),
      loadPreset(original.presetId),
    ]);

    const originalWorkDir = original.workDir;
    const newWorkDir = workDirFor(newRunId);
    const outputPath = outputPathFor(newRunId);

    // Defensa en profundidad: el endpoint también hace mkdir, pero si alguien
    // llama applyCorrection() directamente sin pasar por el endpoint, no crashea.
    await mkdir(newWorkDir, { recursive: true });

    await updateRun(newRunId, {
      status: 'running',
      currentStep: 'correction-parsing',
      progress: 10,
      startedAt: new Date(),
    });

    // 2. Cargar scene-track + subtítulos originales
    const originalSceneTrack = await loadOriginalSceneTrack(originalWorkDir);
    const lang = brand.language.split('-')[0] ?? 'es';
    let subtitleTrack = await loadOriginalSubtitles(originalWorkDir, lang);

    // 3. Parsear el mensaje del usuario
    const parsed = await parseCorrectionMessage(
      correctionMessage,
      originalSceneTrack,
      uploadedAssetPath !== null,
      uploadedAssetIsVideo,
    );
    logger.info({ parsed }, 'correction:parsed');

    const affected = pickAffectedScenes(originalSceneTrack, parsed);
    if (affected.length === 0) {
      throw new Error(
        `No se identificaron escenas afectadas por la corrección. Reformula indicando rango de tiempo o número de escena.`,
      );
    }
    const affectedIdxSet = new Set(affected.map((s) => s.index));
    logger.info(
      { affectedIndices: [...affectedIdxSet], intent: parsed.intent, newDirection: parsed.newDirection },
      'correction:scenes_identified',
    );

    await updateRun(newRunId, { currentStep: 'correction-copying-assets', progress: 25 });

    // 4. Copiar audio + COPIAR videos/imágenes de escenas NO afectadas
    const audioSrc = resolve(originalWorkDir, 'audio.mp3');
    const audioDest = resolve(newWorkDir, 'audio.mp3');
    if (!existsSync(audioSrc)) throw new Error(`audio.mp3 no encontrado en ${originalWorkDir}`);
    await copyFile(audioSrc, audioDest);
    // Solo necesitamos confirmar que el audio existe (size > 0).
    const audioStatInfo = await stat(audioSrc);
    if (audioStatInfo.size < 1000) {
      throw new Error(`audio.mp3 del run original está corrupto (${audioStatInfo.size} bytes)`);
    }

    // Construir nuevo sceneTrack copiando archivos del run original.
    // CRÍTICO: las escenas no afectadas que tenían videoPath (Kling-animadas)
    // también deben copiarse — sino el video corregido las re-render como imagen.
    const newScenes: Scene[] = [];
    for (const scene of originalSceneTrack.scenes) {
      const sceneFile = `scene_${String(scene.index).padStart(2, '0')}.png`;
      const newScenePath = resolve(newWorkDir, sceneFile);
      const newVideoPath = resolve(newWorkDir, `scene_${String(scene.index).padStart(2, '0')}.mp4`);
      const origImagePath = resolve(originalWorkDir, sceneFile);
      const origVideoPath = resolve(originalWorkDir, `scene_${String(scene.index).padStart(2, '0')}.mp4`);

      const isAffected = affectedIdxSet.has(scene.index);

      // Copiar imagen original (siempre, sirve de fallback si Kling falla)
      if (existsSync(origImagePath)) {
        await copyFile(origImagePath, newScenePath);
      } else if (!isAffected) {
        logger.warn(
          { sceneIndex: scene.index, expected: origImagePath },
          'correction:original_image_missing',
        );
      }

      // Copiar video original SOLO si NO está afectada (las afectadas se re-animan)
      const hasVideo = !isAffected && existsSync(origVideoPath);
      if (hasVideo) {
        await copyFile(origVideoPath, newVideoPath);
      }

      newScenes.push({
        ...scene,
        imagePath: existsSync(newScenePath) ? newScenePath : undefined,
        videoPath: hasVideo ? newVideoPath : undefined,
      });
    }

    // 5. Procesar escenas afectadas EN PARALELO (pool 3 contra Vertex 1RPM,
    //    Higgsfield primary soporta más). Cada worker:
    //    - Si replace+asset: copia el asset
    //    - Si regenerate: provider chain + validator
    await updateRun(newRunId, { currentStep: 'correction-applying', progress: 50 });

    // Build provider chain UNA VEZ (compartido entre workers)
    const chain: Array<{ provider: ImageProvider; model: string; label: string }> = [];
    const hKid = process.env['HIGGSFIELD_KEY_ID'];
    const hSecret = process.env['HIGGSFIELD_KEY_SECRET'];
    if (hKid && hSecret) {
      chain.push({
        provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
        model: 'flux-pro/kontext/max/text-to-image',
        label: 'higgsfield:flux-pro-kontext',
      });
    }
    const openaiKey = process.env['OPENAI_API_KEY'];
    if (openaiKey && openaiKey !== 'sk_pendiente') {
      chain.push({
        provider: new OpenaiImageProvider({ apiKey: openaiKey, quality: 'medium' }),
        model: 'gpt-image-1',
        label: 'openai:gpt-image-1',
      });
    }
    const gcpProj = process.env['GCP_PROJECT_ID'];
    if (gcpProj) {
      const v = new VertexImagenProvider({ projectId: gcpProj });
      chain.push(
        { provider: v, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
        { provider: v, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
      );
    }
    const googleKey = process.env['GOOGLE_AI_API_KEY'];
    if (googleKey) {
      chain.push({
        provider: new GoogleImagenProvider({ apiKey: googleKey }),
        model: 'imagen-4.0-fast-generate-001',
        label: 'aistudio:fast',
      });
    }

    // Validator V3 instance — corre paralelizado dentro de validate()
    const validator = new SceneValidatorV3();

    type AffectedResult = {
      sceneIndex: number;
      imagePath?: string;
      videoPath?: string;
      imagePrompt: string;
    };

    const applyOne = async (scene: Scene): Promise<AffectedResult> => {
      const sceneFile = `scene_${String(scene.index).padStart(2, '0')}.png`;
      const newScenePath = resolve(newWorkDir, sceneFile);

      // CASE A: usuario subió MP4 → directamente videoPath
      if (parsed.intent === 'replace' && uploadedAssetPath && uploadedAssetIsVideo) {
        const videoDest = resolve(newWorkDir, `scene_${String(scene.index).padStart(2, '0')}.mp4`);
        await copyFile(uploadedAssetPath, videoDest);
        logger.info({ sceneIndex: scene.index, videoDest }, 'correction:asset_replaced_video');
        return {
          sceneIndex: scene.index,
          imagePath: existsSync(newScenePath) ? newScenePath : undefined,
          videoPath: videoDest,
          imagePrompt: scene.imagePrompt,
        };
      }

      // CASE B: usuario subió imagen → copia directa
      if (parsed.intent === 'replace' && uploadedAssetPath && !uploadedAssetIsVideo) {
        await copyFile(uploadedAssetPath, newScenePath);
        logger.info({ sceneIndex: scene.index, newScenePath }, 'correction:asset_replaced_image');
        return {
          sceneIndex: scene.index,
          imagePath: newScenePath,
          videoPath: undefined, // se re-anima en step 5.5 si preset es animated
          imagePrompt: scene.imagePrompt,
        };
      }

      // CASE C: regenerate con provider chain + validator
      const baseStyle = originalSceneTrack.styleBase;
      // PRESERVAR COMPOSICIÓN (default): el imagePrompt original de la escena
      // sirve de ancla. La corrección se INYECTA como instrucción CRITICAL FIX
      // sobre esa base. Resultado: misma composición, encuadre y personajes,
      // pero con el defecto arreglado.
      // CAMBIO RADICAL (preserveComposition=false): construimos un prompt nuevo
      // basado en el newDirection, sin atarse al imagePrompt original.
      const refinedPrompt = parsed.preserveComposition
        ? `${scene.imagePrompt} CRITICAL CORRECTION (preserving exact composition, characters, and framing): ${parsed.newDirection}. Anatomically correct: 5 fingers per hand with thumb visible, 5 toes per foot, symmetric face with two eyes, no gibberish text. Keep the same scene, just fix the issue.`
        : `${baseStyle}. ${parsed.newDirection}. Original context: "${scene.text}". Avoid the issues from the previous version. High quality, anatomically correct (5 fingers per hand, 5 toes per foot), realistic proportions, no gibberish text, no abstract floating elements.`;
      logger.info(
        {
          sceneIndex: scene.index,
          mode: parsed.preserveComposition ? 'preserve-composition' : 'radical-change',
        },
        'correction:prompt_strategy',
      );

      if (chain.length === 0) {
        throw new Error(
          'No hay providers de imagen disponibles. Configurá HIGGSFIELD_*, OPENAI_API_KEY, GCP_PROJECT_ID o GOOGLE_AI_API_KEY en .env.',
        );
      }

      // Hasta 2 intentos: 1 generación + 1 retry si validator detecta defecto.
      const MAX_ATTEMPTS = 2;
      let finalBuf: Buffer | null = null;
      let activePrompt = refinedPrompt;
      let lastValidatorIssues: string[] = [];

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let regeneratedBuf: Buffer | null = null;
        let lastError: Error | null = null;
        for (const step of chain) {
          try {
            regeneratedBuf = await step.provider.generate({
              prompt: activePrompt,
              aspectRatio: '9:16',
              model: step.model,
            });
            logger.info(
              { sceneIndex: scene.index, provider: step.label, attempt },
              'correction:scene_regenerated_provider',
            );
            break;
          } catch (e) {
            lastError = e as Error;
            const provErr = e instanceof ImageProviderError ? e : null;
            if (
              provErr &&
              (provErr.isDailyQuotaExhausted ||
                provErr.isContentRejection ||
                provErr.retryable)
            ) {
              logger.warn(
                {
                  sceneIndex: scene.index,
                  provider: step.label,
                  err: provErr.message.slice(0, 200),
                },
                'correction:provider_skipped',
              );
              continue;
            }
            throw e;
          }
        }
        if (!regeneratedBuf) {
          throw (
            lastError ?? new Error(`Todos los providers fallaron en escena ${scene.index}`)
          );
        }

        // VALIDATOR — estándar operativo. Si detecta defecto, regen con hint.
        if (validator.isAvailable()) {
          try {
            const validation = await validator.validate({
              text: scene.text,
              imagePrompt: activePrompt,
              imageBuffer: regeneratedBuf,
              styleBase: originalSceneTrack.styleBase,
              narratorProfile: originalSceneTrack.narratorProfile,
              fastMode: true,
            });
            if (validation.verdict === 'pass' || attempt >= MAX_ATTEMPTS - 1) {
              finalBuf = regeneratedBuf;
              if (validation.verdict !== 'pass') {
                logger.warn(
                  {
                    sceneIndex: scene.index,
                    score: validation.score,
                    issues: validation.issues.slice(0, 3),
                  },
                  'correction:validator_failed_keeping_anyway',
                );
              }
              break;
            }
            // Validation falló y aún tenemos retry: refinamos el prompt
            lastValidatorIssues = validation.issues;
            const hint = validation.refinementHint ?? validation.issues.slice(0, 2).join(' ');
            activePrompt = `${refinedPrompt} CRITICAL FIX: ${hint}`;
            logger.info(
              { sceneIndex: scene.index, attempt, hint: hint.slice(0, 150) },
              'correction:validator_retry',
            );
          } catch (validatorErr) {
            // Si validator mismo falla (Vertex saturado, etc.), aceptamos la imagen.
            logger.warn(
              { sceneIndex: scene.index, err: (validatorErr as Error).message.slice(0, 200) },
              'correction:validator_error_keeping_image',
            );
            finalBuf = regeneratedBuf;
            break;
          }
        } else {
          finalBuf = regeneratedBuf;
          break;
        }
      }

      if (!finalBuf) {
        throw new Error(
          `Validator rechazó todas las versiones de escena ${scene.index}: ${lastValidatorIssues.slice(0, 2).join('; ')}`,
        );
      }

      await writeFile(newScenePath, finalBuf);
      logger.info(
        { sceneIndex: scene.index, refinedPrompt: refinedPrompt.slice(0, 120) },
        'correction:scene_regenerated',
      );
      return {
        sceneIndex: scene.index,
        imagePath: newScenePath,
        videoPath: undefined, // se re-anima si preset es animated
        imagePrompt: activePrompt,
      };
    };

    // Pool 3 paralelo: Higgsfield acepta ~5, Vertex 1 RPM en cuentas nuevas. 3
    // es el sweet spot para no saturar ninguno.
    const regenResults = await runWithConcurrency(affected, 3, applyOne);

    // Mergear resultados en newScenes
    for (const res of regenResults) {
      const idx = newScenes.findIndex((s) => s.index === res.sceneIndex);
      if (idx >= 0) {
        newScenes[idx] = {
          ...newScenes[idx]!,
          imagePath: res.imagePath ?? newScenes[idx]!.imagePath,
          videoPath: res.videoPath ?? newScenes[idx]!.videoPath,
          imagePrompt: res.imagePrompt,
        };
      }
    }

    // 5.5. Re-animar con Kling EN PARALELO las escenas afectadas que perdieron
    // videoPath (si el preset era animated). Pool 5 paralelo (Kling resource
    // pack típico). KlingClient internamente retry-with-backoff por 1303.
    const wasAnimatedFormat =
      preset.format?.id === 'b-roll-animated' || preset.format?.id === 'voiceover-animated';
    const klingAk = process.env['KLING_ACCESS_KEY'];
    const klingSk = process.env['KLING_SECRET_KEY'];

    if (wasAnimatedFormat && klingAk && klingSk) {
      const kling = new KlingClient({ accessKey: klingAk, secretKey: klingSk });
      const needsAnimation = newScenes.filter(
        (s) => affectedIdxSet.has(s.index) && s.imagePath && !s.videoPath,
      );
      if (needsAnimation.length > 0) {
        logger.info(
          { count: needsAnimation.length },
          'correction:re_animating_with_kling',
        );
        await updateRun(newRunId, { currentStep: 'correction-animating', progress: 70 });

        const animateOne = async (scene: Scene): Promise<void> => {
          try {
            const imgBuf = await readFile(scene.imagePath!);
            const motionPrompt = `${scene.imagePrompt.slice(0, 200)}\n\nMotion: subtle natural movement only, gentle camera push-in, no scene changes, same style.`;
            const videoBuffer = await kling.generate({
              prompt: motionPrompt,
              imageBase64: imgBuf.toString('base64'),
              model: 'kling-v2-6',
              mode: 'std',
              duration: '5',
            });
            const videoPath = resolve(
              newWorkDir,
              `scene_${String(scene.index).padStart(2, '0')}.mp4`,
            );
            await writeFile(videoPath, videoBuffer);
            const idx = newScenes.findIndex((s) => s.index === scene.index);
            if (idx >= 0) {
              newScenes[idx] = { ...newScenes[idx]!, videoPath };
            }
            logger.info(
              { sceneIndex: scene.index, bytes: videoBuffer.length },
              'correction:scene_re_animated_kling',
            );
          } catch (e) {
            logger.warn(
              { sceneIndex: scene.index, err: (e as Error).message.slice(0, 200) },
              'correction:re_animate_failed_keeping_image',
            );
          }
        };

        await runWithConcurrency(needsAnimation, 5, animateOne);
      }
    }

    // 5.6. Regenerar subtítulos si el original no los tenía (corrección de runs
    // legacy). Esto asegura que el video corregido SIEMPRE tenga subs.
    if (!subtitleTrack) {
      logger.info({}, 'correction:regenerating_subtitles');
      const tempAudioTrack: AudioTrack = {
        filePath: audioDest,
        durationSeconds: originalSceneTrack.totalDurationSeconds,
        sampleRate: 44100,
        channels: 1,
        format: 'mp3',
        segments: originalSceneTrack.scenes.map((s) => ({
          text: s.text,
          startTimeSeconds: s.startTimeSeconds,
          endTimeSeconds: s.endTimeSeconds,
        })),
      };
      const subCtx: BlockContext = {
        runId: newRunId,
        workDir: newWorkDir,
        logger,
        brand,
        preset,
      };
      const subsResult = await subtitlesGoogle.run(tempAudioTrack, subCtx);
      if (subsResult.isErr()) {
        logger.warn(
          { err: subsResult.error.message.slice(0, 200) },
          'correction:subs_regen_failed_using_empty',
        );
        subtitleTrack = { language: lang, lines: [], words: [] };
      } else {
        subtitleTrack = subsResult.value;
        await writeFile(
          resolve(newWorkDir, 'subtitles.debug.json'),
          JSON.stringify(subtitleTrack, null, 2),
        );
      }
    }

    // 6. Persistir el nuevo scene-plan.json (útil para futuras correcciones recursivas)
    const newSceneTrack: SceneTrack = {
      ...originalSceneTrack,
      scenes: newScenes,
    };
    await writeFile(
      resolve(newWorkDir, 'scene-plan.json'),
      JSON.stringify(newSceneTrack, null, 2),
    );

    // 7. Re-render con Remotion
    await updateRun(newRunId, { currentStep: 'compositor-remotion', progress: 80 });

    const audioTrack: AudioTrack = {
      filePath: audioDest,
      durationSeconds: originalSceneTrack.totalDurationSeconds,
      sampleRate: 44100,
      channels: 1,
      format: 'mp3',
      segments: originalSceneTrack.scenes.map((s) => ({
        text: s.text,
        startTimeSeconds: s.startTimeSeconds,
        endTimeSeconds: s.endTimeSeconds,
      })),
    };

    const renderJob: RenderJob = {
      runId: newRunId,
      brandId: original.brandId,
      presetId: original.presetId,
      parsedScript: {
        segments: originalSceneTrack.scenes.map((s) => ({
          text: s.text,
          pauseAfterMs: 0,
          emphasisWords: [],
        })),
        language: lang,
        estimatedDurationSeconds: originalSceneTrack.totalDurationSeconds,
        narratorProfile: originalSceneTrack.narratorProfile,
      },
      audioTrack,
      subtitleTrack,
      imagePath: newScenes[0]?.imagePath ?? '',
      sceneTrack: newSceneTrack,
      // Si el preset original era animated, propagamos el flag al re-render
      animatedScenes:
        preset.format?.id === 'b-roll-animated' || preset.format?.id === 'voiceover-animated',
      outputPath,
      resolution: [1080, 1920],
      fps: 30,
      status: 'pending',
    };

    const ctx: BlockContext = {
      runId: newRunId,
      workDir: newWorkDir,
      logger,
      brand,
      preset,
      onBlockProgress: (subPct) => {
        const globalPct = Math.min(99, 80 + Math.round(subPct * 0.19));
        void updateRun(newRunId, { progress: globalPct }).catch(() => {});
      },
    };

    const renderResult = await compositorRemotion.run(renderJob, ctx);
    if (renderResult.isErr()) throw renderResult.error;

    await updateRun(newRunId, {
      status: 'completed',
      currentStep: null,
      progress: 100,
      outputPath,
      durationSeconds: audioTrack.durationSeconds,
      completedAt: new Date(),
    });

    logger.info({ originalRunId, newRunId, outputPath }, 'correction:completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ originalRunId, newRunId, error: message }, 'correction:failed');
    await updateRun(newRunId, {
      status: 'failed',
      errorMessage: `Corrección falló: ${message}`,
      completedAt: new Date(),
    });
  }

}
