// regenerate-single-scene.ts — M6 v2: ejecutor real de regenerate-scene action.
//
// Cuando el editor IA emite action.type === 'regenerate-scene', el pipeline
// ya no puede solo "loguearlo y seguir". Esta función EJECUTA la regeneración:
//   1. Toma el providerChain configurado en el pipeline
//   2. Llama al primer provider available con el nuevo prompt
//   3. Escribe el PNG al workDir (sobrescribe scene_NN.png)
//   4. Si la scene era animada, re-anima con scene-animator
//   5. Devuelve la scene actualizada
//
// Usa lógica simplificada (1 intento + 1 retry con provider alternativo). NO usa
// el loop de validación del image-gen-multi — el editor IA ya validó y decidió.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Scene } from '@video-factory/contracts';
import {
  type ImageProvider,
  ImageProviderError,
} from '@video-factory/block-image-gen-imagen';
import type { ProviderStep } from '@video-factory/block-image-gen-multi';

export interface RegenerateSingleSceneOptions {
  scene: Scene;
  newPrompt?: string; // si se pasa, se usa en lugar del scene.imagePrompt
  workDir: string;
  providerChain: ProviderStep[];
  /** Si true Y la scene tenía videoPath previo, intenta re-animar con scene-animator. */
  reAnimate?: boolean;
  /** Para re-animar — passa el animator existing. Si no se pasa y reAnimate=true, falla. */
  animator?: {
    animateOne: (input: {
      scene: Scene;
      workDir: string;
    }) => Promise<{ videoPath?: string }>;
  };
}

export interface RegenerateSingleSceneResult {
  updatedScene: Scene;
  imageBuffer: Buffer;
  imagePath: string;
  videoPath?: string;
  providerUsed: string;
  elapsedSec: number;
  errors: string[];
}

/**
 * Regenera UNA escena del run. Sobrescribe el PNG existente.
 * Si reAnimate=true y la scene tenía videoPath, también re-anima.
 *
 * Diseñado para ser invocado por el executor del loop M6 cuando el editor IA
 * pide regenerate-scene. NO incluye validación con Claude (el editor ya validó
 * antes de pedir esta acción).
 */
export async function regenerateSingleScene(
  opts: RegenerateSingleSceneOptions,
): Promise<RegenerateSingleSceneResult> {
  const t0 = Date.now();
  const errors: string[] = [];

  if (opts.providerChain.length === 0) {
    throw new Error('regenerateSingleScene: providerChain vacío');
  }

  const promptToUse = opts.newPrompt ?? opts.scene.imagePrompt;
  let imageBuffer: Buffer | null = null;
  let providerUsed = '';

  // Intentar providers en orden. Si uno falla con retryable=false (quota, etc.)
  // pasamos al siguiente.
  for (const step of opts.providerChain) {
    try {
      imageBuffer = await step.provider.generate({
        prompt: promptToUse,
        aspectRatio: '9:16',
        model: step.model,
      });
      providerUsed = step.label ?? step.provider.name;
      break; // éxito — salir del loop
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`[${step.provider.name}] ${msg.slice(0, 200)}`);
      const isProvErr = e instanceof ImageProviderError;
      if (isProvErr && e.isDailyQuotaExhausted) {
        // Saltar al siguiente provider
        continue;
      }
      if (isProvErr && !e.retryable) {
        continue;
      }
      // Para errors transient (retryable=true), intentamos UNA vez más con
      // el mismo provider antes de pasar
      try {
        await new Promise((r) => setTimeout(r, 1500));
        imageBuffer = await step.provider.generate({
          prompt: promptToUse,
          aspectRatio: '9:16',
          model: step.model,
        });
        providerUsed = step.label ?? step.provider.name;
        break;
      } catch (e2) {
        errors.push(`[${step.provider.name} retry] ${(e2 as Error).message.slice(0, 200)}`);
        continue;
      }
    }
  }

  if (!imageBuffer) {
    throw new Error(
      `regenerateSingleScene: todos los providers fallaron para scene ${opts.scene.index}. Errors: ${errors.join(' | ').slice(0, 500)}`,
    );
  }

  // Sobrescribir el PNG existente — usa misma convención que image-gen-multi
  const imagePath = join(
    opts.workDir,
    `scene_${opts.scene.index.toString().padStart(2, '0')}.png`,
  );
  await writeFile(imagePath, imageBuffer);

  // Actualizar la scene
  const updatedScene: Scene = {
    ...opts.scene,
    imagePath,
    // Si cambiamos el prompt, persistirlo
    imagePrompt: opts.newPrompt ?? opts.scene.imagePrompt,
    // Limpiar videoPath si reAnimate=true — se va a regenerar
    videoPath: opts.reAnimate ? undefined : opts.scene.videoPath,
  };

  let videoPath: string | undefined = opts.scene.videoPath;

  // Re-animar si pidieron y hay animator disponible
  if (opts.reAnimate && opts.scene.videoPath && opts.animator) {
    try {
      const animated = await opts.animator.animateOne({
        scene: updatedScene,
        workDir: opts.workDir,
      });
      videoPath = animated.videoPath;
      updatedScene.videoPath = videoPath;
    } catch (e) {
      errors.push(`[animator] ${(e as Error).message.slice(0, 200)}`);
      // No bloquear — la scene queda como estática
    }
  }

  const elapsedSec = (Date.now() - t0) / 1000;
  return {
    updatedScene,
    imageBuffer,
    imagePath,
    videoPath,
    providerUsed,
    elapsedSec,
    errors,
  };
}
