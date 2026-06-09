// service.ts — orquestador del Laboratorio de Prompts.
//
// Une todo: construye el objetivo (dual) → busca semilla en la librería →
// corre el bucle (generar con la cascada de imagen, juzgar con el juez compuesto,
// refinar con Claude) → si aprueba, GUARDA el prompt ganador en la librería.
// Persiste la trayectoria iter-por-iter en disco para mostrarla EN VIVO.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promptLabRunDir } from '../paths';
import {
  buildImageProviderChain,
  generateImageWithChain,
  generateImageWithReference,
} from '../image-gen-tools';
import { runVisualRefineLoop } from './refine-loop';
import { compositeJudge } from './composite-judge';
import { refinePromptForLab } from './refiner';
import { buildTargetFromIntention, buildTargetFromReference } from './target';
import { queryBestSeed, recordWinningPrompt, normalizeTargetKey } from './prompt-library';
import type { PromptLabMode, RefineIteration, RubricCriterion, VisualTarget } from './types';

export interface PromptLabTrajectory {
  id: string;
  status: 'running' | 'done' | 'error';
  mode: PromptLabMode;
  intention: string;
  brandId?: string;
  threshold: number;
  rubric: RubricCriterion[];
  basePrompt: string;
  seedUsedId?: string | null;
  iterations: RefineIteration[];
  result?: {
    approved: boolean;
    notVerified: boolean;
    bestPrompt: string;
    bestScore: number;
    bestImageFile?: string;
    stopReason: string;
  };
  savedToLibraryId?: string | null;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

function trajectoryPath(runId: string): string {
  return resolve(promptLabRunDir(runId), 'trajectory.json');
}

export async function readTrajectory(runId: string): Promise<PromptLabTrajectory | null> {
  const p = trajectoryPath(runId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as PromptLabTrajectory;
  } catch {
    return null;
  }
}

async function writeTrajectory(t: PromptLabTrajectory): Promise<void> {
  await mkdir(promptLabRunDir(t.id), { recursive: true });
  await writeFile(trajectoryPath(t.id), JSON.stringify(t, null, 2), 'utf-8');
}

export interface PromptLabInput {
  mode: PromptLabMode;
  intention?: string;
  referenceImagePath?: string;
  brandId?: string;
  threshold?: number;
  maxAttempts?: number;
}

/** Corre el Laboratorio para un objetivo. Pensado para background: void runPromptLab(id, input). */
export async function runPromptLab(runId: string, input: PromptLabInput): Promise<void> {
  const runDir = promptLabRunDir(runId);
  await mkdir(runDir, { recursive: true });

  const traj: PromptLabTrajectory = {
    id: runId,
    status: 'running',
    mode: input.mode,
    intention: input.intention ?? '(referencia)',
    brandId: input.brandId,
    threshold: 0,
    rubric: [],
    basePrompt: '',
    iterations: [],
    startedAt: new Date().toISOString(),
  };
  await writeTrajectory(traj);

  try {
    // 1. Construir objetivo (dual).
    const target: VisualTarget =
      input.mode === 'ripear' && input.referenceImagePath
        ? await buildTargetFromReference({
            referenceImagePath: input.referenceImagePath,
            intention: input.intention,
            brandId: input.brandId,
            threshold: input.threshold,
          })
        : await buildTargetFromIntention({
            intention: input.intention ?? '',
            brandId: input.brandId,
            threshold: input.threshold,
          });

    traj.mode = target.mode;
    traj.intention = target.intention;
    traj.threshold = target.threshold;
    traj.rubric = target.rubric;
    traj.basePrompt = target.basePrompt;
    await writeTrajectory(traj);

    // 2. Semilla en caliente desde la librería (arranque desde lo que YA funcionó).
    const targetKey = normalizeTargetKey(target.intention);
    const seed = await queryBestSeed({ mode: target.mode, targetKey, brandId: target.brandId });
    let basePrompt = target.basePrompt;
    if (seed) {
      basePrompt = seed.prompt;
      traj.seedUsedId = seed.id;
      traj.basePrompt = basePrompt;
      await writeTrajectory(traj);
    }

    // 3. Preparar generación.
    const chain = buildImageProviderChain();
    const referenceBuffer =
      target.referenceImagePath && existsSync(target.referenceImagePath)
        ? await readFile(target.referenceImagePath)
        : null;

    // 4. Correr el bucle generar → juzgar → refinar.
    const result = await runVisualRefineLoop(
      {
        generate: async (prompt, attempt) => {
          const gen = referenceBuffer
            ? await generateImageWithReference(prompt, referenceBuffer, chain, 'recreate')
            : await generateImageWithChain(prompt, chain);
          const file = `iter${String(attempt).padStart(2, '0')}.png`;
          await writeFile(resolve(runDir, file), gen.buffer);
          return { buffer: gen.buffer, imagePath: file };
        },
        judge: async (image) => compositeJudge(target, image),
        refine: async (prompt, verdict) => refinePromptForLab(prompt, verdict, target.mode),
      },
      {
        basePrompt,
        maxAttempts: input.maxAttempts ?? 4,
        onIteration: async (it) => {
          traj.iterations.push(it);
          await writeTrajectory(traj);
        },
      },
    );

    // 5. Persistir resultado + APRENDER si aprobó (guarda el prompt ganador).
    let savedId: string | null = null;
    if (result.approved) {
      savedId = await recordWinningPrompt({
        mode: target.mode,
        targetKey,
        brandId: target.brandId,
        prompt: result.bestPrompt,
        score: result.bestScore,
        byDimension: {},
        attempts: result.iterations.length,
        intention: target.intention,
      });
    }

    traj.result = {
      approved: result.approved,
      notVerified: result.notVerified,
      bestPrompt: result.bestPrompt,
      bestScore: result.bestScore,
      bestImageFile: result.bestImagePath,
      stopReason: result.stopReason,
    };
    traj.savedToLibraryId = savedId;
    traj.status = 'done';
    traj.finishedAt = new Date().toISOString();
    await writeTrajectory(traj);
  } catch (e) {
    traj.status = 'error';
    traj.error = (e as Error).message.slice(0, 500);
    traj.finishedAt = new Date().toISOString();
    await writeTrajectory(traj);
  }
}
