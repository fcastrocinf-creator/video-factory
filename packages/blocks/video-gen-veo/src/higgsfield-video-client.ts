// higgsfield-video-client.ts — image-to-video con Higgsfield API V2 (DoP model).
//
// Endpoint REAL (verificado contra @higgsfield/client SDK oficial main branch):
//   POST /v1/image2video/dop
//
// Flujo correcto:
//   1) Upload image: POST /files/generate-upload-url → {upload_url, public_url}
//      PUT image bytes a upload_url
//   2) Submit job: POST /v1/image2video/dop body:
//      { model: 'dop-turbo'|'dop-lite'|'dop-standard',
//        prompt, input_images: [{type:'image_url', image_url: public_url}] }
//   3) Poll: GET /requests/{request_id}/status hasta status=completed|failed|nsfw
//
// IMPORTANTE: el modelo Soul es text-to-image, NO image-to-video. La versión
// previa de este cliente asumía `image-to-video/soul/standard` que retornaba 404.
// DoP (Director of Photography) es el motor correcto para image-to-video en Higgsfield.
//
// Variantes DoP (según SDK helpers.ts):
//   - dop-lite      → velocidad básica, calidad básica (más barato)
//   - dop-turbo     → 2x speed + priority queue (recomendado UGC)
//   - dop-standard  → highest quality + priority queue

const BASE_URL = 'https://platform.higgsfield.ai';

export type HiggsfieldVideoModel = 'dop-lite' | 'dop-turbo' | 'dop-standard';

type V2RequestStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';

interface V2VideoResponse {
  status: V2RequestStatus;
  request_id: string;
  status_url?: string;
  cancel_url?: string;
  // El API puede devolver el video en varias shapes según el modelo / versión.
  // Soportamos todas las que hemos visto en docs + SDK.
  video?: { url: string };
  videos?: Array<{ url: string }>;
  jobs?: Array<{
    results?: {
      raw?: { url: string };
      min?: { url: string };
    };
  }>;
}

interface UploadLinkResponse {
  upload_url: string;
  public_url: string;
}

export interface HiggsfieldVideoClientOptions {
  keyId: string;
  keySecret: string;
  defaultModel?: HiggsfieldVideoModel;
  fetchImpl?: typeof fetch;
  maxPollTimeMs?: number;
  pollIntervalMs?: number;
}

export interface HiggsfieldVideoRequest {
  prompt: string;
  imageBase64: string;
  imageMimeType?: 'image/png' | 'image/jpeg';
  aspectRatio?: '9:16' | '16:9' | '1:1';
  durationSec?: 5 | 10;
  model?: HiggsfieldVideoModel;
  /** Callback con status updates si poll está activo */
  onProgress?: (status: string) => void;
}

export class HiggsfieldVideoError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly isOutOfCredits: boolean;
  readonly isNsfw: boolean;

  constructor(
    message: string,
    status: number,
    bodyText: string,
    isOutOfCredits: boolean,
    isNsfw: boolean,
  ) {
    super(message);
    this.name = 'HiggsfieldVideoError';
    this.status = status;
    this.bodyText = bodyText;
    this.isOutOfCredits = isOutOfCredits;
    this.isNsfw = isNsfw;
  }
}

export class HiggsfieldVideoClient {
  private readonly authHeader: string;
  private readonly defaultModel: HiggsfieldVideoModel;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPollTimeMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: HiggsfieldVideoClientOptions) {
    this.authHeader = `Key ${opts.keyId}:${opts.keySecret}`;
    this.defaultModel = opts.defaultModel ?? 'dop-turbo';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Video tarda más que imagen — hasta 5 min queue + 60-180s render
    this.maxPollTimeMs = opts.maxPollTimeMs ?? 600_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  }

  /**
   * 1) Solicita una URL firmada de upload al CDN de Higgsfield,
   * 2) sube los bytes de la imagen,
   * 3) devuelve la public_url usable como input_image en el submit.
   */
  private async uploadImage(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const linkResp = await this.fetchImpl(`${BASE_URL}/files/generate-upload-url`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content_type: mimeType }),
    });
    if (!linkResp.ok) {
      const bodyText = await linkResp.text();
      throw new HiggsfieldVideoError(
        `Higgsfield upload-url ${linkResp.status} ${linkResp.statusText}: ${bodyText.slice(0, 300)}`,
        linkResp.status,
        bodyText,
        false,
        false,
      );
    }
    const link = (await linkResp.json()) as UploadLinkResponse;
    if (!link.upload_url || !link.public_url) {
      throw new HiggsfieldVideoError(
        `Higgsfield upload-url respuesta sin upload_url/public_url`,
        500,
        JSON.stringify(link).slice(0, 200),
        false,
        false,
      );
    }

    // PUT bytes al CDN. NO auth header acá — la URL firmada ya autoriza.
    const putResp = await this.fetchImpl(link.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: new Uint8Array(imageBuffer),
    });
    if (!putResp.ok) {
      const bodyText = await putResp.text();
      throw new HiggsfieldVideoError(
        `Higgsfield CDN upload PUT ${putResp.status}: ${bodyText.slice(0, 300)}`,
        putResp.status,
        bodyText,
        false,
        false,
      );
    }
    return link.public_url;
  }

  async generate(req: HiggsfieldVideoRequest): Promise<Buffer> {
    const model = req.model ?? this.defaultModel;
    const mimeType = req.imageMimeType ?? 'image/png';

    // PASO 1: upload de imagen → public_url
    const imageBuffer = Buffer.from(req.imageBase64, 'base64');
    const imageUrl = await this.uploadImage(imageBuffer, mimeType);
    req.onProgress?.('uploaded');

    // PASO 2: submit del job de generación.
    // El endpoint /v1/image2video/dop espera body envuelto en {params: {...}}
    // (estilo V1 del SDK oficial — verificado con 422 "missing body.params").
    const submitUrl = `${BASE_URL}/v1/image2video/dop`;
    const body = {
      params: {
        model,
        prompt: req.prompt,
        input_images: [
          {
            type: 'image_url',
            image_url: imageUrl,
          },
        ],
        // Higgsfield DoP infiere aspect_ratio de la imagen subida.
        // duration / quality opcionales según versión del modelo.
        duration: req.durationSec ?? 5,
      },
    };

    const submitResp = await this.fetchImpl(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!submitResp.ok) {
      const bodyText = await submitResp.text();
      const isOutOfCredits =
        (submitResp.status === 402 || submitResp.status === 403) &&
        /credit|quota|insufficient|not enough|balance/i.test(bodyText);
      throw new HiggsfieldVideoError(
        `Higgsfield video ${submitResp.status} ${submitResp.statusText}: ${bodyText.slice(0, 400)}`,
        submitResp.status,
        bodyText,
        isOutOfCredits,
        false,
      );
    }

    let response = (await submitResp.json()) as V2VideoResponse;
    req.onProgress?.(response.status);

    // Sync completion (raro en image-to-video pero por si acaso)
    const directUrl = this.extractVideoUrl(response);
    if (response.status === 'completed' && directUrl) {
      return this.downloadVideo(directUrl);
    }

    if (!response.request_id) {
      throw new HiggsfieldVideoError(
        `Higgsfield video response sin request_id`,
        500,
        JSON.stringify(response).slice(0, 300),
        false,
        false,
      );
    }

    response = await this.poll(response.request_id, req.onProgress);

    if (response.status === 'failed') {
      throw new HiggsfieldVideoError(
        `Higgsfield video job failed`,
        500,
        JSON.stringify(response).slice(0, 300),
        false,
        false,
      );
    }
    if (response.status === 'nsfw') {
      throw new HiggsfieldVideoError(
        `Higgsfield video rejected as NSFW`,
        400,
        JSON.stringify(response).slice(0, 200),
        false,
        true,
      );
    }
    const finalUrl = this.extractVideoUrl(response);
    if (!finalUrl) {
      throw new HiggsfieldVideoError(
        `Higgsfield completed pero sin video.url`,
        200,
        JSON.stringify(response).slice(0, 300),
        false,
        false,
      );
    }
    return this.downloadVideo(finalUrl);
  }

  /**
   * El API devuelve el video URL en varias shapes según el endpoint:
   *   - response.video.url        (formato simple)
   *   - response.videos[0].url    (legacy)
   *   - response.jobs[0].results.raw.url  (formato v2 reciente)
   */
  private extractVideoUrl(response: V2VideoResponse): string | undefined {
    return (
      response.video?.url ??
      response.videos?.[0]?.url ??
      response.jobs?.[0]?.results?.raw?.url ??
      response.jobs?.[0]?.results?.min?.url
    );
  }

  private async poll(
    requestId: string,
    onProgress?: (status: string) => void,
  ): Promise<V2VideoResponse> {
    const statusUrl = `${BASE_URL}/requests/${requestId}/status`;
    const deadline = Date.now() + this.maxPollTimeMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const resp = await this.fetchImpl(statusUrl, {
        method: 'GET',
        headers: { Authorization: this.authHeader },
      });
      if (!resp.ok) {
        const bodyText = await resp.text();
        throw new HiggsfieldVideoError(
          `Higgsfield poll ${resp.status}: ${bodyText.slice(0, 200)}`,
          resp.status,
          bodyText,
          false,
          false,
        );
      }
      const json = (await resp.json()) as V2VideoResponse;
      onProgress?.(json.status);
      if (
        json.status === 'completed' ||
        json.status === 'failed' ||
        json.status === 'nsfw'
      ) {
        return json;
      }
    }
    throw new HiggsfieldVideoError(
      `Higgsfield video timeout después de ${this.maxPollTimeMs}ms`,
      408,
      '',
      false,
      false,
    );
  }

  private async downloadVideo(url: string): Promise<Buffer> {
    const resp = await this.fetchImpl(url);
    if (!resp.ok) {
      throw new HiggsfieldVideoError(
        `Higgsfield video download ${resp.status}`,
        resp.status,
        '',
        false,
        false,
      );
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}
