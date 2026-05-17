import { mkdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createLogger, type BlockContext } from '@video-factory/core';
import type { RenderJob } from '@video-factory/contracts';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { ttsElevenLabs } from '@video-factory/block-tts-elevenlabs';
import { subtitlesWhisper } from '@video-factory/block-subtitles-whisper';
import { imageGenImagen } from '@video-factory/block-image-gen-imagen';
import { compositorRemotion } from '@video-factory/block-compositor-remotion';
import { db, runs } from './db';
import { loadBrand, loadPreset } from './brand-preset-loader';
import { outputPathFor, workDirFor } from './paths';

interface RunUpdate {
  status?: 'pending' | 'running' | 'completed' | 'failed';
  currentStep?: string | null;
  progress?: number;
  outputPath?: string;
  errorMessage?: string;
  durationSeconds?: number;
  startedAt?: Date;
  completedAt?: Date;
}

async function updateRun(runId: string, updates: RunUpdate): Promise<void> {
  await db.update(runs).set(updates).where(eq(runs.id, runId));
}

export async function runPipeline(
  runId: string,
  brandId: string,
  presetId: string,
  scriptText: string,
): Promise<void> {
  const logger = createLogger(runId);
  const workDir = workDirFor(runId);
  const outputPath = outputPathFor(runId);

  try {
    const [brand, preset] = await Promise.all([loadBrand(brandId), loadPreset(presetId)]);

    await mkdir(workDir, { recursive: true });

    const ctx: BlockContext = { runId, workDir, logger, brand, preset };

    await updateRun(runId, {
      status: 'running',
      currentStep: 'script-processor',
      progress: 5,
      workDir,
      startedAt: new Date(),
    } as RunUpdate);

    // B.1
    const scriptInputResult = scriptProcessor.validateInput({
      rawText: scriptText,
      language: brand.language.split('-')[0] ?? 'es',
    });
    if (scriptInputResult.isErr()) {
      throw new Error(`Input inválido: ${scriptInputResult.error.message}`);
    }
    const parsedResult = await scriptProcessor.run(scriptInputResult.value, ctx);
    if (parsedResult.isErr()) throw parsedResult.error;
    const parsedScript = parsedResult.value;

    // B.2
    await updateRun(runId, { currentStep: 'tts-elevenlabs', progress: 20 });
    const audioResult = await ttsElevenLabs.run(parsedScript, ctx);
    if (audioResult.isErr()) throw audioResult.error;
    const audioTrack = audioResult.value;

    // B.3
    await updateRun(runId, { currentStep: 'subtitles-whisper', progress: 45 });
    const subsResult = await subtitlesWhisper.run(audioTrack, ctx);
    if (subsResult.isErr()) throw subsResult.error;
    const subtitleTrack = subsResult.value;

    // B.4
    await updateRun(runId, { currentStep: 'image-gen-imagen', progress: 65 });
    const imageResult = await imageGenImagen.run(parsedScript, ctx);
    if (imageResult.isErr()) throw imageResult.error;
    const imageAsset = imageResult.value;

    // B.5
    await updateRun(runId, { currentStep: 'compositor-remotion', progress: 80 });
    const renderJob: RenderJob = {
      runId,
      brandId,
      presetId,
      parsedScript,
      audioTrack,
      subtitleTrack,
      imagePath: imageAsset.filePath,
      outputPath,
      resolution: [1080, 1920],
      fps: 30,
      status: 'pending',
    };
    const renderResult = await compositorRemotion.run(renderJob, ctx);
    if (renderResult.isErr()) throw renderResult.error;

    await updateRun(runId, {
      status: 'completed',
      currentStep: null,
      progress: 100,
      outputPath,
      durationSeconds: audioTrack.durationSeconds,
      completedAt: new Date(),
    });

    logger.info({ runId, outputPath }, 'pipeline:completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId, error: message }, 'pipeline:failed');
    await updateRun(runId, {
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
    });
  }
}
