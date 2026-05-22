import { GoogleAuth } from 'google-auth-library';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-pro';

export interface GeminiVisionOptions {
  // PNG/JPEG buffer to analyze.
  imageBuffer: Buffer;
  // Mime type of the image — defaults to image/png.
  mimeType?: 'image/png' | 'image/jpeg';
  // Texto del prompt que se envía al modelo para evaluar la imagen.
  prompt: string;
  systemInstruction?: string;
  model?: string;
  responseSchema?: Record<string, unknown>;
}

export class GeminiVisionApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'GeminiVisionApiError';
  }
}

export interface GeminiVisionClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  // Fallback Vertex AI: cuando AI Studio devuelve 429 prepay-depleted,
  // si vertexProjectId está seteado, reintentamos vía Vertex AI Gemini.
  vertexProjectId?: string;
  vertexLocation?: string;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

function isPrepayDepletedError(message: string, responseBody: string): boolean {
  const haystack = `${message}\n${responseBody}`;
  return (
    /prepayment|prepay/i.test(haystack) ||
    /RESOURCE_EXHAUSTED/i.test(haystack) ||
    /credits are depleted/i.test(haystack)
  );
}

/**
 * Cliente Gemini que acepta una imagen como input (multimodal) y devuelve JSON
 * estructurado. Usado por scene-validator para evaluar si una imagen generada
 * cumple con el prompt y no tiene errores anatómicos.
 *
 * Soporta dos backends:
 *   1. Google AI Studio (api key) — primario
 *   2. Vertex AI Gemini (OAuth) — fallback automático cuando AI Studio devuelve
 *      "prepayment depleted" y la opción vertexProjectId está configurada.
 */
export class GeminiVisionClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly vertexProjectId: string | null;
  private readonly vertexLocation: string;
  private readonly vertexAuth: GoogleAuth | null;
  private cachedVertexToken: { token: string; expiresAtMs: number } | null = null;

  constructor(options: GeminiVisionClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.vertexProjectId =
      options.vertexProjectId ?? process.env['GCP_PROJECT_ID'] ?? null;
    this.vertexLocation =
      options.vertexLocation ?? process.env['GCP_LOCATION'] ?? 'us-central1';
    this.vertexAuth = this.vertexProjectId
      ? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
      : null;
  }

  async generateJson<T>(opts: GeminiVisionOptions): Promise<T> {
    try {
      return await this.callAiStudio<T>(opts);
    } catch (e) {
      if (
        e instanceof GeminiVisionApiError &&
        e.statusCode === 429 &&
        isPrepayDepletedError(e.message, e.responseBody) &&
        this.vertexAuth &&
        this.vertexProjectId
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          '[GeminiVisionClient] AI Studio prepay depleted, falling back to Vertex AI Gemini',
        );
        return await this.callVertex<T>(opts);
      }
      throw e;
    }
  }

  private buildBody(opts: GeminiVisionOptions, vertex = false): Record<string, unknown> {
    const inlineData = {
      mimeType: opts.mimeType ?? 'image/png',
      data: opts.imageBuffer.toString('base64'),
    };
    // Vertex requiere role:'user' en cada content (AI Studio lo asume).
    const userContent = vertex
      ? { role: 'user', parts: [{ inlineData }, { text: opts.prompt }] }
      : { parts: [{ inlineData }, { text: opts.prompt }] };
    const body: Record<string, unknown> = {
      contents: [userContent],
      generationConfig: { responseMimeType: 'application/json' },
    };
    if (opts.systemInstruction) {
      body['systemInstruction'] = { parts: [{ text: opts.systemInstruction }] };
    }
    if (opts.responseSchema) {
      (body['generationConfig'] as Record<string, unknown>)['responseSchema'] = opts.responseSchema;
    }
    return body;
  }

  private async callAiStudio<T>(opts: GeminiVisionOptions): Promise<T> {
    const model = opts.model ?? DEFAULT_MODEL;
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildBody(opts)),
    });

    return await this.parseResponse<T>(resp);
  }

  private async callVertex<T>(opts: GeminiVisionOptions): Promise<T> {
    if (!this.vertexAuth || !this.vertexProjectId) {
      throw new GeminiVisionApiError(
        'Vertex AI fallback no configurado (falta GCP_PROJECT_ID)',
        500,
        '',
      );
    }
    const model = opts.model ?? DEFAULT_MODEL;
    const url = `https://${this.vertexLocation}-aiplatform.googleapis.com/v1/projects/${this.vertexProjectId}/locations/${this.vertexLocation}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

    const token = await this.getVertexToken();
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildBody(opts, true)),
    });

    return await this.parseResponse<T>(resp);
  }

  private async parseResponse<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new GeminiVisionApiError(
        `Gemini Vision ${resp.status} ${resp.statusText}: ${errBody.slice(0, 500)}`,
        resp.status,
        errBody,
      );
    }

    const data = (await resp.json()) as GeminiResponseBody;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new GeminiVisionApiError(
        `Gemini Vision sin candidates[0].content.parts[0].text (finishReason=${data.candidates?.[0]?.finishReason ?? '?'})`,
        200,
        JSON.stringify(data).slice(0, 500),
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiVisionApiError(
        `Gemini Vision devolvió texto no-JSON: ${text.slice(0, 200)}`,
        200,
        text,
      );
    }
  }

  private async getVertexToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedVertexToken && this.cachedVertexToken.expiresAtMs > now + 60_000) {
      return this.cachedVertexToken.token;
    }
    const client = await this.vertexAuth!.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) {
      throw new GeminiVisionApiError(
        'Vertex AI: no se pudo obtener access token (revisar GOOGLE_APPLICATION_CREDENTIALS)',
        500,
        '',
      );
    }
    this.cachedVertexToken = { token: tokenResp.token, expiresAtMs: now + 50 * 60 * 1000 };
    return tokenResp.token;
  }
}
