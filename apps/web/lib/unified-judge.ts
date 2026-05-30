// unified-judge.ts — M7 Pieza C v1 (capa apps/web)
//
// Wrapper de alto nivel sobre `judgeWithClaude` de @video-factory/core que
// auto-inyecta el system-context del proyecto (M9). Cualquier nuevo flujo en
// apps/web/lib que necesite un juez Claude debe usar ESTO en vez de hacer
// fetch+parse+validate a mano.
//
// Diferencia con `judgeWithClaude` raw:
//   - Auto-prepend de `getSystemContextForPrompt()` al system del rol
//   - Default model `claude-haiku-4-5` (barato y rápido)
//   - Lee `ANTHROPIC_API_KEY` de `process.env` si no se pasa
//
// Para casos donde NO se quiere el contexto inflado (ej. clasificaciones
// triviales), exponemos `judgeRaw` que reexporta el primitivo de core.

import type { z } from 'zod';
import {
  judgeWithClaude as judgeRaw,
  type ClaudeApiError,
  type ClaudeMessageContent,
} from '@video-factory/core';
import { getSystemContextForPrompt } from './system-context';

export type { ClaudeApiError, ClaudeMessage, ClaudeMessageContent, ClaudeContentBlock, ClaudeResponse } from '@video-factory/core';
export {
  buildImageMessageContent,
  extractJsonFromClaudeText,
  callAnthropicMessages,
  extractFinalText,
  extractThinking,
} from '@video-factory/core';
// Reexport para callers que NO quieren la inyección de contexto
export { judgeRaw };

export interface UnifiedJudgeOptions<TSchema extends z.ZodTypeAny> {
  /** Prompt de rol (sin el contexto de proyecto — se inyecta auto). */
  roleSystemPrompt: string;
  /** Mensaje del usuario (texto o array con imágenes). */
  userContent: string | ClaudeMessageContent[];
  /** Schema Zod del JSON esperado. */
  schema: TSchema;
  /** Default 'claude-haiku-4-5'. Escalá a sonnet-4-5/4-6 para casos críticos. */
  model?: string;
  /** Default 1500. Subí si el output es largo (rare en judges). */
  maxTokens?: number;
  /** Default 0 (determinístico). 0.2-0.3 para juicios cualitativos. */
  temperature?: number;
  /** Default 30000 ms. */
  timeoutMs?: number;
  /** Override apiKey. Default `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /**
   * Si true, NO inyecta el system-context del proyecto. Default false.
   * Solo activar para tareas donde el contexto añade ruido (ej. clasificaciones
   * binarias triviales o cuando latencia importa muchísimo).
   */
  skipProjectContext?: boolean;
}

/**
 * Llama a Claude para emitir un veredicto JSON estructurado. Auto-inyecta el
 * snapshot del proyecto (brands, presets, providers, decisiones recientes)
 * al system prompt para que Claude SIEMPRE razone con el contexto actual.
 */
export async function unifiedJudge<TSchema extends z.ZodTypeAny>(
  opts: UnifiedJudgeOptions<TSchema>,
) {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const projectContext = opts.skipProjectContext
    ? null
    : await getSystemContextForPrompt().catch(() => null);

  const fullSystem = projectContext
    ? `${projectContext}\n\n---\n\n# Tu rol actual\n\n${opts.roleSystemPrompt}`
    : opts.roleSystemPrompt;

  return judgeRaw({
    apiKey,
    model: opts.model ?? 'claude-haiku-4-5',
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    system: fullSystem,
    userContent: opts.userContent,
    schema: opts.schema,
  });
}
