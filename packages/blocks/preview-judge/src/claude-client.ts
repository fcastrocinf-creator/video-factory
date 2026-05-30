// claude-client.ts — wrapper fetch de Anthropic Messages API.
// No usamos el SDK oficial @anthropic-ai/sdk para evitar dependencia extra
// y mantener control directo sobre headers, timeouts y parseo.
//
// ⚠️ DEPRECATED (M7 Pieza C v2, 25-may-2026): el `judge.ts` ya NO usa este
// módulo — fue migrado a `judgeWithClaude` de @video-factory/core. Este
// archivo queda como capa de compat para callers EXTERNOS que importen
// `callClaude` o `buildImageMessage` desde `@video-factory/block-preview-judge`.
// Para código NUEVO usar `judgeWithClaude` / `callAnthropicMessages` /
// `buildImageMessageContent` desde `@video-factory/core` directamente.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeMessageContentText {
  type: 'text';
  text: string;
}

export interface ClaudeMessageContentImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
  };
}

export type ClaudeMessageContent =
  | ClaudeMessageContentText
  | ClaudeMessageContentImage;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeMessageContent[];
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string;
  temperature?: number;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: string;
  usage: ClaudeUsage;
}

export interface ClaudeError extends Error {
  status?: number;
  detail?: string;
}

/**
 * Llama a Anthropic Messages API. Retorna la response cruda.
 * El caller es responsable de parsear el texto del response.content[0].text.
 *
 * Lanza Error con `.status` y `.detail` si la API responde con error.
 */
export async function callClaude(
  request: ClaudeRequest,
  options: { apiKey: string; timeoutMs?: number } = { apiKey: '' },
): Promise<ClaudeResponse> {
  if (!options.apiKey) {
    throw new Error('ANTHROPIC_API_KEY no provista al callClaude()');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const err = e as Error;
    const wrapped: ClaudeError = new Error(
      `Anthropic fetch error: ${err.message}`,
    ) as ClaudeError;
    wrapped.detail = err.name === 'AbortError' ? 'timeout' : err.message;
    throw wrapped;
  }
  clearTimeout(timeoutId);

  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      detail = parsed.error?.message ?? text;
    } catch {
      // body no es JSON; usar el texto raw
    }
    const err: ClaudeError = new Error(
      `Anthropic API ${resp.status}: ${detail.slice(0, 300)}`,
    ) as ClaudeError;
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }

  return JSON.parse(text) as ClaudeResponse;
}

/**
 * Helper: arma el bloque content para una user-message con imagen + texto.
 */
export function buildImageMessage(
  imageBuffer: Buffer,
  text: string,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
): ClaudeMessageContent[] {
  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: imageBuffer.toString('base64'),
      },
    },
    {
      type: 'text',
      text,
    },
  ];
}
