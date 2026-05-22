import { GoogleAuth } from 'google-auth-library';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiTextOptions {
  prompt: string;
  model?: string;
  systemInstruction?: string;
  responseSchema?: Record<string, unknown>;
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

export interface GeminiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  // FALLBACK Vertex AI: cuando AI Studio devuelve 429 con "prepayment depleted",
  // si projectId está seteado, reintentamos la MISMA petición vía Vertex AI
  // (Gemini API expuesta sobre Vertex con billing por proyecto, sin prepay).
  vertexProjectId?: string;
  vertexLocation?: string;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
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

// Cliente mínimo para Gemini text generation con structured output JSON.
// Soporta dos backends:
//   1. Google AI Studio (api key) — primario
//   2. Vertex AI Gemini (OAuth) — fallback automático cuando AI Studio devuelve
//      "prepayment depleted" y la opción vertexProjectId está configurada.
export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly vertexProjectId: string | null;
  private readonly vertexLocation: string;
  private readonly vertexAuth: GoogleAuth | null;
  private cachedVertexToken: { token: string; expiresAtMs: number } | null = null;

  constructor(options: GeminiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.vertexProjectId =
      options.vertexProjectId ?? process.env['GCP_PROJECT_ID'] ?? null;
    this.vertexLocation =
      options.vertexLocation ?? process.env['GCP_LOCATION'] ?? 'us-central1';
    // Inicializamos GoogleAuth solo si tenemos projectId; usa
    // GOOGLE_APPLICATION_CREDENTIALS del env automáticamente.
    this.vertexAuth = this.vertexProjectId
      ? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
      : null;
  }

  async generateJson<T>(opts: GeminiTextOptions): Promise<T> {
    try {
      return await this.callAiStudio<T>(opts);
    } catch (e) {
      if (
        e instanceof GeminiApiError &&
        e.statusCode === 429 &&
        isPrepayDepletedError(e.message, e.responseBody) &&
        this.vertexAuth &&
        this.vertexProjectId
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          '[GeminiClient] AI Studio prepay depleted, falling back to Vertex AI Gemini',
        );
        return await this.callVertex<T>(opts);
      }
      throw e;
    }
  }

  private async callAiStudio<T>(opts: GeminiTextOptions): Promise<T> {
    const model = opts.model ?? 'gemini-2.5-flash';
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: opts.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    };
    if (opts.systemInstruction) {
      body['systemInstruction'] = { parts: [{ text: opts.systemInstruction }] };
    }
    if (opts.responseSchema) {
      (body['generationConfig'] as Record<string, unknown>)['responseSchema'] = opts.responseSchema;
    }

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return await this.parseResponse<T>(resp);
  }

  private async callVertex<T>(opts: GeminiTextOptions): Promise<T> {
    if (!this.vertexAuth || !this.vertexProjectId) {
      throw new GeminiApiError('Vertex AI fallback no configurado (falta GCP_PROJECT_ID)', 500, '');
    }
    const model = opts.model ?? 'gemini-2.5-flash';
    const url = `https://${this.vertexLocation}-aiplatform.googleapis.com/v1/projects/${this.vertexProjectId}/locations/${this.vertexLocation}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

    // Vertex AI Gemini REQUIERE role en cada content (AI Studio no). Sin role
    // devuelve 400 "Please use a valid role: user, model."
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    };
    if (opts.systemInstruction) {
      // systemInstruction NO lleva role en Vertex (sí en algunas versiones de AI
      // Studio). Sólo parts.
      body['systemInstruction'] = { parts: [{ text: opts.systemInstruction }] };
    }
    if (opts.responseSchema) {
      (body['generationConfig'] as Record<string, unknown>)['responseSchema'] = opts.responseSchema;
    }

    const token = await this.getVertexToken();
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return await this.parseResponse<T>(resp);
  }

  private async parseResponse<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new GeminiApiError(
        `Gemini ${resp.status} ${resp.statusText}: ${errBody.slice(0, 500)}`,
        resp.status,
        errBody,
      );
    }

    const data = (await resp.json()) as GeminiResponseBody & {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
        safetyRatings?: Array<{ category: string; probability: string }>;
      }>;
      promptFeedback?: { blockReason?: string };
    };
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    const finishReason = candidate?.finishReason ?? 'UNKNOWN';

    // Si Gemini cortó por SAFETY o MAX_TOKENS, no hay JSON útil — propagamos
    // como GeminiApiError con código específico para que el caller decida si
    // hacer retry o caer a fallback.
    if (!text) {
      const blockReason = data.promptFeedback?.blockReason;
      throw new GeminiApiError(
        `Gemini sin texto (finishReason=${finishReason}${blockReason ? `, blockReason=${blockReason}` : ''})`,
        200,
        JSON.stringify({ finishReason, blockReason, safetyRatings: candidate?.safetyRatings }).slice(0, 500),
      );
    }

    // Si finishReason no es STOP (terminó normal), el output puede estar
    // truncado o cortado por safety. Lo loggeamos en el body para diagnosis,
    // pero intentamos parsear igual — a veces es JSON válido aunque cortado.
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new GeminiApiError(
        `Gemini devolvió texto no-JSON (finishReason=${finishReason}): ${text.slice(0, 200)}`,
        200,
        text,
      );
    }
    // Si el finishReason indica truncamiento/safety y el JSON quedó sospechoso
    // (sin propiedades esperadas o vacío), señalamos al caller con error retryable.
    if (
      (finishReason === 'MAX_TOKENS' || finishReason === 'SAFETY' || finishReason === 'RECITATION') &&
      typeof parsed === 'object' &&
      parsed !== null &&
      Object.keys(parsed as Record<string, unknown>).length === 0
    ) {
      throw new GeminiApiError(
        `Gemini cortó respuesta (finishReason=${finishReason}) y devolvió JSON vacío`,
        finishReason === 'SAFETY' || finishReason === 'RECITATION' ? 422 : 503,
        text,
      );
    }
    return parsed;
  }

  private async getVertexToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedVertexToken && this.cachedVertexToken.expiresAtMs > now + 60_000) {
      return this.cachedVertexToken.token;
    }
    const client = await this.vertexAuth!.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) {
      throw new GeminiApiError(
        'Vertex AI: no se pudo obtener access token (revisar GOOGLE_APPLICATION_CREDENTIALS)',
        500,
        '',
      );
    }
    this.cachedVertexToken = { token: tokenResp.token, expiresAtMs: now + 50 * 60 * 1000 };
    return tokenResp.token;
  }
}
