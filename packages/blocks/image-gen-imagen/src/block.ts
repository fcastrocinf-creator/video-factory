import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ParsedScriptSchema,
  type ImageAsset,
  type ParsedScript,
} from '@video-factory/contracts';
import { ImagenApiError, ImagenClient, type AspectRatio } from './client.js';
import { buildPrompt, readPngDimensions } from './prompt.js';

const DEFAULT_MODEL = 'imagen-4.0-generate-001';

export interface ImageGenImagenBlockOptions {
  client?: ImagenClient;
  promptVariables?: Record<string, string>;
  model?: string;
}

export class ImageGenImagenBlock implements Block<ParsedScript, ImageAsset> {
  readonly name = 'image-gen-imagen';
  readonly version = '1.0.0';
  readonly description =
    'Genera la imagen estática del video usando Google Imagen 4 según el promptTemplate del preset.';

  constructor(private readonly options: ImageGenImagenBlockOptions = {}) {}

  validateInput(input: unknown): Result<ParsedScript, Error> {
    const parsed = ParsedScriptSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`ParsedScript inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(_input: ParsedScript, ctx: BlockContext): Promise<Result<ImageAsset, BlockError>> {
    if (!ctx.preset) {
      return err(
        new BlockError(
          this.name,
          'MISSING_PRESET',
          'BlockContext sin preset. image-gen-imagen necesita preset.visualStyle.',
          false,
        ),
      );
    }

    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    const client = this.options.client ?? (apiKey ? new ImagenClient({ apiKey }) : null);
    if (!client) {
      return err(
        new BlockError(
          this.name,
          'MISSING_API_KEY',
          'Falta la variable de entorno GOOGLE_AI_API_KEY.',
          false,
        ),
      );
    }

    const promptVariables = {
      brandName: ctx.brand?.displayName ?? '',
      language: ctx.brand?.language ?? '',
      ...this.options.promptVariables,
    };

    const prompt = buildPrompt(ctx.preset.visualStyle.promptTemplate, promptVariables);
    const negativePrompt = ctx.preset.visualStyle.negativePrompt;
    const aspectRatio = ctx.preset.visualStyle.aspectRatio as AspectRatio;
    const model = this.options.model ?? DEFAULT_MODEL;

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        model,
        aspectRatio,
        promptLength: prompt.length,
      },
      'image-gen-imagen:requesting',
    );

    let imageBuffer: Buffer;
    try {
      imageBuffer = await client.generate({
        prompt,
        negativePrompt,
        aspectRatio,
        sampleCount: 1,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
        model,
      });
    } catch (error) {
      const retryable = error instanceof ImagenApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof ImagenApiError ? `API_${error.statusCode}` : 'API_CALL_FAILED';
      return err(new BlockError(this.name, code, `Error llamando a Imagen: ${message}`, retryable, error));
    }

    let dimensions: { width: number; height: number };
    try {
      dimensions = readPngDimensions(imageBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new BlockError(
          this.name,
          'INVALID_PNG',
          `Imagen devolvió un buffer que no es PNG válido: ${message}`,
          false,
          error,
        ),
      );
    }

    await mkdir(ctx.workDir, { recursive: true });
    const imagePath = join(ctx.workDir, 'image.png');
    await writeFile(imagePath, imageBuffer);

    ctx.logger.info(
      {
        runId: ctx.runId,
        block: this.name,
        imagePath,
        width: dimensions.width,
        height: dimensions.height,
        bytes: imageBuffer.length,
      },
      'image-gen-imagen:image_saved',
    );

    const asset: ImageAsset = {
      filePath: imagePath,
      width: dimensions.width,
      height: dimensions.height,
      format: 'png',
      prompt,
      negativePrompt,
      metadata: {
        model,
        engine: ctx.preset.visualEngine,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
      },
    };

    return ok(asset);
  }
}

export const imageGenImagen = new ImageGenImagenBlock();
