import { GoogleAuth } from 'google-auth-library';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_POLL_INTERVAL_MS = 6000;
const DEFAULT_POLL_TIMEOUT_MS = 6 * 60 * 1000; // 6 min — Veo Lite suele tardar 1-3 min

function isPrepayDepletedError(message: string, responseBody: string): boolean {
  const haystack = `${message}\n${responseBody}`;
  return (
    /prepayment|prepay/i.test(haystack) ||
    /RESOURCE_EXHAUSTED/i.test(haystack) ||
    /credits are depleted/i.test(haystack)
  );
}

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
  // FALLBACK Vertex AI: cuando AI Studio devuelve 429 "prepayment depleted",
  // si projectId está seteado, reintentamos vía Vertex AI Veo (mismo modelo,
  // billing por proyecto). Lee GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS.
  vertexProjectId?: string;
  vertexLocation?: string;
}

export class VeoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly vertexProjectId: string | null;
  private readonly vertexLocation: string;
  private readonly vertexAuth: GoogleAuth | null;
  private cachedVertexToken: { token: string; expiresAtMs: number } | null = null;

  constructor(options: VeoClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.vertexProjectId =
      options.vertexProjectId ?? process.env['GCP_PROJECT_ID'] ?? null;
    this.vertexLocation =
      options.vertexLocation ?? process.env['GCP_LOCATION'] ?? 'us-central1';
    this.vertexAuth = this.vertexProjectId
      ? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
      : null;
  }

  async generate(opts: VeoGenerateOptions): Promise<Buffer> {
    try {
      return await this.generateAiStudio(opts);
    } catch (e) {
      if (
        e instanceof VeoApiError &&
        e.statusCode === 429 &&
        isPrepayDepletedError(e.message, e.responseBody) &&
        this.vertexAuth &&
        this.vertexProjectId
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          '[VeoClient] AI Studio prepay depleted, falling back to Vertex AI Veo',
        );
        return await this.generateVertex(opts);
      }
      throw e;
    }
  }

  private async generateAiStudio(opts: VeoGenerateOptions): Promise<Buffer> {
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

  private async generateVertex(opts: VeoGenerateOptions): Promise<Buffer> {
    if (!this.vertexAuth || !this.vertexProjectId) {
      throw new VeoApiError(
        'Vertex AI Veo fallback no configurado (falta GCP_PROJECT_ID).',
        500,
        '',
        false,
      );
    }
    const aiStudioModel = opts.model ?? 'veo-3.1-lite-generate-preview';
    // Mapeo AI Studio → Vertex: los nombres de modelo Veo difieren entre backends.
    // AI Studio expone `veo-3.1-*-generate-preview`; Vertex expone `veo-3.0-*-generate-001`
    // (los preview de 3.1 todavía no son GA en Vertex).
    const VERTEX_MODEL_MAP: Record<string, string> = {
      'veo-3.1-lite-generate-preview': 'veo-3.0-fast-generate-001',
      'veo-3.1-fast-generate-001': 'veo-3.0-fast-generate-001',
      'veo-3.1-generate-001': 'veo-3.0-generate-001',
    };
    const model = VERTEX_MODEL_MAP[aiStudioModel] ?? aiStudioModel;
    const url = `https://${this.vertexLocation}-aiplatform.googleapis.com/v1/projects/${this.vertexProjectId}/locations/${this.vertexLocation}/publishers/google/models/${encodeURIComponent(model)}:predictLongRunning`;

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
    if (opts.personGeneration) parameters['personGeneration'] = opts.personGeneration;
    if (opts.negativePrompt) parameters['negativePrompt'] = opts.negativePrompt;

    const token = await this.getVertexToken();
    const startResp = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ instances: [instance], parameters }),
    });

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new VeoApiError(
        `Vertex Veo predictLongRunning ${startResp.status} ${startResp.statusText}: ${body.slice(0, 500)}`,
        startResp.status,
        body,
        startResp.status === 429 || startResp.status >= 500,
      );
    }

    const { name } = (await startResp.json()) as { name?: string };
    if (!name) {
      throw new VeoApiError('Vertex Veo respondió sin operation name.', 200, '', false);
    }
    return this.pollOperationVertex(name, model, opts.onProgress);
  }

  private async getVertexToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedVertexToken && this.cachedVertexToken.expiresAtMs > now + 60_000) {
      return this.cachedVertexToken.token;
    }
    const client = await this.vertexAuth!.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) {
      throw new VeoApiError(
        'Vertex AI Veo: no se pudo obtener access token (revisar GOOGLE_APPLICATION_CREDENTIALS).',
        500,
        '',
        false,
      );
    }
    this.cachedVertexToken = { token: tokenResp.token, expiresAtMs: now + 50 * 60 * 1000 };
    return tokenResp.token;
  }

  private async pollOperationVertex(
    operationName: string,
    model: string,
    onProgress?: (percent: number) => void,
  ): Promise<Buffer> {
    const deadline = Date.now() + this.pollTimeoutMs;
    // Vertex Veo NO usa GET sobre el operation path. Usa POST a
    // {region}-aiplatform.googleapis.com/v1/{model_path}:fetchPredictOperation
    // con body { operationName }. Ese endpoint devuelve la misma estructura de Operation.
    const pollUrl = `https://${this.vertexLocation}-aiplatform.googleapis.com/v1/projects/${this.vertexProjectId}/locations/${this.vertexLocation}/publishers/google/models/${encodeURIComponent(model)}:fetchPredictOperation`;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const token = await this.getVertexToken();
      const resp = await this.fetchImpl(pollUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationName }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new VeoApiError(
          `Vertex Veo operation poll ${resp.status}: ${body.slice(0, 400)}`,
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
            `Vertex Veo operation falló: ${op.error.message}`,
            op.error.code,
            JSON.stringify(op.error),
            false,
          );
        }
        // Vertex Veo tiene MÚLTIPLES shapes posibles de respuesta según versión:
        //   - response.generateVideoResponse.generatedSamples[].video (legacy AI-Studio-like)
        //   - response.generatedVideos[].{bytesBase64Encoded|gcsUri|video.uri}
        //   - response.videos[].{bytesBase64Encoded|gcsUri|video.uri}
        //   - response.predictions[].{bytesBase64Encoded|gcsUri|videoUri}
        // Probamos en orden, tomamos lo primero que tenga datos válidos.
        const respAny = (op.response ?? {}) as Record<string, unknown>;
        type VideoCandidate = {
          bytesBase64Encoded?: string;
          uri?: string;
          gcsUri?: string;
          videoUri?: string;
          mimeType?: string;
        };
        let candidate: VideoCandidate | null = null;
        let raiFiltered = false;
        let raiReasons: string[] = [];

        const tryPath = (arr: unknown): VideoCandidate | null => {
          if (!Array.isArray(arr) || arr.length === 0) return null;
          const item = arr[0] as Record<string, unknown>;
          // Nested .video field (AI Studio shape)
          if (item['video'] && typeof item['video'] === 'object') {
            return item['video'] as VideoCandidate;
          }
          return item as VideoCandidate;
        };

        // Vertex pone los campos directamente en op.response (con @type
        // GenerateVideoResponse). AI Studio los anida bajo response.generateVideoResponse.
        // Soportamos ambas.
        const genVideoNested = respAny['generateVideoResponse'] as Record<string, unknown> | undefined;
        const genVideoSource = genVideoNested ?? respAny; // Vertex: directo en respAny

        if (
          typeof genVideoSource['raiMediaFilteredCount'] === 'number' &&
          (genVideoSource['raiMediaFilteredCount'] as number) > 0
        ) {
          raiFiltered = true;
          raiReasons = (genVideoSource['raiMediaFilteredReasons'] as string[]) ?? [];
        }
        if (!candidate) candidate = tryPath(genVideoSource['generatedSamples']);
        if (!candidate) candidate = tryPath(respAny['generatedVideos']);
        if (!candidate) candidate = tryPath(respAny['videos']);
        if (!candidate) candidate = tryPath(respAny['predictions']);

        if (raiFiltered) {
          throw new VeoApiError(
            `Vertex Veo filtró el contenido por safety/policy: ${raiReasons.join(' | ') || 'sin detalle'}`,
            403,
            JSON.stringify(respAny).slice(0, 500),
            false,
          );
        }
        if (!candidate) {
          throw new VeoApiError(
            'Vertex Veo done sin video en ninguna shape conocida. Body: ' +
              JSON.stringify(respAny).slice(0, 800),
            200,
            JSON.stringify(op).slice(0, 800),
            false,
          );
        }

        if (candidate.bytesBase64Encoded) {
          return Buffer.from(candidate.bytesBase64Encoded, 'base64');
        }
        const downloadUri = candidate.uri ?? candidate.gcsUri ?? candidate.videoUri;
        if (downloadUri) {
          const token = await this.getVertexToken();
          // Si es gs://, hay que convertir a https://storage.cloud.google.com/...
          let httpUri = downloadUri;
          if (httpUri.startsWith('gs://')) {
            httpUri = `https://storage.googleapis.com/${httpUri.slice('gs://'.length)}`;
          }
          const videoResp = await this.fetchImpl(httpUri, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!videoResp.ok) {
            const body = await videoResp.text();
            throw new VeoApiError(
              `No se pudo descargar video Vertex desde ${httpUri}: ${videoResp.status}`,
              videoResp.status,
              body.slice(0, 500),
              true,
            );
          }
          return Buffer.from(await videoResp.arrayBuffer());
        }
        throw new VeoApiError(
          'Vertex Veo candidate sin bytes ni URI. Body: ' + JSON.stringify(candidate).slice(0, 500),
          200,
          JSON.stringify(candidate).slice(0, 500),
          false,
        );
      }
    }
    throw new VeoApiError(
      `Vertex Veo poll timeout tras ${this.pollTimeoutMs}ms.`,
      504,
      '',
      true,
    );
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
