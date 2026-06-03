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
    const hasSceneTrack = input.sceneTrack && input.sceneTrack.scenes.length > 0;
    const hasVideoTrack = input.videoTrack && input.videoTrack.clips.length > 0;

    const compositionId = hasSceneTrack ? 'PlanoEscenas' : hasVideoTrack ? 'PlanoAnimado' : 'PlanoFijo';
    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        composition: compositionId,
        outputPath: input.outputPath,
        durationInFrames,
        fps,
        width,
        height,
        audioSrc,
        sceneCount: input.sceneTrack?.scenes.length ?? 0,
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
      if (hasSceneTrack && input.sceneTrack) {
        const scenes = input.sceneTrack.scenes
          // Una escena entra al render si tiene imagePath O una composición libre
          // poblada (las escenas freeform pueden no tener imagePath a nivel escena
          // porque sus imágenes viven en los CompositeElement).
          .filter((s) => s.imagePath || (s.composition && s.composition.length > 0))
          .map((s) => {
            // Si la escena es compuesta (split-screen / grid), proyectamos sus
            // sub-paneles a SubScenePanel para que PlanoEscenas los renderee en
            // grid pixel-perfect. Filtramos paneles sin imagePath (no se logró
            // generar el panel — Remotion usará imageSrc como fallback global).
            const subScenes =
              s.compositeLayout && s.compositeLayout !== 'single' && s.subScenes
                ? s.subScenes
                    .filter((sub) => sub.imagePath)
                    .map((sub) => ({
                      panel: sub.panel,
                      imageSrc: basename(sub.imagePath!),
                      textOverlay: sub.textOverlay,
                    }))
                : undefined;
            // Si la escena declaró composite pero NO logramos generar ningún
            // panel, degradamos a 'single' (fallback a imageSrc principal).
            const effectiveLayout =
              subScenes && subScenes.length > 0 ? s.compositeLayout : undefined;
            // COMPOSICIÓN LIBRE: proyectamos cada CompositeElement a su versión
            // visual (paths → basenames). Tiene prioridad sobre compositeLayout.
            const composition =
              s.composition && s.composition.length > 0
                ? s.composition.map((el) => ({
                    id: el.id,
                    kind: el.kind,
                    imageSrc: el.imagePath ? basename(el.imagePath) : undefined,
                    videoSrc: el.videoPath ? basename(el.videoPath) : undefined,
                    text: el.text,
                    // Sin esto el render descarta el color y las captions amarillas
                    // (CapCut) salen blancas en silencio.
                    textColor: el.textColor,
                    rect: el.rect,
                    rotationDeg: el.rotationDeg,
                    opacity: el.opacity,
                    zIndex: el.zIndex,
                    fit: el.fit,
                    cornerRadiusPct: el.cornerRadiusPct,
                    startSeconds: el.startSeconds,
                    endSeconds: el.endSeconds,
                    textOverlay: el.textOverlay,
                    chromaKey: el.chromaKey,
                    annotation: el.annotation,
                  }))
                : undefined;
            // imageSrc principal: si la escena no tiene imagePath (freeform pura),
            // usamos el primer elemento-imagen del composition como fallback.
            const imageSrc = s.imagePath
              ? basename(s.imagePath)
              : composition?.find((e) => e.imageSrc)?.imageSrc ?? '';
            return {
              imageSrc,
              // Si la escena fue animada con Veo, videoSrc apunta al MP4 dentro
              // del workDir. PlanoEscenas usa OffthreadVideo en lugar de Img.
              videoSrc: s.videoPath ? basename(s.videoPath) : undefined,
              // v3.2 #145: si el owner recortó la escena a mano
              // (manualDurationSeconds), respetamos ESO. Sino, la ventana
              // auto-alineada al audio (endTimeSeconds - startTimeSeconds).
              durationSeconds:
                typeof (s as { manualDurationSeconds?: number | null }).manualDurationSeconds === 'number' &&
                (s as { manualDurationSeconds?: number | null }).manualDurationSeconds! > 0
                  ? (s as { manualDurationSeconds?: number }).manualDurationSeconds!
                  : s.endTimeSeconds - s.startTimeSeconds,
              // Pasamos las textOverlays para que Remotion las renderice como capas
              // vectoriales sobre la imagen base (resuelve labels gibberish y
              // calendarios rotos que Imagen 4 no puede generar bien).
              textOverlays: s.textOverlays,
              // Composite scene: cada sub-panel se renderiza en su posición del grid.
              compositeLayout: effectiveLayout,
              subScenes,
              // Composición libre: el motor FreeformComposite la renderiza con
              // prioridad sobre compositeLayout/subScenes.
              composition,
            };
          });
        await renderComposition({
          composition: 'PlanoEscenas',
          outputPath: input.outputPath,
          workDir: ctx.workDir,
          durationInFrames,
          fps,
          width,
          height,
          inputProps: {
            audioSrc,
            scenes,
            subtitleTrack: input.subtitleTrack,
            subtitlesConfig: ctx.preset.subtitles,
            animatedScenes: input.animatedScenes ?? false,
            kenBurns: input.kenBurns ?? false,
          },
          onProgress,
        });
      } else if (hasVideoTrack && input.videoTrack) {
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
