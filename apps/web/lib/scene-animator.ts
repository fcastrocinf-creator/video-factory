// Scene animator: convierte cada imagen estática de una escena en un clip MP4
// animado usando Veo 3 (image-to-video). Da animación REAL: el personaje
// respira, parpadea, la cámara hace push-in real, los elementos se mueven.
//
// Usa Veo image-to-video con la imagen generada como keyframe. Esto preserva
// composición y character continuity entre escenas. El motion prompt se deriva
// del scene.imagePrompt para que la animación sea coherente con la escena.
//
// Concurrencia: Veo Lite tarda ~30-90s por clip. Con concurrency=4 paralelos,
// 30 escenas tardan ~5-15 min. Costo: ~$0.10-0.40 por clip = ~$3-12 por video.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scene, SceneTrack } from '@video-factory/contracts';
import {
  KlingClient,
  type KlingModel,
  VeoClient,
  type VeoModel,
} from '@video-factory/block-video-gen-veo';

// Logger mínimo compatible con pino — usamos shape duck-typed para evitar la
// dependencia directa (pino no está en deps de web; el caller pasa el suyo).
interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface AnimateScenesOptions {
  sceneTrack: SceneTrack;
  workDir: string;
  // Veo API key (AI Studio o Vertex) — usado SOLO como fallback si Kling falla.
  veoApiKey: string;
  // Kling credentials — si están seteadas, Kling es PRIMARY (mejor velocidad +
  // mayor concurrencia que Vertex Veo). Si no están, se usa Veo directo.
  klingAccessKey?: string;
  klingSecretKey?: string;
  klingModel?: KlingModel;
  klingMode?: 'std' | 'pro';
  klingDuration?: '5' | '10';
  concurrency?: number;
  model?: VeoModel;
  durationSeconds?: number;
  skipMissingImages?: boolean;
  logger?: MinimalLogger;
  onProgress?: (done: number, total: number, currentSceneIndex?: number) => void;
}

/**
 * Genera un motion prompt para image-to-video derivado del imagePrompt + text
 * de la escena. Le decimos a Veo que mantenga la composición y agregue micro-
 * movimientos naturales — NO escenas distintas ni transiciones bruscas.
 */
function buildMotionPrompt(scene: Scene): string {
  // El text de la escena es lo que se narra (puede ser un fragmento). Lo usamos
  // como contexto emocional; el imagePrompt es la descripción visual ancla.
  const visualBase = scene.imagePrompt.slice(0, 280);
  return `${visualBase}

Motion direction for this 8-second clip: subtle natural movement only — keep the SAME composition, SAME characters, SAME location as the input keyframe image. The character (if visible) breathes, blinks occasionally, and makes micro head/hand movements consistent with the narrated emotion. The camera holds steady with a very gentle push-in (5-8% zoom) and barely-perceptible drift. No cuts, no scene changes, no new characters appearing. The lighting and color palette match the input image exactly. Treat the input image as the FIRST FRAME and animate FROM it.`;
}

/**
 * Anima una escena: trata Kling primero (si está configurado) y cae a Veo.
 * Si AMBOS fallan, devuelve la Scene sin videoPath (Remotion usa imagen estática).
 */
async function animateScene(
  scene: Scene,
  kling: KlingClient | null,
  klingModel: KlingModel,
  klingMode: 'std' | 'pro',
  klingDuration: '5' | '10',
  veo: VeoClient,
  workDir: string,
  durationSeconds: number,
  veoModel: VeoModel,
  logger?: MinimalLogger,
): Promise<Scene> {
  if (!scene.imagePath || !existsSync(scene.imagePath)) {
    logger?.warn(
      { sceneIndex: scene.index, imagePath: scene.imagePath },
      'scene-animator:skipping_missing_image',
    );
    return scene;
  }

  const imageBuffer = await readFile(scene.imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const motionPrompt = buildMotionPrompt(scene);
  const videoFile = `scene_${String(scene.index).padStart(2, '0')}.mp4`;
  const videoPath = resolve(workDir, videoFile);

  // PRIMARY: Kling AI image-to-video (más rápido, más concurrencia, mejor calidad)
  if (kling) {
    const startKling = Date.now();
    try {
      const videoBuffer = await kling.generate({
        prompt: motionPrompt,
        imageBase64,
        aspectRatio: '9:16',
        model: klingModel,
        mode: klingMode,
        duration: klingDuration,
      });
      await writeFile(videoPath, videoBuffer);
      logger?.info(
        {
          sceneIndex: scene.index,
          provider: 'kling',
          model: klingModel,
          bytes: videoBuffer.length,
          elapsedSec: ((Date.now() - startKling) / 1000).toFixed(1),
        },
        'scene-animator:scene_animated_kling',
      );
      return { ...scene, videoPath };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger?.warn(
        { sceneIndex: scene.index, provider: 'kling', err: message.slice(0, 200) },
        'scene-animator:kling_failed_trying_veo',
      );
      // sigue a Veo
    }
  }

  // FALLBACK: Vertex Veo (slower but reliable)
  const startVeo = Date.now();
  try {
    const videoBuffer = await veo.generate({
      prompt: motionPrompt,
      imageBase64,
      imageMimeType: 'image/png',
      aspectRatio: '9:16',
      durationSeconds,
      model: veoModel,
    });
    await writeFile(videoPath, videoBuffer);
    logger?.info(
      {
        sceneIndex: scene.index,
        provider: 'veo',
        bytes: videoBuffer.length,
        elapsedSec: ((Date.now() - startVeo) / 1000).toFixed(1),
      },
      'scene-animator:scene_animated_veo',
    );
    return { ...scene, videoPath };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger?.warn(
      { sceneIndex: scene.index, provider: 'veo', err: message.slice(0, 200) },
      'scene-animator:both_failed_keeping_static',
    );
    return scene;
  }
}

/**
 * Anima TODO el SceneTrack en paralelo con concurrencia controlada.
 * Devuelve un SceneTrack nuevo donde cada Scene tiene videoPath setado (si la
 * animación tuvo éxito) o el imagePath original (si falló — fallback graceful).
 */
export async function animateScenes(opts: AnimateScenesOptions): Promise<SceneTrack> {
  const veo = new VeoClient({ apiKey: opts.veoApiKey });
  const kling =
    opts.klingAccessKey && opts.klingSecretKey
      ? new KlingClient({
          accessKey: opts.klingAccessKey,
          secretKey: opts.klingSecretKey,
        })
      : null;
  const klingModel: KlingModel = opts.klingModel ?? 'kling-v2-6';
  const klingMode = opts.klingMode ?? 'std';
  const klingDuration = opts.klingDuration ?? '5';

  // CONCURRENCY 5 CON KLING: el resource pack típico del usuario permite 5
  // tasks paralelos (code 1303 si pasamos). El KlingClient internamente
  // retry-with-backoff cualquier 1303 residual, pero a nivel pool mantenemos
  // 5 para que la mayoría entren directo sin esperar. Sin Kling, Veo permite 4.
  const defaultConcurrency = kling ? 5 : 4;
  const concurrency = Math.max(1, opts.concurrency ?? defaultConcurrency);
  const durationSeconds = opts.durationSeconds ?? 8;
  const veoModel = opts.model ?? 'veo-3.1-lite-generate-preview';

  const total = opts.sceneTrack.scenes.length;
  let done = 0;
  const results: Scene[] = new Array(total);
  const queue = opts.sceneTrack.scenes.map((s, i) => ({ scene: s, originalIdx: i }));

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const animated = await animateScene(
        item.scene,
        kling,
        klingModel,
        klingMode,
        klingDuration,
        veo,
        opts.workDir,
        durationSeconds,
        veoModel,
        opts.logger,
      );
      results[item.originalIdx] = animated;
      done += 1;
      opts.onProgress?.(done, total, item.scene.index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));

  return {
    ...opts.sceneTrack,
    scenes: results,
  };
}
