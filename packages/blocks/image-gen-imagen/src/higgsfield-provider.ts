// Provider para Higgsfield Cloud API V2 — Flux Pro Kontext Max y otros.
// API real (extraída del SDK oficial @higgsfield/client/v2):
//   - Submit: POST {baseURL}/{model_endpoint} con body { prompt, aspect_ratio, ... }
//   - Header: Authorization: Key KEY_ID:KEY_SECRET
//   - Response: { status, request_id, status_url, images?, video? }
//   - Poll: GET {baseURL}/requests/{request_id}/status
//   - Status values: queued | in_progress | completed | failed | nsfw

import type { AspectRatio } from './client.js';
import { ImageProviderError, type ImageGenerationRequest, type ImageProvider } from './provider.js';

const BASE_URL = 'https://platform.higgsfield.ai';

export interface HiggsfieldImageProviderOptions {
  keyId: string;
  keySecret: string;
  defaultModel?: string;
  name?: string;
  fetchImpl?: typeof fetch;
  maxPollTimeMs?: number;
  pollIntervalMs?: number;
}

type V2RequestStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';

interface V2Response {
  status: V2RequestStatus;
  request_id: string;
  status_url?: string;
  cancel_url?: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
}

const ASPECT_TO_HIGGSFIELD: Record<AspectRatio, string> = {
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '3:4': '3:4',
  '4:3': '4:3',
};

export class HiggsfieldImageProvider implements ImageProvider {
  readonly name: string;
  private readonly authHeader: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPollTimeMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: HiggsfieldImageProviderOptions) {
    this.name = opts.name ?? 'higgsfield';
    this.authHeader = `Key ${opts.keyId}:${opts.keySecret}`;
    this.defaultModel = opts.defaultModel ?? 'flux-pro/kontext/max/text-to-image';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // 5 min timeout: Higgsfield queue puede estar ocupada en horas pico
    this.maxPollTimeMs = opts.maxPollTimeMs ?? 300_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  }

  async generate(req: ImageGenerationRequest): Promise<Buffer> {
    const modelPath = (req.model ?? this.defaultModel).replace(/^\//, '');
    const aspectRatio = ASPECT_TO_HIGGSFIELD[req.aspectRatio] ?? req.aspectRatio;

    // Submit job — body directo (no wrappeado en `input`)
    const submitUrl = `${BASE_URL}/${modelPath}`;
    const submitResp = await this.fetchImpl(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspect_ratio: aspectRatio,
        // safety_tolerance: 0=most strict, 6=least strict. Para contenido médico
        // legítimo (anatomía, tejidos digestivos, fatiga) necesitamos máximo permitido.
        // Higgsfield/Flux Pro acepta hasta 6 según docs.
        safety_tolerance: 6,
      }),
    });

    if (!submitResp.ok) {
      const bodyText = await submitResp.text();
      // 402/403 + "credit" en body = créditos agotados → marca para que chain salte
      const isOutOfCredits =
        (submitResp.status === 402 || submitResp.status === 403) &&
        /credit|quota|insufficient|not enough/i.test(bodyText);
      throw new ImageProviderError(
        `Higgsfield ${submitResp.status} ${submitResp.statusText}: ${bodyText.slice(0, 400)}`,
        submitResp.status,
        bodyText,
        submitResp.status === 429 || submitResp.status >= 500,
        isOutOfCredits,
        this.name,
      );
    }

    let response = (await submitResp.json()) as V2Response;

    // Si ya viene completo (sync), descargamos directo
    if (response.status === 'completed' && response.images?.[0]?.url) {
      return this.downloadImage(response.images[0].url);
    }

    // Poll si está en queue/progress
    if (!response.request_id) {
      throw new ImageProviderError(
        `Higgsfield response sin request_id`,
        500,
        JSON.stringify(response).slice(0, 300),
        false,
        false,
        this.name,
      );
    }
    response = await this.poll(response.request_id);

    if (response.status === 'failed') {
      throw new ImageProviderError(
        `Higgsfield job failed`,
        500,
        JSON.stringify(response).slice(0, 300),
        false,
        false,
        this.name,
      );
    }
    if (response.status === 'nsfw') {
      throw new ImageProviderError(
        `Higgsfield job rejected as NSFW`,
        400,
        JSON.stringify(response).slice(0, 200),
        false,
        false,
        this.name,
        true, // isContentRejection — chain debe saltar a otro provider
      );
    }
    if (response.status === 'completed') {
      const imgUrl = response.images?.[0]?.url;
      if (!imgUrl) {
        throw new ImageProviderError(
          `Higgsfield completed pero sin images[0].url`,
          200,
          JSON.stringify(response).slice(0, 300),
          false,
          false,
          this.name,
        );
      }
      return this.downloadImage(imgUrl);
    }
    throw new ImageProviderError(
      `Higgsfield unexpected status: ${response.status}`,
      500,
      JSON.stringify(response).slice(0, 200),
      false,
      false,
      this.name,
    );
  }

  private async poll(requestId: string): Promise<V2Response> {
    const start = Date.now();
    const pollUrl = `${BASE_URL}/requests/${requestId}/status`;
    while (Date.now() - start < this.maxPollTimeMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const resp = await this.fetchImpl(pollUrl, {
        headers: { Authorization: this.authHeader },
      });
      if (!resp.ok) {
        // 5xx en poll: seguimos intentando
        if (resp.status >= 500) continue;
        const text = await resp.text();
        throw new ImageProviderError(
          `Higgsfield poll error ${resp.status}: ${text.slice(0, 200)}`,
          resp.status,
          text,
          resp.status === 429,
          false,
          this.name,
        );
      }
      const data = (await resp.json()) as V2Response;
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'nsfw') {
        return data;
      }
    }
    // Timeout = retryable + provider posiblemente saturado: marcar como "skip
    // this provider for this scene" (similar a content rejection) para que el
    // chain pase al siguiente, evitando cascadas de timeouts.
    throw new ImageProviderError(
      `Higgsfield poll timeout after ${this.maxPollTimeMs}ms (provider possibly saturated)`,
      504,
      '',
      true,
      false,
      this.name,
      true, // isContentRejection=true para que chain skipée a otro provider
    );
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const resp = await this.fetchImpl(url);
    if (!resp.ok) {
      throw new ImageProviderError(
        `Higgsfield: error descargando imagen ${resp.status}`,
        resp.status,
        '',
        true,
        false,
        this.name,
      );
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }
}
