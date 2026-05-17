const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_POLL_INTERVAL_MS = 6000;
const DEFAULT_POLL_TIMEOUT_MS = 6 * 60 * 1000; // 6 min — Veo Lite suele tardar 1-3 min

export type VeoModel =
  | 'veo-3.1-lite-generate-preview'
  | 'veo-3.1-fast-generate-001'
  | 'veo-3.1-generate-001';

export type VeoAspectRatio = '9:16' | '16:9' | '1:1';
export type VeoPersonGeneration = 'dont_allow' | 'allow_adult' | 'allow_all';

export interface VeoGenerateOptions {
  prompt: string;
  // Imagen base para image-to-video (mantiene consistencia de personaje).
  imageBase64?: string;
  imageMimeType?: string;
  aspectRatio: VeoAspectRatio;
  durationSeconds: number;
  negativePrompt?: string;
  personGeneration?: VeoPersonGeneration;
  model?: VeoModel;
  onProgress?: (percent: number) => void;
}

interface VeoGeneratedSample {
  video?: {
    // Veo devuelve el video como URI del File API de Gemini.
    // Hay que descargarlo con x-goog-api-key en header.
    uri?: string;
    // Por si en futuras versiones devuelve inline:
    bytesBase64Encoded?: string;
    mimeType?: string;
  };
}

interface VeoGenerateVideoResponse {
  generatedSamples?: VeoGeneratedSample[];
  raiMediaFilteredCount?: number;
  raiMediaFilteredReasons?: string[];
}

interface VeoOperationResponse {
  name: string;
  done?: boolean;
  metadata?: {
    progressPercent?: number;
  };
  response?: {
    generateVideoResponse?: VeoGenerateVideoResponse;
  };
  error?: { code: number; message: string };
}

export class VeoApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VeoApiError';
  }
}

export interface VeoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class VeoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: VeoClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  async generate(opts: VeoGenerateOptions): Promise<Buffer> {
    const model = opts.model ?? 'veo-3.1-lite-generate-preview';
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:predictLongRunning`;

    const instance: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.imageBase64) {
      instance['image'] = {
        bytesBase64Encoded: opts.imageBase64,
        mimeType: opts.imageMimeType ?? 'image/png',
      };
    }

    const parameters: Record<string, unknown> = {
      aspectRatio: opts.aspectRatio,
      durationSeconds: opts.durationSeconds,
    };
    // personGeneration: Veo no acepta `allow_adult` (es param de Imagen). Si el caller
    // lo setea explícitamente lo respetamos; si no, no lo enviamos.
    if (opts.personGeneration) {
      parameters['personGeneration'] = opts.personGeneration;
    }
    if (opts.negativePrompt) {
      parameters['negativePrompt'] = opts.negativePrompt;
    }

    const startResp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ instances: [instance], parameters }),
    });

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new VeoApiError(
        `Veo predictLongRunning ${startResp.status} ${startResp.statusText}: ${body.slice(0, 500)}`,
        startResp.status,
        body,
        startResp.status === 429 || startResp.status >= 500,
      );
    }

    const { name } = (await startResp.json()) as { name?: string };
    if (!name) {
      throw new VeoApiError('Veo respondió sin operation name.', 200, '', false);
    }

    return this.pollOperation(name, opts.onProgress);
  }

  private async pollOperation(
    operationName: string,
    onProgress?: (percent: number) => void,
  ): Promise<Buffer> {
    const deadline = Date.now() + this.pollTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));

      // Veo devuelve operation name como `models/veo-3.1-lite-generate-preview/operations/{id}`
      // (path completo). Lo usamos as-is. Si por error viniera sin prefix, fallback a operations/.
      const operationPath = operationName.startsWith('models/')
        ? operationName
        : `operations/${operationName}`;
      const resp = await this.fetchImpl(`${this.baseUrl}/${operationPath}`, {
        headers: { 'x-goog-api-key': this.apiKey },
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new VeoApiError(
          `Veo operation poll ${resp.status} ${resp.statusText}: ${body.slice(0, 400)}`,
          resp.status,
          body,
          resp.status === 429 || resp.status >= 500,
        );
      }

      const op = (await resp.json()) as VeoOperationResponse;

      if (op.metadata?.progressPercent !== undefined && onProgress) {
        onProgress(op.metadata.progressPercent);
      }

      if (op.done) {
        if (op.error) {
          throw new VeoApiError(
            `Veo operation falló: ${op.error.message}`,
            op.error.code,
            JSON.stringify(op.error),
            false,
          );
        }

        const gen = op.response?.generateVideoResponse;
        if (!gen) {
          throw new VeoApiError(
            'Veo done sin generateVideoResponse.',
            200,
            JSON.stringify(op).slice(0, 500),
            false,
          );
        }

        if (gen.raiMediaFilteredCount && gen.raiMediaFilteredCount > 0) {
          const reasons = gen.raiMediaFilteredReasons?.join(' | ') ?? 'sin detalle';
          throw new VeoApiError(
            `Veo filtró el contenido por safety/policy: ${reasons}`,
            403,
            JSON.stringify(gen),
            false,
          );
        }

        const samples = gen.generatedSamples ?? [];
        const first = samples[0];
        if (!first?.video) {
          throw new VeoApiError(
            'Veo done sin generatedSamples.video',
            200,
            JSON.stringify(gen).slice(0, 500),
            false,
          );
        }

        if (first.video.bytesBase64Encoded) {
          return Buffer.from(first.video.bytesBase64Encoded, 'base64');
        }
        if (first.video.uri) {
          const videoResp = await this.fetchImpl(first.video.uri, {
            headers: { 'x-goog-api-key': this.apiKey },
          });
          if (!videoResp.ok) {
            const body = await videoResp.text();
            throw new VeoApiError(
              `No se pudo descargar el video desde ${first.video.uri}: ${videoResp.status}`,
              videoResp.status,
              body,
              true,
            );
          }
          return Buffer.from(await videoResp.arrayBuffer());
        }
        throw new VeoApiError(
          'Veo sample sin bytesBase64Encoded ni uri.',
          200,
          JSON.stringify(first).slice(0, 500),
          false,
        );
      }
    }

    throw new VeoApiError(
      `Veo timeout después de ${this.pollTimeoutMs} ms`,
      408,
      '',
      true,
    );
  }
}
