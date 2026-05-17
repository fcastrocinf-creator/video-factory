import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ImageAssetSchema,
  type ImageAsset,
  type VideoClip,
  type VideoTrack,
} from '@video-factory/contracts';
import { VeoApiError, VeoClient, type VeoModel } from './client.js';

export interface VideoGenVeoBlockOptions {
  client?: VeoClient;
  model?: VeoModel;
  // Cuántos clips paralelos de 8s generar para cubrir la duración total.
  // Si no se setea, lo calcula a partir de targetDurationSeconds / 8.
  clipCount?: number;
  // Duración total a cubrir. Default: 8 (un clip que se loopea/extiende en compositor).
  targetDurationSeconds?: number;
  // Prompts adicionales para variar los clips. Si hay menos prompts que clips,
  // se ciclan. Si no hay, se usa el promptTemplate del preset para todos.
  motionPrompts?: string[];
}

export class VideoGenVeoBlock implements Block<ImageAsset, VideoTrack> {
  readonly name = 'video-gen-veo';
  readonly version = '1.0.0';
  readonly description =
    'Genera clips de video animados con Veo 3 usando la imagen de Imagen como referencia para mantener consistencia de personaje.';

  constructor(private readonly options: VideoGenVeoBlockOptions = {}) {}

  validateInput(input: unknown): Result<ImageAsset, Error> {
    const parsed = ImageAssetSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`ImageAsset inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: ImageAsset, ctx: BlockContext): Promise<Result<VideoTrack, BlockError>> {
    if (!ctx.preset) {
      return err(
        new BlockError(
          this.name,
          'MISSING_PRESET',
          'BlockContext sin preset. video-gen-veo necesita preset.visualStyle y preset.visualEngine.',
          false,
        ),
      );
    }

    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    const client = this.options.client ?? (apiKey ? new VeoClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'Falta GOOGLE_AI_API_KEY (la key debe tener acceso a Veo en Generative Language API).',
          false,
        ),
      );
    }

    // Mapeo preset.visualEngine -> modelo Veo concreto.
    const model: VeoModel =
      this.options.model ?? this.resolveModelFromPreset(ctx.preset.visualEngine);

    // Cuántos clips y prompts para cada uno.
    const targetDuration =
      this.options.targetDurationSeconds ?? ctx.preset.defaultDurationSeconds ?? 8;
    const clipCount = this.options.clipCount ?? Math.max(1, Math.ceil(targetDuration / 8));
    const baseDuration = Math.min(8, Math.ceil(targetDuration / clipCount));

    const motionPrompts = this.buildMotionPrompts(
      ctx.preset.visualStyle.promptTemplate,
      clipCount,
      this.options.motionPrompts,
    );

    // Convertir imagen a base64 una sola vez (se reusa en todos los clips).
    const imageBytes = await readFile(input.filePath);
    const imageBase64 = imageBytes.toString('base64');

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        model,
        clipCount,
        clipDurationSeconds: baseDuration,
        targetDurationSeconds: targetDuration,
        referenceImagePath: input.filePath,
      },
      'video-gen-veo:starting',
    );

    await mkdir(ctx.workDir, { recursive: true });

    // Generación paralela: todos los clips usan la MISMA imagen de referencia
    // para mantener consistencia del personaje. Si Veo igual deriva variaciones,
    // la siguiente iteración debería usar scene extension secuencial.
    let completedClips = 0;
    const clipPromises = motionPrompts.map(async (prompt, index) => {
      try {
        const buffer = await client.generate({
          prompt,
          imageBase64,
          imageMimeType: 'image/png',
          aspectRatio: '9:16',
          durationSeconds: baseDuration,
          model,
          onProgress: (pct) => {
            ctx.logger.debug(
              { runId: ctx.runId, clip: index, pct },
              'video-gen-veo:clip_progress',
            );
          },
        });

        const clipPath = join(ctx.workDir, `clip_${index.toString().padStart(2, '0')}.mp4`);
        await writeFile(clipPath, buffer);

        completedClips++;
        const overallPct = Math.round((completedClips / clipCount) * 100);
        ctx.onBlockProgress?.(overallPct);

        ctx.logger.info(
          {
            runId: ctx.runId,
            clip: index,
            path: clipPath,
            bytes: buffer.length,
            completedClips,
            totalClips: clipCount,
          },
          'video-gen-veo:clip_saved',
        );

        const clip: VideoClip = {
          filePath: clipPath,
          durationSeconds: baseDuration,
          prompt,
          startTimeSeconds: index * baseDuration,
          endTimeSeconds: (index + 1) * baseDuration,
        };
        return clip;
      } catch (error) {
        ctx.logger.error(
          { runId: ctx.runId, clip: index, err: error },
          'video-gen-veo:clip_failed',
        );
        throw error;
      }
    });

    let clips: VideoClip[];
    try {
      clips = await Promise.all(clipPromises);
    } catch (error) {
      const retryable = error instanceof VeoApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof VeoApiError ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(
        new BlockError(this.name, code, `Error generando con Veo: ${message}`, retryable, error),
      );
    }

    // Ordenar por startTimeSeconds (por las dudas, aunque Promise.all preserva orden).
    clips.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    const videoTrack: VideoTrack = {
      clips,
      totalDurationSeconds: clips.reduce((acc, c) => acc + c.durationSeconds, 0),
      fps: 30,
      width: 1080,
      height: 1920,
      format: 'mp4',
      engine: this.engineFromModel(model),
      referenceImagePath: input.filePath,
    };

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        clipCount: clips.length,
        totalDurationSeconds: videoTrack.totalDurationSeconds,
      },
      'video-gen-veo:done',
    );

    return ok(videoTrack);
  }

  private resolveModelFromPreset(visualEngine: string): VeoModel {
    if (visualEngine === 'veo-fast') return 'veo-3.1-fast-generate-001';
    if (visualEngine === 'veo-standard') return 'veo-3.1-generate-001';
    return 'veo-3.1-lite-generate-preview';
  }

  private engineFromModel(model: VeoModel): VideoTrack['engine'] {
    if (model.includes('fast')) return 'veo-fast';
    if (model.includes('lite')) return 'veo-lite';
    return 'veo-standard';
  }

  private buildMotionPrompts(
    _basePrompt: string,
    clipCount: number,
    overrides?: string[],
  ): string[] {
    if (overrides && overrides.length > 0) {
      const out: string[] = [];
      for (let i = 0; i < clipCount; i++) {
        out.push(overrides[i % overrides.length]!);
      }
      return out;
    }

    // Prompts SOLO de movimiento. NO concatenamos el preset.promptTemplate porque:
    // 1. La apariencia ya está definida por la imagen de referencia (Imagen 4)
    // 2. Repetir keywords como "doctor", "lab coat", "stethoscope" en el prompt de Veo
    //    activa el safety filter (raiMediaFilteredCount > 0). Verificado empíricamente:
    //    mismo image input + prompt médico → filtered; mismo image input + prompt neutral → OK.
    // Cada string describe sólo qué hace el personaje durante el clip de 8s.
    const motions = [
      'Subtle natural blinking, gentle breathing, slight head movement, soft eye contact with camera, calm and reassuring expression, soft warm lighting',
      'Looking thoughtfully to the side then back to camera, kind warm expression, gentle subtle smile',
      'Small confident nod with friendly expression, soft warm lighting, professional posture',
      'Leaning slightly forward as if speaking warmly, attentive expression, gentle natural movements',
      'Glancing down briefly then looking back up with warm eye contact, calm expression, subtle breathing',
      'Slow head turn from right to left settling on camera, kind reassuring expression',
      'Serene contemplative pause, soft natural lighting catching the eyes, gentle breathing',
      'Subtle hand gesture entering frame then steady neutral position, calm composed expression',
      'Attentive listening pose with gentle nod, eyes steady on camera, kind expression',
    ];

    const prompts: string[] = [];
    for (let i = 0; i < clipCount; i++) {
      prompts.push(motions[i % motions.length]!);
    }
    return prompts;
  }
}

export const videoGenVeo = new VideoGenVeoBlock();
