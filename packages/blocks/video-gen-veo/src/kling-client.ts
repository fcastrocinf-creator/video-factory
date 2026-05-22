// Kling AI image-to-video client.
//
// Auth: JWT HS256 con payload { iss: accessKey, exp: now+1800, nbf: now-5 }
//       firmado con secretKey. Header en cada request: Authorization: Bearer <JWT>.
// Base URL: https://api-singapore.klingai.com (oficial global)
// Endpoints:
//   POST /v1/videos/image2video        — submit job, devuelve { data: { task_id } }
//   GET  /v1/videos/image2video/{id}   — poll, devuelve task_status + videos[].url
//
// Modelos disponibles:
//   kling-v1, kling-v1-5, kling-v1-6
//   kling-v2-master (premium, 3-5 min/clip, mejor calidad)
//   kling-v2-1 (rápido balance)
//
// Modos: 'std' (estándar) | 'pro' (más calidad)
// Durations: '5' o '10' segundos
// Aspect ratios: '9:16', '16:9', '1:1'

import { createHmac } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api-singapore.klingai.com';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — Kling V2 puede tardar 3-5 min

// Modelos válidos para image-to-video (basic) según SDK oficial 1.1.0.
// - kling-v3 / kling-v2-6: recomendados (mejor balance velocidad/calidad)
// - kling-v2-master: legacy premium
// - kling-v2-1 / v1-6 / v1-5 / v1: legacy
export type KlingModel =
  | 'kling-v3'
  | 'kling-v2-6'
  | 'kling-v2-master'
  | 'kling-v2-1'
  | 'kling-v1-6'
  | 'kling-v1-5'
  | 'kling-v1';

export type KlingMode = 'std' | 'pro';
export type KlingDuration = '5' | '10';
export type KlingAspectRatio = '16:9' | '9:16' | '1:1';

export interface KlingImageToVideoOptions {
  prompt: string;
  // imagen como base64 raw (sin prefix data:image/...) o como URL pública
  imageBase64?: string;
  imageUrl?: string;
  // Imagen final (opcional, para morph entre dos frames)
  imageTailBase64?: string;
  imageTailUrl?: string;
  negativePrompt?: string;
  cfgScale?: number; // 0-1, default 0.5
  mode?: KlingMode; // std | pro
  duration?: KlingDuration; // '5' | '10'
  aspectRatio?: KlingAspectRatio;
  model?: KlingModel;
  onProgress?: (statusMsg: string) => void;
}

export class KlingApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'KlingApiError';
  }
}

export interface KlingClientOptions {
  accessKey: string;
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  // Retry interno cuando Kling rechaza por código 1303
  // ("parallel task over resource pack limit"). Espera + reintenta.
  // Default 8 retries con backoff 15→20→25...→55s.
  maxParallelRetries?: number;
  parallelRetryBaseWaitMs?: number;
}

interface KlingTaskCreateResponse {
  code: number;
  message: string;
  data?: {
    task_id: string;
    task_status: 'submitted' | 'processing' | 'succeed' | 'failed';
    created_at: number;
  };
}

interface KlingTaskResult {
  code: number;
  message: string;
  data?: {
    task_id: string;
    task_status: 'submitted' | 'processing' | 'succeed' | 'failed';
    task_status_msg?: string;
    task_result?: {
      videos?: Array<{
        id: string;
        url: string;
        duration: string;
      }>;
    };
    created_at?: number;
    updated_at?: number;
  };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Genera JWT HS256 firmado con secretKey, payload requerido por Kling.
 * Sin librerías externas — usa node:crypto.
 */
function generateKlingJwt(accessKey: string, secretKey: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: accessKey,
    exp: now + 1800, // 30 min validez
    nbf: now - 5, // 5s clock skew tolerance
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const signature = createHmac('sha256', secretKey).update(signingInput).digest();
  const encSignature = base64url(signature);
  return `${signingInput}.${encSignature}`;
}

export class KlingClient {
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly maxParallelRetries: number;
  private readonly parallelRetryBaseWaitMs: number;
  private cachedJwt: { token: string; expiresAtMs: number } | null = null;

  constructor(options: KlingClientOptions) {
    if (!options.accessKey || !options.secretKey) {
      throw new Error('KlingClient: accessKey y secretKey son requeridos');
    }
    this.accessKey = options.accessKey;
    this.secretKey = options.secretKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.maxParallelRetries = options.maxParallelRetries ?? 8;
    this.parallelRetryBaseWaitMs = options.parallelRetryBaseWaitMs ?? 15_000;
  }

  private getJwt(): string {
    const now = Date.now();
    if (this.cachedJwt && this.cachedJwt.expiresAtMs > now + 60_000) {
      return this.cachedJwt.token;
    }
    const token = generateKlingJwt(this.accessKey, this.secretKey);
    // expira en 30 min; cacheamos hasta 25 min (buffer 5)
    this.cachedJwt = { token, expiresAtMs: now + 25 * 60 * 1000 };
    return token;
  }

  async generate(opts: KlingImageToVideoOptions): Promise<Buffer> {
    if (!opts.imageBase64 && !opts.imageUrl) {
      throw new KlingApiError('Kling: imageBase64 o imageUrl requerido', 400, '', false);
    }

    // IMPORTANTE: image2video NO acepta aspect_ratio en el body — Kling lo
    // deriva de la imagen input. Si lo enviáramos, Kling rutearía a omni-video
    // en lugar de image2video (confirmado en SDK oficial). `opts.aspectRatio`
    // queda como hint informativo pero NO se envía.
    const body: Record<string, unknown> = {
      model_name: opts.model ?? 'kling-v2-6',
      image: opts.imageBase64 ?? opts.imageUrl,
      prompt: opts.prompt.slice(0, 2500),
      mode: opts.mode ?? 'std',
      duration: opts.duration ?? '5',
    };
    if (opts.negativePrompt) body['negative_prompt'] = opts.negativePrompt.slice(0, 2500);
    if (opts.cfgScale !== undefined) body['cfg_scale'] = opts.cfgScale;
    if (opts.imageTailBase64) body['image_tail'] = opts.imageTailBase64;
    else if (opts.imageTailUrl) body['image_tail'] = opts.imageTailUrl;

    // Retry loop: si Kling responde code=1303 (parallel task over limit),
    // esperamos y reintentamos. Cada retry incrementa wait en +5s (capped a 60s).
    // El "concurrency 5" lo gestiona Kling internamente; nosotros encolamos.
    const submitUrl = `${this.baseUrl}/v1/videos/image2video`;
    let submitData: KlingTaskCreateResponse | null = null;
    let lastErrorMessage = '';

    for (let attempt = 0; attempt <= this.maxParallelRetries; attempt++) {
      const submitResp = await this.fetchImpl(submitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getJwt()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!submitResp.ok) {
        const bodyText = await submitResp.text();
        // 429 con code 1303 (parallel limit): retry con backoff
        if (submitResp.status === 429 && bodyText.includes('1303') && attempt < this.maxParallelRetries) {
          const waitMs = this.parallelRetryBaseWaitMs + attempt * 5000;
          // eslint-disable-next-line no-console
          console.warn(
            `[Kling] 1303 parallel limit, esperando ${(waitMs / 1000).toFixed(0)}s y reintentando (${attempt + 1}/${this.maxParallelRetries})...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          lastErrorMessage = bodyText;
          continue;
        }
        throw new KlingApiError(
          `Kling submit ${submitResp.status} ${submitResp.statusText}: ${bodyText.slice(0, 500)}`,
          submitResp.status,
          bodyText,
          submitResp.status === 429 || submitResp.status >= 500,
        );
      }

      const parsedData = (await submitResp.json()) as KlingTaskCreateResponse;
      // Algunos casos: status 200 pero code=1303 en el body
      if (parsedData.code === 1303 && attempt < this.maxParallelRetries) {
        const waitMs = this.parallelRetryBaseWaitMs + attempt * 5000;
        // eslint-disable-next-line no-console
        console.warn(
          `[Kling] 1303 (body), esperando ${(waitMs / 1000).toFixed(0)}s y reintentando (${attempt + 1}/${this.maxParallelRetries})...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        lastErrorMessage = parsedData.message;
        continue;
      }

      if (parsedData.code !== 0 || !parsedData.data?.task_id) {
        throw new KlingApiError(
          `Kling submit code=${parsedData.code}: ${parsedData.message}`,
          500,
          JSON.stringify(parsedData),
          parsedData.code === 429 || parsedData.code >= 500,
        );
      }
      submitData = parsedData;
      break;
    }

    if (!submitData) {
      throw new KlingApiError(
        `Kling submit falló tras ${this.maxParallelRetries} retries por 1303. Último: ${lastErrorMessage.slice(0, 300)}`,
        429,
        lastErrorMessage,
        true,
      );
    }

    if (!submitData.data?.task_id) {
      throw new KlingApiError('Kling submit OK pero sin task_id', 500, '', false);
    }
    return this.pollUntilDone(submitData.data.task_id, opts.onProgress);
  }

  private async pollUntilDone(
    taskId: string,
    onProgress?: (statusMsg: string) => void,
  ): Promise<Buffer> {
    const deadline = Date.now() + this.pollTimeoutMs;
    const pollUrl = `${this.baseUrl}/v1/videos/image2video/${encodeURIComponent(taskId)}`;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const resp = await this.fetchImpl(pollUrl, {
        headers: { Authorization: `Bearer ${this.getJwt()}` },
      });
      if (!resp.ok) {
        // 5xx en poll: seguimos intentando dentro del deadline
        if (resp.status >= 500) continue;
        const text = await resp.text();
        throw new KlingApiError(
          `Kling poll ${resp.status}: ${text.slice(0, 400)}`,
          resp.status,
          text,
          resp.status === 429,
        );
      }
      const data = (await resp.json()) as KlingTaskResult;
      if (data.code !== 0) {
        throw new KlingApiError(
          `Kling poll code=${data.code}: ${data.message}`,
          500,
          JSON.stringify(data),
          false,
        );
      }
      const status = data.data?.task_status;
      const statusMsg = data.data?.task_status_msg ?? status ?? 'unknown';
      if (onProgress) onProgress(statusMsg);

      if (status === 'failed') {
        throw new KlingApiError(
          `Kling task failed: ${statusMsg}`,
          500,
          JSON.stringify(data),
          false,
        );
      }
      if (status === 'succeed') {
        const videoUrl = data.data?.task_result?.videos?.[0]?.url;
        if (!videoUrl) {
          throw new KlingApiError(
            `Kling succeed pero sin video URL: ${JSON.stringify(data).slice(0, 400)}`,
            200,
            JSON.stringify(data),
            false,
          );
        }
        // Descargamos el MP4 desde la CDN de Kling
        const videoResp = await this.fetchImpl(videoUrl);
        if (!videoResp.ok) {
          throw new KlingApiError(
            `Kling video download ${videoResp.status} desde ${videoUrl}`,
            videoResp.status,
            '',
            true,
          );
        }
        return Buffer.from(await videoResp.arrayBuffer());
      }
      // submitted o processing: seguir esperando
    }

    throw new KlingApiError(
      `Kling poll timeout tras ${this.pollTimeoutMs}ms (task ${taskId})`,
      504,
      '',
      true,
    );
  }
}
