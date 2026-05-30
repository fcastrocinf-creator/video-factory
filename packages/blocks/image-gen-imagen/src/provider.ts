// Abstracción ImageProvider: permite a image-gen-multi mezclar distintos
// proveedores de generación de imágenes (Google Imagen, fal.ai/Flux, Replicate)
// dentro de la misma cadena de fallback.

import { ImagenApiError, type AspectRatio } from './client.js';

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  // Identificador del modelo dentro del provider. Si está vacío, el provider
  // usa su default. Ej:
  //   - GoogleImagenProvider: 'imagen-4.0-fast-generate-001', etc.
  //   - FalProvider: 'fal-ai/flux-pro/v1.1', 'fal-ai/flux/dev', etc.
  model?: string;
  // OPCIONAL: imagen de referencia (buffer PNG/JPEG). Los providers que soportan
  // image-to-image (ej. Gemini Nano Banana) la usan para ANCLAR el estilo/paleta
  // del resultado al de la referencia. Los providers que NO la soportan la
  // ignoran silenciosamente (se comportan como texto-only). Retrocompatible.
  referenceImage?: Buffer;
}

export interface ImageProvider {
  // Nombre legible del provider (para logs).
  readonly name: string;
  // Genera UNA imagen como buffer PNG. Lanza error en caso de fallo.
  generate(req: ImageGenerationRequest): Promise<Buffer>;
}

/**
 * Error genérico para fallos de cualquier provider. Mantiene compatibilidad
 * con el manejo existente de ImagenApiError + agrega flag isDailyQuota para
 * que el chain pueda detectar quota daily y saltar al siguiente modelo.
 */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
    public readonly isDailyQuotaExhausted: boolean,
    public readonly providerName: string,
    // NUEVO: el provider rechazó la imagen por content policy (NSFW, safety
    // filter, etc.) — NO es retryable con mismo prompt, NO agota el provider,
    // pero el chain debe saltar a otro proveedor que pueda manejar el prompt.
    public readonly isContentRejection: boolean = false,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
}

/**
 * Convierte un ImagenApiError (legacy) a ImageProviderError uniforme.
 */
export function fromImagenError(e: ImagenApiError, providerName: string): ImageProviderError {
  const isDaily =
    e.statusCode === 429 &&
    (/quotaId[^"]*"[^"]*PerDay/i.test(e.responseBody) || /per_day/i.test(e.responseBody));
  // HTTP 200 sin bytesBase64Encoded o body que mencione "safety"/"RAI"/"filter" =
  // safety filter blocked. Marcamos isContentRejection para que image-gen-multi
  // pueda saltar al siguiente provider (no es retryable con mismo prompt).
  const isContentRejection =
    (e.statusCode === 200 && /safety|RAI|filter|bytesBase64Encoded/i.test(e.message)) ||
    /raiFilteredReason|content_filter|safety_filter|RAI_BLOCKED|imageSafetyAttributes/i.test(e.responseBody);
  return new ImageProviderError(
    e.message,
    e.statusCode,
    e.responseBody,
    e.retryable,
    isDaily,
    providerName,
    isContentRejection,
  );
}
