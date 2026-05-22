// Provider para OpenAI gpt-image-1 — modelo de imagen multimodal de OpenAI.
//
// API docs: https://platform.openai.com/docs/api-reference/images/create
// Endpoint: POST https://api.openai.com/v1/images/generations
// Body: { model: 'gpt-image-1', prompt, size, quality, n }
// Response: { data: [{ b64_json: string }] }
//
// Notas importantes:
//   - gpt-image-1 SIEMPRE devuelve b64_json (no url, a diferencia de dall-e-3)
//   - Tamaños soportados: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape), auto
//   - Quality: low / medium / high / auto. Default medium ~ $0.04/img a 1024x1536
//   - Sin daily caps duros: billing va contra tu cuenta OpenAI (igual que API GPT)
//   - Algunas cuentas requieren "organization verification" antes de usar gpt-image-1
//   - Content policy: rejections vuelven como 400 invalid_request_error con
//     'safety system rejected' o similar en el body → marcar como isContentRejection

import type { AspectRatio } from './client.js';
import {
  ImageProviderError,
  type ImageGenerationRequest,
  type ImageProvider,
} from './provider.js';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

export type OpenaiImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type OpenaiImageSize = '1024x1024' | '1024x1536' | '1536x1024' | 'auto';

export interface OpenaiImageProviderOptions {
  apiKey: string;
  // Modelo. Default 'gpt-image-1'. Otros valores válidos: 'dall-e-3', 'dall-e-2'.
  defaultModel?: string;
  // Calidad. Default 'medium' (balance precio/calidad, ~$0.04/img portrait).
  // 'high' ~ $0.17/img. 'low' ~ $0.011/img (rápido, suficiente para A/B).
  quality?: OpenaiImageQuality;
  // Identificador legible para logs.
  name?: string;
  fetchImpl?: typeof fetch;
  // Cuántos retries internos hacer cuando 429 con "try again in Xs".
  // Default 3 en producción. Tests pasan 0 para evitar sleeps.
  internalRetries?: number;
}

// Mapeo aspect-ratio → tamaño soportado por gpt-image-1.
// gpt-image-1 NO soporta 1820px ni 1080x1920 directo, así que usamos el más
// cercano y dejamos que Remotion escale al 1080x1920 final.
const ASPECT_TO_SIZE: Record<AspectRatio, OpenaiImageSize> = {
  '1:1': '1024x1024',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
};

interface OpenaiImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message: string; type?: string; code?: string };
}

export class OpenaiImageProvider implements ImageProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly quality: OpenaiImageQuality;
  private readonly fetchImpl: typeof fetch;
  private readonly internalRetries: number;

  constructor(opts: OpenaiImageProviderOptions) {
    if (!opts.apiKey || opts.apiKey === 'sk_pendiente') {
      throw new Error(
        'OpenaiImageProvider: OPENAI_API_KEY no seteada o placeholder. ' +
          'Generá una key real en https://platform.openai.com/api-keys',
      );
    }
    this.name = opts.name ?? 'openai-image';
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? 'gpt-image-1';
    this.quality = opts.quality ?? 'medium';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.internalRetries = opts.internalRetries ?? 3;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const model = req.model ?? this.defaultModel;
    const size = ASPECT_TO_SIZE[req.aspectRatio] ?? '1024x1024';

    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      size,
      n: 1,
    };
    if (model === 'gpt-image-1') {
      body['quality'] = this.quality;
    } else if (model === 'dall-e-3') {
      body['quality'] = this.quality === 'high' ? 'hd' : 'standard';
    }

    // Retry interno por 429 "try again in Xs": OpenAI Tier 1 = 5 IPM. Cuando
    // hit, el body trae el tiempo exacto a esperar. Lo respetamos para hasta
    // 3 intentos antes de propagar al caller (que tiene su propio retry chain).
    const maxRetries = this.internalRetries;
    let resp: Response | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      resp = await this.fetchImpl(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (resp.status !== 429) break;
      if (attempt >= maxRetries) break;
      // Parse "Please try again in 12s" o "in 12.5s"
      const bodyText = await resp.clone().text();
      const m = bodyText.match(/try again in ([\d.]+)s/i);
      const waitSec = m && m[1] ? Math.min(60, parseFloat(m[1])) : 6;
      // eslint-disable-next-line no-console
      console.warn(`[OpenaiImageProvider] 429 rate-limit. Esperando ${waitSec}s antes de retry ${attempt + 1}/${maxRetries}...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
    if (!resp) {
      throw new ImageProviderError('OpenAI Images: sin respuesta', 500, '', true, false, this.name);
    }

    if (!resp.ok) {
      const bodyText = await resp.text();
      // Content-policy rejection: 400 con safety/policy keywords.
      const isContentRejection =
        resp.status === 400 &&
        /(safety system|content policy|moderation|rejected|not allowed|inappropriate)/i.test(
          bodyText,
        );
      // OpenAI billing depleted: NO recupera con retry. Marcamos como
      // "quota exhausted" para que el image-gen-multi chain saltée al siguiente
      // provider (Vertex Imagen / AI Studio / Higgsfield) sin morir.
      const isBillingExhausted =
        /insufficient_quota|exceeded your current quota|billing_hard_limit_reached|billing_limit_user_error/i.test(
          bodyText,
        );
      throw new ImageProviderError(
        `OpenAI Images ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
        resp.status,
        bodyText,
        (resp.status === 429 && !isBillingExhausted) || resp.status >= 500,
        isBillingExhausted, // chain debe saltar al siguiente provider
        this.name,
        isContentRejection,
      );
    }

    const data = (await resp.json()) as OpenaiImagesResponse;
    const item = data.data?.[0];
    if (!item) {
      throw new ImageProviderError(
        `OpenAI Images respondió sin data[0]: ${JSON.stringify(data).slice(0, 300)}`,
        200,
        JSON.stringify(data),
        false,
        false,
        this.name,
      );
    }

    if (item.b64_json) {
      return Buffer.from(item.b64_json, 'base64');
    }
    // dall-e-3 puede devolver url en vez de b64
    if (item.url) {
      const imgResp = await this.fetchImpl(item.url);
      if (!imgResp.ok) {
        throw new ImageProviderError(
          `OpenAI: error descargando imagen ${imgResp.status}`,
          imgResp.status,
          '',
          true,
          false,
          this.name,
        );
      }
      const ab = await imgResp.arrayBuffer();
      return Buffer.from(ab);
    }
    throw new ImageProviderError(
      `OpenAI Images: data[0] sin b64_json ni url`,
      200,
      JSON.stringify(item).slice(0, 300),
      false,
      false,
      this.name,
    );
  }
}
