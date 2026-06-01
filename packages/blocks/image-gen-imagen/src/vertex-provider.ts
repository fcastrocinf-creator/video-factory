// Provider para Vertex AI Imagen — misma familia de modelos que Google AI Studio
// pero usando la API de Google Cloud (mucho más quota, project-based billing).
//
// Diferencias clave con GoogleImagenProvider (AI Studio):
//   - Endpoint: us-central1-aiplatform.googleapis.com en vez de generativelanguage
//   - Auth: OAuth2 access token de Service Account JSON, no API key
//   - Quota: ~2000 RPM por proyecto, sin daily cap rígido (vs 70/día Tier 1)
//
// Setup requerido por el usuario (~30 min):
//   1. https://console.cloud.google.com → seleccionar el proyecto que ya tienes
//   2. APIs → habilitar "Vertex AI API"
//   3. IAM → Service Accounts → crear nuevo → role "Vertex AI User"
//   4. Keys → descargar JSON
//   5. Guardar JSON en C:\Users\cmktc\.gcp\video-factory-sa.json
//   6. Setear en .env: GOOGLE_APPLICATION_CREDENTIALS=C:\Users\cmktc\.gcp\video-factory-sa.json
//                       GCP_PROJECT_ID=<tu-project-id>
//                       GCP_LOCATION=us-central1

import { GoogleAuth } from 'google-auth-library';
import type { AspectRatio } from './client.js';
import type {
  ImageGenerationRequest,
  ImageProvider,
} from './provider.js';
import { ImageProviderError } from './provider.js';

export interface VertexImagenProviderOptions {
  // GCP project ID. Si no se provee, intenta leer GCP_PROJECT_ID del env.
  projectId?: string;
  // Region. Default us-central1 (donde están disponibles Imagen 4).
  location?: string;
  // Path al service account JSON. Si no se provee, GoogleAuth busca
  // GOOGLE_APPLICATION_CREDENTIALS env var.
  keyFilename?: string;
  // Identificador legible para logs.
  name?: string;
  fetchImpl?: typeof fetch;
}

// Vertex AI usa los mismos nombres de modelo que AI Studio para Imagen 4:
//   - imagen-4.0-generate-001 (std)
//   - imagen-4.0-fast-generate-001
//   - imagen-4.0-ultra-generate-001
// Importante: Vertex también soporta sampleImageSize y otras opciones extra,
// pero acá replicamos el contrato mínimo de ImageProvider.

const ASPECT_RATIO_MAP: Record<AspectRatio, string> = {
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '3:4': '3:4',
  '4:3': '4:3',
};

interface VertexImagenResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
    raiFilteredReason?: string;
  }>;
}

export class VertexImagenProvider implements ImageProvider {
  readonly name: string;
  private readonly projectId: string;
  private readonly location: string;
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: typeof fetch;
  private cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

  constructor(opts: VertexImagenProviderOptions = {}) {
    this.name = opts.name ?? 'vertex-imagen';
    this.projectId = opts.projectId ?? process.env['GCP_PROJECT_ID'] ?? '';
    this.location = opts.location ?? process.env['GCP_LOCATION'] ?? 'us-central1';
    this.fetchImpl = opts.fetchImpl ?? fetch;

    if (!this.projectId) {
      throw new Error(
        'VertexImagenProvider: GCP_PROJECT_ID no seteado. Pásalo en options o vía env.',
      );
    }

    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(opts.keyFilename ? { keyFilename: opts.keyFilename } : {}),
    });
  }

  /**
   * Obtiene access token cacheado, refrescándolo si expiró.
   * GoogleAuth maneja el JWT signing internamente.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs > now + 60_000) {
      return this.cachedAccessToken.token;
    }
    const client = await this.auth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) {
      throw new ImageProviderError(
        'Vertex AI: no se pudo obtener access token (revisar GOOGLE_APPLICATION_CREDENTIALS)',
        500,
        '',
        false,
        false,
        this.name,
      );
    }
    // GoogleAuth no siempre devuelve expiry; default a 50 min (los tokens duran 60 min)
    const expiresAtMs = now + 50 * 60 * 1000;
    this.cachedAccessToken = { token: tokenResp.token, expiresAtMs };
    return tokenResp.token;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const model = req.model ?? 'imagen-4.0-generate-001';
    const aspectRatio = ASPECT_RATIO_MAP[req.aspectRatio] ?? req.aspectRatio;

    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${encodeURIComponent(model)}:predict`;

    const body = {
      instances: [{ prompt: req.prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
      },
    };

    const accessToken = await this.getAccessToken();
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const bodyText = await resp.text();
      // Vertex 429 puede ser:
      //   - RPM transient: retry-with-backoff lo resuelve.
      //   - Quota-exhausted per-base-model: la cuota está agotada para este
      //     modelo en este proyecto; retry no resuelve nada porque cada intento
      //     vuelve a chocar. La cascada debe saltar al próximo provider.
      // (Bug 1 fix — ver investigacion/01-image-gen-multi-block-analysis.md.)
      //
      // Detectamos el caso quota-exhausted por el body del 429:
      //   - `online_prediction_requests_per_base_model` → match exacto del caso real.
      //   - `RESOURCE_EXHAUSTED` o `quota exceeded` → patrones más amplios para
      //     cubrir otras cuotas de Vertex que también deberían escalar.
      const isQuotaExhausted =
        (resp.status === 429 &&
          /quota.*exceeded|RESOURCE_EXHAUSTED|online_prediction_requests_per_base_model/i.test(
            bodyText,
          )) ||
        // v3.3 fix: un 403 por billing deshabilitado / permission denied / API no
        // habilitada NO se resuelve con retry — la cascada debe saltar al próximo
        // provider en vez de morir. Lo tratamos como exhausted.
        (resp.status === 403 &&
          /PERMISSION_DENIED|SERVICE_DISABLED|billing|has not been used|consumer|disabled/i.test(
            bodyText,
          ));
      const retryable =
        !isQuotaExhausted && (resp.status === 429 || resp.status >= 500);
      throw new ImageProviderError(
        `Vertex Imagen ${resp.status} ${resp.statusText}: ${bodyText.slice(0, 400)}`,
        resp.status,
        bodyText,
        retryable,
        isQuotaExhausted,
        this.name,
      );
    }

    const data = (await resp.json()) as VertexImagenResponse;
    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      const reason = prediction?.raiFilteredReason ?? 'sin bytesBase64Encoded en predictions';
      // 200 + sin bytes = RAI safety filter. Marcamos isContentRejection para que
      // el chain skipée al siguiente provider en lugar de fallar duro.
      throw new ImageProviderError(
        `Vertex Imagen sin imagen en response: ${reason}`,
        200,
        JSON.stringify(data).slice(0, 500),
        true, // retryable (en el sentido de "intentá otro provider")
        false,
        this.name,
        true, // isContentRejection
      );
    }
    return Buffer.from(prediction.bytesBase64Encoded, 'base64');
  }
}
