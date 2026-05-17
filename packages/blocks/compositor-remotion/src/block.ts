import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import { RenderJobSchema, type RenderJob } from '@video-factory/contracts';
import { renderComposition } from './render.js';
import { durationToFrames } from './utils.js';

export class CompositorRemotionBlock implements Block<RenderJob, RenderJob> {
  readonly name = 'compositor-remotion';
  readonly version = '1.1.0';
  readonly description =
    'Compone audio + (video animado o imagen estática) + subtítulos word-level. Renderiza MP4 1080×1920 30fps H.264.';

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

    const audioSrc = basename(input.audioTrack.filePath);
    const hasVideoTrack = input.videoTrack && input.videoTrack.clips.length > 0;

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        composition: hasVideoTrack ? 'PlanoAnimado' : 'PlanoFijo',
        outputPath: input.outputPath,
        durationInFrames,
        fps,
        width,
        height,
        audioSrc,
        videoClipCount: input.videoTrack?.clips.length ?? 0,
      },
      'compositor-remotion:render_start',
    );

    const startedAt = new Date().toISOString();

    let lastReportedPct = -1;
    const onProgress = (progress: number) => {
      const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
      if (pct < lastReportedPct + 2 && pct !== 100) return;
      lastReportedPct = pct;
      ctx.onBlockProgress?.(pct);
      ctx.logger.debug(
        { runId: ctx.runId, block: this.name, pct },
        'compositor-remotion:render_progress',
      );
    };

    try {
      if (hasVideoTrack && input.videoTrack) {
        const videoClipSrcs = input.videoTrack.clips.map((c) => basename(c.filePath));
        const videoClipDurations = input.videoTrack.clips.map((c) => c.durationSeconds);

        await renderComposition({
          composition: 'PlanoAnimado',
          outputPath: input.outputPath,
          workDir: ctx.workDir,
          durationInFrames,
          fps,
          width,
          height,
          inputProps: {
            audioSrc,
            videoClipSrcs,
            videoClipDurations,
            subtitleTrack: input.subtitleTrack,
            subtitlesConfig: ctx.preset.subtitles,
          },
          onProgress,
        });
      } else {
        const imageSrc = basename(input.imagePath);
        await renderComposition({
          composition: 'PlanoFijo',
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
          onProgress,
        });
      }
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
