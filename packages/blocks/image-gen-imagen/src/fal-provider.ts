// Provider para fal.ai — soporta Flux Pro, Flux Dev, Flux Schnell, Recraft v3.
//
// fal.ai usa modelo "queue" para los modelos más pesados (sumbit + poll) y
// "sync" para los rápidos. Acá implementamos ambos modos en una sola interfaz.
//
// API docs: https://fal.ai/models/<model>/api
// Endpoint: https://fal.run/<model_id>  (sync, hasta ~30s)
// Endpoint: https://queue.fal.run/<model_id>  (async, queue)

import type { AspectRatio } from './client.js';
import { ImageProviderError, type ImageGenerationRequest, type ImageProvider } from './provider.js';

const FAL_BASE_URL = 'https://fal.run';
const FAL_QUEUE_URL = 'https://queue.fal.run';

export interface FalProviderOptions {
  apiKey: string;
  // Modelo por defecto si la request no especifica. Recomendaciones:
  //   - 'fal-ai/flux-pro/v1.1': mejor calidad, ~$0.05/img, ~10s
  //   - 'fal-ai/flux/dev': buena calidad, ~$0.025/img, ~5s
  //   - 'fal-ai/flux/schnell': rapidísimo, ~$0.003/img, ~2s (menos detalle)
  //   - 'fal-ai/recraft-v3': excelente para ilustración digital
  defaultModel?: string;
  // Si true, usa queue API (async). Default false (sync, más simple).
  useQueue?: boolean;
  // Identificador legible.
  name?: string;
  fetchImpl?: typeof fetch;
}

interface FalSyncResponse {
  images?: Array<{ url: string; width: number; height: number; content_type?: string }>;
  image?: { url: string; width: number; height: number; content_type?: string };
}

interface FalQueueSubmitResponse {
  request_id: string;
  status_url: string;
  response_url: string;
}

interface FalQueueStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_url?: string;
}

const ASPECT_TO_FAL_SIZE: Record<AspectRatio, string> = {
  '1:1': 'square_hd',
  '9:16': 'portrait_16_9',
  '16:9': 'landscape_16_9',
  '3:4': 'portrait_4_3',
  '4:3': 'landscape_4_3',
};

const ASPECT_TO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '9:16': { width: 1024, height: 1820 },
  '16:9': { width: 1820, height: 1024 },
  '3:4': { width: 1024, height: 1365 },
  '4:3': { width: 1365, height: 1024 },
};

export class FalProvider implements ImageProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly useQueue: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FalProviderOptions) {
    this.name = opts.name ?? 'fal-ai';
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? 'fal-ai/flux-pro/v1.1';
    this.useQueue = opts.useQueue ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const model = req.model ?? this.defaultModel;
    const dims = ASPECT_TO_DIMENSIONS[req.aspectRatio] ?? ASPECT_TO_DIMENSIONS['1:1']!;
    const sizeName = ASPECT_TO_FAL_SIZE[req.aspectRatio] ?? 'square_hd';

    // Body común para la mayoría de modelos Flux/Recraft de fal.ai
    const body = {
      prompt: req.prompt,
      image_size: sizeName, // usado por Flux
      // Algunos modelos esperan width/height explícito en vez de image_size:
      width: dims.width,
      height: dims.height,
      num_images: 1,
      enable_safety_checker: true,
    };

    const url = this.useQueue ? `${FAL_QUEUE_URL}/${model}` : `${FAL_BASE_URL}/${model}`;
    const submitResp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text();
      throw new ImageProviderError(
        `fal.ai ${submitResp.status} ${submitResp.statusText}: ${text.slice(0, 300)}`,
        submitResp.status,
        text,
        submitResp.status === 429 || submitResp.status >= 500,
        false, // fal.ai no usa daily quota — el chain no salta de proveedor por esto
        this.name,
      );
    }

    if (this.useQueue) {
      // Poll status_url hasta COMPLETED, luego fetch response_url
      const submit = (await submitResp.json()) as FalQueueSubmitResponse;
      const buffer = await this.pollAndFetchQueue(submit);
      return buffer;
    } else {
      // Modo sync: respuesta directa con images
      const data = (await submitResp.json()) as FalSyncResponse;
      return this.downloadFirstImage(data);
    }
  }

  private async pollAndFetchQueue(submit: FalQueueSubmitResponse): Promise<Buffer> {
    const maxWaitMs = 120_000;
    const pollMs = 2000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const statusResp = await this.fetchImpl(submit.status_url, {
        headers: { Authorization: `Key ${this.apiKey}` },
      });
      if (!statusResp.ok) {
        throw new ImageProviderError(
          `fal.ai status poll error ${statusResp.status}`,
          statusResp.status,
          await statusResp.text(),
          true,
          false,
          this.name,
        );
      }
      const status = (await statusResp.json()) as FalQueueStatusResponse;
      if (status.status === 'COMPLETED') {
        const respUrl = status.response_url ?? submit.response_url;
        const dataResp = await this.fetchImpl(respUrl, {
          headers: { Authorization: `Key ${this.apiKey}` },
        });
        const data = (await dataResp.json()) as FalSyncResponse;
        return this.downloadFirstImage(data);
      }
      if (status.status === 'FAILED') {
        throw new ImageProviderError(
          `fal.ai generation failed`,
          500,
          JSON.stringify(status),
          false,
          false,
          this.name,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new ImageProviderError(
      `fal.ai queue timeout after ${maxWaitMs}ms`,
      504,
      '',
      true,
      false,
      this.name,
    );
  }

  private async downloadFirstImage(data: FalSyncResponse): Promise<Buffer> {
    const img = data.images?.[0] ?? data.image;
    if (!img?.url) {
      throw new ImageProviderError(
        `fal.ai response sin url de imagen`,
        500,
        JSON.stringify(data).slice(0, 300),
        false,
        false,
        this.name,
      );
    }
    const imgResp = await this.fetchImpl(img.url);
    if (!imgResp.ok) {
      throw new ImageProviderError(
        `Error descargando imagen de fal.ai: ${imgResp.status}`,
        imgResp.status,
        '',
        true,
        false,
        this.name,
      );
    }
    const arrayBuf = await imgResp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}
