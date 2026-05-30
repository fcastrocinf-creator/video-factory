// claude-judge.ts — M7 Pieza C v1
//
// Juez Claude universal reutilizable. Unifica el patrón compartido entre
// M2 (preview-judge), M5 (post-render-judge) y M6 (editor-loop): wrapper HTTP
// + parser JSON robusto + validación Zod + manejo neverthrow.
//
// Por qué este módulo:
//  - Cada bloque tenía su propio fetch + parser + schema-validate casi idéntico.
//  - Bugs típicos (Claude antepone texto al JSON, mete markdown fences) se
//    resolvían por separado en cada bloque → varias copias del mismo fix.
//  - Pieza C v2 (siguiente) migra los juezes existentes a importar de acá;
//    por ahora v1 expone los primitivos para que NUEVOS jueces los usen sin
//    duplicación, y migraciones graduales sin riesgo.
//
// Diseño:
//  - `callAnthropicMessages` — HTTP wrapper genérico (timeout, headers, error).
//  - `extractJsonFromClaudeText` — parser tolerante a markdown/texto natural.
//  - `judgeWithClaude<T>` — combinación: call + extract + Zod.safeParse.

import { ok, err, type Result } from 'neverthrow';
import type { z } from 'zod';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
  };
}

export interface ClaudeTextContent {
  type: 'text';
  text: string;
}

export type ClaudeMessageContent = ClaudeImageContent | ClaudeTextContent;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeMessageContent[];
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Bloques que puede devolver Claude en `response.content`. Cuando extended
 * thinking está ENABLED, el response trae bloques 'thinking' Y 'text' mezclados.
 * El bloque 'text' final es el JSON que normalmente parseamos.
 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string };

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: string;
  usage: ClaudeUsage;
}

export interface ClaudeApiError {
  type: 'no-api-key' | 'api-error' | 'timeout' | 'parse-error' | 'schema-error';
  message: string;
  detail?: string;
  status?: number;
}

export interface CallAnthropicOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Sistema prompt opcional (rol del juez) */
  system?: string;
  /** Temperatura. Default 0 (determinístico). */
  temperature?: number;
  messages: ClaudeMessage[];
  /** Timeout en ms. Default 30000. */
  timeoutMs?: number;
  /**
   * Extended thinking — Sonnet 4-5 razona internamente N tokens antes del
   * output final. Cuando está enabled, el response trae bloques 'thinking'
   * mezclados con 'text'. El parser de JSON debe ignorar los 'thinking'.
   * IMPORTANTE: con thinking enabled, temperature DEBE ser 1 (la API lo exige).
   */
  thinking?: {
    type: 'enabled';
    budget_tokens: number;
  };
}

/**
 * Helper: extrae el texto FINAL del response (ignorando bloques 'thinking').
 * Cuando extended thinking está OFF, simplemente devuelve content[0].text.
 * Cuando está ON, concatena todos los bloques 'text' (suele ser uno solo al
 * final pero por las dudas).
 */
export function extractFinalText(response: ClaudeResponse): string {
  const textBlocks = response.content.filter(
    (b): b is { type: 'text'; text: string } => b.type === 'text',
  );
  return textBlocks.map((b) => b.text).join('\n');
}

/**
 * Helper: extrae el razonamiento interno (thinking blocks). Útil para logging
 * y debugging — el owner puede ver QUÉ razonó VALIDATOR antes del verdict.
 */
export function extractThinking(response: ClaudeResponse): string {
  const thinkingBlocks = response.content.filter(
    (b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking',
  );
  return thinkingBlocks.map((b) => b.thinking).join('\n\n');
}

/**
 * HTTP wrapper crudo a Anthropic Messages API. No parsea contenido del response;
 * el caller decide qué hacer con `response.content[0].text`.
 *
 * Lanza Error con `.status` y `.detail` si la API responde con error.
 */
export async function callAnthropicMessages(
  opts: CallAnthropicOptions,
): Promise<Result<ClaudeResponse, ClaudeApiError>> {
  if (!opts.apiKey || opts.apiKey.startsWith('ROTATE_')) {
    return err({ type: 'no-api-key', message: 'ANTHROPIC_API_KEY no configurada' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  let resp: Response;
  try {
    // Anthropic API exige temperature=1 cuando thinking está enabled.
    const effectiveTemperature = opts.thinking ? 1 : (opts.temperature ?? 0);
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1500,
        system: opts.system,
        temperature: effectiveTemperature,
        messages: opts.messages,
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const errObj = e as Error;
    return err({
      type: errObj.name === 'AbortError' ? 'timeout' : 'api-error',
      message: `Anthropic fetch error: ${errObj.message}`,
    });
  }
  clearTimeout(timeoutId);

  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      detail = parsed.error?.message ?? text;
    } catch {
      // body no es JSON; usar texto raw
    }
    return err({
      type: 'api-error',
      message: `Anthropic API ${resp.status}: ${detail.slice(0, 300)}`,
      detail,
      status: resp.status,
    });
  }

  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(text) as ClaudeResponse;
  } catch (e) {
    return err({
      type: 'parse-error',
      message: `Response body no es JSON válido: ${(e as Error).message}`,
      detail: text.slice(0, 300),
    });
  }
  return ok(parsed);
}

/**
 * Parser tolerante de JSON desde respuestas de Claude.
 *
 * Maneja:
 *   - Markdown fences ```json ... ```
 *   - Texto natural antes/después del JSON (Claude a veces narra antes)
 *   - Whitespace residual
 *
 * Si no encuentra JSON parseable, devuelve err con el texto crudo para debugging.
 */
export function extractJsonFromClaudeText(rawText: string): Result<unknown, ClaudeApiError> {
  if (!rawText || rawText.trim().length === 0) {
    return err({
      type: 'parse-error',
      message: 'Texto vacío',
      detail: '',
    });
  }

  // Limpiar markdown fences si existen
  let cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Si no empieza con `{` o `[`, intentar extraer el objeto/array más exterior
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    // Probar primero con `{` (objeto), luego con `[` (array)
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    } else {
      const firstBracket = cleaned.indexOf('[');
      const lastBracket = cleaned.lastIndexOf(']');
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        cleaned = cleaned.slice(firstBracket, lastBracket + 1);
      }
    }
  }

  try {
    return ok(JSON.parse(cleaned));
  } catch (e) {
    return err({
      type: 'parse-error',
      message: `JSON inválido: ${(e as Error).message}`,
      detail: `texto limpiado: "${cleaned.slice(0, 200)}"`,
    });
  }
}

export interface JudgeWithClaudeOptions<TSchema extends z.ZodTypeAny> {
  apiKey: string;
  model: string;
  system?: string;
  /** El user message (texto plano o array text+image) */
  userContent: string | ClaudeMessageContent[];
  /** Schema Zod del JSON esperado. La función valida y devuelve `z.infer<TSchema>` */
  schema: TSchema;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * Combinación de los 3 pasos: callAnthropicMessages → extractJsonFromClaudeText
 * → schema.safeParse. Es lo que casi todos los juezes IA necesitan.
 *
 * Caller usa esto como:
 *   const result = await judgeWithClaude({ apiKey, model, system, userContent, schema });
 *   if (result.isErr()) handle...
 *   const verdict = result.value;  // typed como z.infer<typeof schema>
 */
export async function judgeWithClaude<TSchema extends z.ZodTypeAny>(
  opts: JudgeWithClaudeOptions<TSchema>,
): Promise<Result<z.infer<TSchema>, ClaudeApiError>> {
  const callResult = await callAnthropicMessages({
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: opts.maxTokens,
    system: opts.system,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    messages: [{ role: 'user', content: opts.userContent }],
  });
  if (callResult.isErr()) return err(callResult.error);

  // extractFinalText filtra los bloques 'thinking' si existen.
  const rawText = extractFinalText(callResult.value);
  const extractResult = extractJsonFromClaudeText(rawText);
  if (extractResult.isErr()) return err(extractResult.error);

  const validation = opts.schema.safeParse(extractResult.value);
  if (!validation.success) {
    return err({
      type: 'schema-error',
      message: `Respuesta de Claude no matchea schema`,
      detail: validation.error.message.slice(0, 500),
    });
  }
  return ok(validation.data as z.infer<TSchema>);
}

/**
 * Helper: arma content array para un user-message con imagen base64 + texto.
 * Útil cuando hay que mostrarle una imagen a Claude para que la evalúe.
 */
export function buildImageMessageContent(
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
