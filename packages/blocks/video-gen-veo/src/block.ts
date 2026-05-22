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

    // Concurrencia limitada + retry exponencial. Veo Lite tiene rate limits estrictos
    // (verificado: 9 Veo en paralelo → 429 RESOURCE_EXHAUSTED). Vamos de a 2 con retries.
    const CONCURRENCY = 2;
    const MAX_RETRIES = 4;
    const BASE_BACKOFF_MS = 8000;

    let completedClips = 0;
    const clips: VideoClip[] = new Array(motionPrompts.length);

    const generateOne = async (prompt: string, index: number): Promise<void> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
              attempt,
            },
            'video-gen-veo:clip_saved',
          );

          clips[index] = {
            filePath: clipPath,
            durationSeconds: baseDuration,
            prompt,
            startTimeSeconds: index * baseDuration,
            endTimeSeconds: (index + 1) * baseDuration,
          };
          return;
        } catch (error) {
          lastErr = error;
          const isRetryable =
            error instanceof VeoApiError && error.retryable && attempt < MAX_RETRIES;
          if (!isRetryable) break;
          // Backoff exponencial: 8s, 16s, 32s, 64s
          const wait = BASE_BACKOFF_MS * Math.pow(2, attempt);
          ctx.logger.warn(
            { runId: ctx.runId, clip: index, attempt: attempt + 1, waitMs: wait },
            'video-gen-veo:clip_retry',
          );
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
      ctx.logger.error(
        { runId: ctx.runId, clip: index, err: lastErr },
        'video-gen-veo:clip_failed_after_retries',
      );
      throw lastErr;
    };

    // Pool de concurrencia: procesamos motionPrompts en olas de CONCURRENCY clips.
    try {
      for (let i = 0; i < motionPrompts.length; i += CONCURRENCY) {
        const chunk = motionPrompts
          .slice(i, i + CONCURRENCY)
          .map((prompt, j) => generateOne(prompt, i + j));
        await Promise.all(chunk);
      }
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
    //    activa el safety filter.
    // 3. Frases tipo "eye contact with camera", "looking at camera", "speaking",
    //    "talking head", "reassuring", "as if explaining" también disparan el filter
    //    (Veo las asocia con synthetic talking head / deepfake). Verificado empíricamente.
    // Los prompts describen SOLO movimiento de cámara y atmósfera/luz, NUNCA acciones
    // del sujeto. Hallazgo empírico crítico: Veo filtra cuando el prompt menciona
    // "head turn", "breathing", "blinking", "looking at", "eye contact", "speaking",
    // "talking" — los asocia con synthetic talking head / deepfake. Veo SÍ anima
    // micro-movimientos del sujeto (breathing, blinking) automáticamente respetando
    // la imagen de referencia, no necesitamos pedirlos.
    const motions = [
      'Soft slow zoom in with cinematic depth of field, ambient warm light shifting gently across the scene',
      'Slow cinematic pan across the interior space, warm natural light dappling the environment, peaceful atmosphere',
      'Gentle parallax camera movement revealing depth in the scene, soft warm tones, cinematic mood',
      'Subtle camera drift to the right, ambient golden hour light filtering through the window, warm color grading',
      'Cinematic slow push-in with shallow depth of field, warm atmospheric tones, soft natural lighting',
      'Camera arc gently around the space, warm reflective light playing across surfaces, peaceful interior',
      'Smooth slow zoom out revealing the warm interior, soft natural light shifting, cinematic atmosphere',
      'Subtle camera handheld float, warm soft lighting, ambient cinematic mood with gentle light variation',
      'Slow cinematic dolly forward, shallow depth of field, warm light pooling in the scene, peaceful tone',
      'Gentle camera drift with parallax, warm natural lighting catching ambient details, cinematic stillness',
    ];

    const prompts: string[] = [];
    for (let i = 0; i < clipCount; i++) {
      prompts.push(motions[i % motions.length]!);
    }
    return prompts;
  }
}

export const videoGenVeo = new VideoGenVeoBlock();
