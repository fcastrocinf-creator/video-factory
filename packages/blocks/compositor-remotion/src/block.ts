import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import { RenderJobSchema, type RenderJob } from '@video-factory/contracts';
import { renderPlanoFijo } from './render.js';
import { durationToFrames } from './utils.js';

export class CompositorRemotionBlock implements Block<RenderJob, RenderJob> {
  readonly name = 'compositor-remotion';
  readonly version = '1.0.0';
  readonly description =
    'Compone audio + imagen + subtítulos word-level con Ken Burns y renderiza MP4 1080×1920 30fps H.264.';

  validateInput(input: unknown): Result<RenderJob, Error> {
    const parsed = RenderJobSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`RenderJob inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: RenderJob, ctx: BlockContext): Promise<Result<RenderJob, BlockError>> {
    if (!ctx.preset) {
      return err(
        new BlockError(
          this.name,
          'MISSING_PRESET',
          'BlockContext sin preset. compositor-remotion necesita preset.subtitles y preset.composition.',
          false,
        ),
      );
    }

    const fps = input.fps;
    const [width, height] = input.resolution;
    const durationInFrames = durationToFrames(input.audioTrack.durationSeconds, fps);

    await mkdir(dirname(input.outputPath), { recursive: true });

    // Los paths usados en la composición son relativos al workDir (publicDir de Remotion).
    const audioSrc = basename(input.audioTrack.filePath);
    const imageSrc = basename(input.imagePath);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        outputPath: input.outputPath,
        durationInFrames,
        fps,
        width,
        height,
        audioSrc,
        imageSrc,
      },
      'compositor-remotion:render_start',
    );

    const startedAt = new Date().toISOString();

    try {
      await renderPlanoFijo({
        outputPath: input.outputPath,
        workDir: ctx.workDir,
        durationInFrames,
        fps,
        width,
        height,
        inputProps: {
          audioSrc,
          imageSrc,
          subtitleTrack: input.subtitleTrack,
          subtitlesConfig: ctx.preset.subtitles,
          composition: ctx.preset.composition,
        },
        onProgress: (progress) => {
          if (Math.round(progress * 100) % 10 === 0) {
            ctx.logger.debug(
              { runId: ctx.runId, block: this.name, progress },
              'compositor-remotion:render_progress',
            );
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new BlockError(
          this.name,
          'RENDER_FAILED',
          `Error renderizando con Remotion: ${message}`,
          false,
          error,
        ),
      );
    }

    const completedAt = new Date().toISOString();

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        outputPath: input.outputPath,
        startedAt,
        completedAt,
      },
      'compositor-remotion:render_done',
    );

    const completed: RenderJob = {
      ...input,
      status: 'completed',
      startedAt: input.startedAt ?? startedAt,
      completedAt,
    };

    return ok(completed);
  }
}

export const compositorRemotion = new CompositorRemotionBlock();
