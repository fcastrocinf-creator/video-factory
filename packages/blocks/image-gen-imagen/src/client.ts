const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'imagen-4.0-generate-001';

export type AspectRatio = '1:1' | '9:16' | '16:9' | '3:4' | '4:3';
export type SafetyFilterLevel = 'block_low_and_above' | 'block_medium_and_above' | 'block_some' | 'block_few';
export type PersonGeneration = 'dont_allow' | 'allow_adult' | 'allow_all';

export interface ImagenGenerateOptions {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  sampleCount?: number;
  safetyFilterLevel?: SafetyFilterLevel;
  personGeneration?: PersonGeneration;
  model?: string;
}

export interface ImagenPrediction {
  bytesBase64Encoded: string;
  mimeType: string;
}

export interface ImagenResponse {
  predictions: ImagenPrediction[];
}

export class ImagenApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ImagenApiError';
  }
}

export interface ImagenClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ImagenClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ImagenClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(opts: ImagenGenerateOptions): Promise<Buffer> {
    const model = opts.model ?? DEFAULT_MODEL;
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:predict`;

    const parameters: Record<string, unknown> = {
      sampleCount: opts.sampleCount ?? 1,
      aspectRatio: opts.aspectRatio,
      safetyFilterLevel: opts.safetyFilterLevel ?? 'block_some',
      personGeneration: opts.personGeneration ?? 'allow_adult',
    };
    // Imagen 4.0 dejó de soportar `negativePrompt` (la API responde 400
    // "Setting negativePrompt is no longer supported"). El preset puede declararlo
    // pero acá lo descartamos. Si en el futuro otro engine (Veo, Higgsfield) lo
    // soporta, su client respectivo lo enviaría.

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ prompt: opts.prompt }],
        parameters,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      throw new ImagenApiError(
        `Imagen API ${response.status} ${response.statusText}: ${bodyText.slice(0, 400)}`,
        response.status,
        bodyText,
        retryable,
      );
    }

    const data = (await response.json()) as ImagenResponse;
    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      // HTTP 200 sin bytes = RAI safety filter bloqueó silenciosamente.
      // Marcamos retryable=true para que el chain skipée al siguiente provider
      // (la conversión en fromImagenError detecta este caso y setea
      // isContentRejection=true).
      throw new ImagenApiError(
        'Imagen API safety filter: prediction sin bytesBase64Encoded (probable RAI block).',
        200,
        JSON.stringify(data),
        true,
      );
    }

    return Buffer.from(prediction.bytesBase64Encoded, 'base64');
  }
}
