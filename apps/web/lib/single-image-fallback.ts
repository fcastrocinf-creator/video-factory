// Single-image fallback con provider chain: para flujos legacy (plano_fijo,
// Veo) que necesitan UNA sola imagen. Usa el mismo orden de providers que el
// multi-escena (OpenAI gpt-image-1 primario → Vertex → AI Studio → Higgsfield
// → fal.ai) para no depender de un solo proveedor.
//
// Se invoca desde apps/web/lib/pipeline.ts en la rama legacy en vez de
// imageGenImagen.run, que solo soporta Google AI Studio.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrandConfig, ImageAsset, PresetConfig } from '@video-factory/contracts';
import {
  buildPrompt,
  FalProvider,
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  ImageProviderError,
  OpenaiImageProvider,
  readPngDimensions,
  VertexImagenProvider,
  type ImageProvider,
} from '@video-factory/block-image-gen-imagen';

interface ProviderStep {
  provider: ImageProvider;
  model: string;
  label: string;
}

function buildChain(): ProviderStep[] {
  const chain: ProviderStep[] = [];
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey && openaiKey !== 'sk_pendiente') {
    chain.push({
      provider: new OpenaiImageProvider({ apiKey: openaiKey, quality: 'medium' }),
      model: 'gpt-image-1',
      label: 'openai:gpt-image-1',
    });
  }
  const gcpProjectId = process.env['GCP_PROJECT_ID'];
  const gcpCreds = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (gcpProjectId && gcpCreds) {
    const vertex = new VertexImagenProvider({ projectId: gcpProjectId });
    chain.push(
      { provider: vertex, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
      { provider: vertex, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
    );
  }
  const googleApiKey = process.env['GOOGLE_AI_API_KEY'];
  if (googleApiKey) {
    const aistudio = new GoogleImagenProvider({ apiKey: googleApiKey });
    chain.push(
      { provider: aistudio, model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' },
      { provider: aistudio, model: 'imagen-4.0-generate-001', label: 'aistudio:std' },
    );
  }
  const hKid = process.env['HIGGSFIELD_KEY_ID'];
  const hSecret = process.env['HIGGSFIELD_KEY_SECRET'];
  if (hKid && hSecret) {
    chain.push({
      provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
      model: 'flux-pro/kontext/max/text-to-image',
      label: 'higgsfield:flux-pro-kontext',
    });
  }
  const falKey = process.env['FAL_API_KEY'];
  if (falKey) {
    chain.push({
      provider: new FalProvider({ apiKey: falKey, defaultModel: 'fal-ai/flux-pro/v1.1' }),
      model: 'fal-ai/flux-pro/v1.1',
      label: 'fal:flux-pro-v1.1',
    });
  }
  return chain;
}

export interface SingleImageOptions {
  workDir: string;
  brand: BrandConfig;
  preset: PresetConfig;
  promptOverride?: string;
}

/**
 * Genera UNA imagen aplicando el provider chain. Si un provider falla con
 * isDailyQuotaExhausted o isContentRejection, salta al siguiente.
 *
 * Devuelve el ImageAsset escrito a workDir/image.png.
 */
export async function generateSingleImageWithChain(
  opts: SingleImageOptions,
): Promise<ImageAsset> {
  const chain = buildChain();
  if (chain.length === 0) {
    throw new Error(
      'No hay providers de imagen configurados (OPENAI_API_KEY, GCP_PROJECT_ID, GOOGLE_AI_API_KEY, HIGGSFIELD_*, FAL_API_KEY).',
    );
  }

  const aspectRatio =
    (opts.preset.visualStyle.aspectRatio as '1:1' | '9:16' | '16:9' | '3:4' | '4:3') ??
    '9:16';
  const prompt =
    opts.promptOverride ??
    buildPrompt(opts.preset.visualStyle.promptTemplate, {
      brandName: opts.brand.displayName,
      language: opts.brand.language,
    });

  let lastError: Error | null = null;
  for (const step of chain) {
    try {
      const buf = await step.provider.generate({
        prompt,
        aspectRatio,
        model: step.model,
      });
      await mkdir(opts.workDir, { recursive: true });
      const imagePath = join(opts.workDir, 'image.png');
      await writeFile(imagePath, buf);
      let width = 0;
      let height = 0;
      try {
        const dims = readPngDimensions(buf);
        width = dims.width;
        height = dims.height;
      } catch {
        // No PNG (probably JPEG/WebP) — dejamos 0
      }
      return {
        filePath: imagePath,
        width,
        height,
        format: 'png',
        prompt,
        negativePrompt: opts.preset.visualStyle.negativePrompt,
        metadata: {
          model: `${step.label}/${step.model}`,
          engine: opts.preset.visualEngine,
        },
      };
    } catch (e) {
      lastError = e as Error;
      const provErr = e instanceof ImageProviderError ? e : null;
      // Si es daily quota exhausted O content rejection → saltar al siguiente
      if (provErr && (provErr.isDailyQuotaExhausted || provErr.isContentRejection)) {
        continue;
      }
      // Si es retryable de red → también intentamos siguiente
      if (provErr && provErr.retryable) {
        continue;
      }
      // Errores no-retryable propagan inmediatamente
      throw e;
    }
  }
  throw lastError ?? new Error('Todos los providers fallaron sin error específico.');
}
