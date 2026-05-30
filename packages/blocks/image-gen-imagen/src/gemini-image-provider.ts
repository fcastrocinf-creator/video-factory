// Provider para Gemini Image (Nano Banana) — modelo nativo de generación de
// imágenes de Gemini, accesible vía Gemini Developer API.
//
// API docs: https://ai.google.dev/gemini-api/docs/image-generation
// Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// Body shape (2.5 family):
//   { contents: [{ parts: [{ text }] }],
//     generationConfig: { responseModalities: ['IMAGE'],
//                         imageConfig: { aspectRatio: '9:16' } } }
// Response: candidates[0].content.parts[i].inlineData.data (base64 PNG)
//
// Notas importantes:
//   - Modelo GA estable: 'gemini-2.5-flash-image' (Nano Banana).
//     El alias '-preview' fue shut down el 15 ene 2026.
//   - Modelos 3.x ('gemini-3.1-flash-image-preview' / 'gemini-3-pro-image-preview')
//     usan distinto shape: `generationConfig.responseFormat.image.aspectRatio`
//     (+ opcional `imageSize`). El builder lo detecta por el prefix del modelo.
//   - Pool de cuota INDEPENDIENTE de Vertex Imagen y de AI Studio Imagen.
//     Tier 1 paid (con billing habilitado): ~10 IPM por default, ~500 RPD.
//     Esto es la palanca arquitectónica: cuando Vertex 429ea, Gemini sigue
//     funcionando porque su quota pool es totalmente separado.
//   - Content filter generalmente más permisivo que gpt-image-1 en contextos
//     pediátrico/médico/educativo legítimos.
//   - Imagen 4 EOL 24 jun 2026; Nano Banana es el successor recomendado por Google.

import type { AspectRatio } from './client.js';
import {
  ImageProviderError,
  type ImageGenerationRequest,
  type ImageProvider,
} from './provider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Default: la versión GA estable. Para usar Nano Banana 2/Pro pasar `defaultModel`.
const DEFAULT_MODEL = 'gemini-2.5-flash-image';

export interface GeminiImageProviderOptions {
  apiKey: string;
  // Modelo default. Default 'gemini-2.5-flash-image' (Nano Banana, GA estable).
  // Otros válidos: 'gemini-3.1-flash-image-preview' (Nano Banana 2),
  // 'gemini-3-pro-image-preview' (Nano Banana Pro).
  defaultModel?: string;
  // Identificador legible para logs.
  name?: string;
  fetchImpl?: typeof fetch;
  // Cuántos retries internos para 429 transient / 5xx. Default 2.
  // (No usamos retry para quota-exhausted ni content-rejection.)
  internalRetries?: number;
}

export class GeminiImageProvider implements ImageProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly internalRetries: number;

  constructor(opts: GeminiImageProviderOptions) {
    if (!opts.apiKey) {
      throw new Error(
        'GeminiImageProvider: apiKey no seteada. Pasa GOOGLE_AI_API_KEY o equivalente.',
      );
    }
    this.name = opts.name ?? 'gemini-image';
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.internalRetries = opts.internalRetries ?? 2;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const model = req.model ?? this.defaultModel;
    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;

    const body = buildRequestBody(model, req.prompt, req.aspectRatio);

    // Internal retry: 429 transient y 5xx, hasta `internalRetries` veces con backoff.
    // Para quota-exhausted no retry-amos (lo detectamos abajo).
    let resp: Response | null = null;
    for (let attempt = 0; attempt <= this.internalRetries; attempt++) {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) break;
      if (attempt >= this.internalRetries) break;
      if (resp.status === 429 || resp.status >= 500) {
        // Backoff exponencial: ~1.5s, 3s, 6s
        const waitMs = Math.min(8000, 1500 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // Otros errores (400, 401, 403) no son retryables — los propagamos al caller.
      break;
    }

    if (!resp) {
      throw new ImageProviderError(
        'Gemini Image: sin respuesta del API',
        500,
        '',
        true,
        false,
        this.name,
      );
    }

    if (!resp.ok) {
      const bodyText = await resp.text();
      // 429 con body que menciona cuota → quota-exhausted (la cascada del chain
      // debe saltar al próximo provider, no insistir). Mismo patrón que el
      // Bug 1 fix de vertex-provider.ts.
      const isQuotaExhausted =
        resp.status === 429 &&
        /quota.*exceeded|RESOURCE_EXHAUSTED|rate limit/i.test(bodyText);
      // 400 con keywords de safety → content rejection
      const isContentRejection =
        resp.status === 400 &&
        /safety|policy|prohibited|blocked|harmful|filter|moderation/i.test(bodyText);
      const retryable =
        !isQuotaExhausted &&
        !isContentRejection &&
        (resp.status === 429 || resp.status >= 500);
      throw new ImageProviderError(
        `Gemini Image ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
        resp.status,
        bodyText,
        retryable,
        isQuotaExhausted,
        this.name,
        isContentRejection,
      );
    }

    const data = (await resp.json()) as GeminiContentResponse;
    // Aceptamos tanto `inlineData` (camelCase, JSON convention típica) como
    // `inline_data` (snake_case, algunos SDKs/versiones). Misma data, diferente
    // nombre de campo según el endpoint version.
    const part = data.candidates?.[0]?.content?.parts?.find(
      (p) => Boolean(p.inlineData?.data) || Boolean(p.inline_data?.data),
    );
    const inlineData = part?.inlineData ?? part?.inline_data;

    if (!inlineData?.data) {
      // 200 sin imagen casi siempre = safety filter silencioso (el modelo
      // decidió no generar). Lo tratamos como content rejection para que el
      // chain salte al próximo provider en lugar de quedarse colgado.
      const blockReason = data.promptFeedback?.blockReason;
      const finishReason = data.candidates?.[0]?.finishReason;
      throw new ImageProviderError(
        `Gemini Image: 200 sin imagen ${blockReason ? `(blockReason: ${blockReason})` : finishReason ? `(finishReason: ${finishReason})` : '(probable safety filter silencioso)'}`,
        200,
        JSON.stringify(data).slice(0, 500),
        false,
        false,
        this.name,
        true, // isContentRejection — saltar al próximo provider
      );
    }
    return Buffer.from(inlineData.data, 'base64');
  }
}

// === Helpers ===

interface GeminiContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mimeType?: string; data?: string };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Construye el request body según el modelo.
 *
 * - `gemini-2.5-flash-image`: aspect ratio en `generationConfig.imageConfig.aspectRatio`.
 * - `gemini-3.x-flash-image-preview` / `gemini-3-pro-image-preview`: aspect ratio en
 *   `generationConfig.responseFormat.image.aspectRatio`. (Acepta `imageSize` adicional
 *   pero no lo seteamos por default — usa default del modelo.)
 *
 * Aspect ratios soportados (2.5 y 3.x): 1:1, 9:16, 16:9, 3:4, 4:3, 2:3, 3:2, 4:5, 5:4.
 * 3.x adicionalmente acepta 1:4, 1:8, 4:1, 8:1, 21:9.
 */
function buildRequestBody(
  model: string,
  prompt: string,
  aspectRatio: AspectRatio,
): Record<string, unknown> {
  const isV3 = /^gemini-3/i.test(model);
  if (isV3) {
    return {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        responseFormat: { image: { aspectRatio } },
      },
    };
  }
  // Default: shape de la 2.5 family (GA estable, Nano Banana).
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio },
    },
  };
}
