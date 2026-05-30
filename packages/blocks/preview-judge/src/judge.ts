// judge.ts — función principal: judgeImage(input, options) → JudgeReport.
//
// Workflow:
//   1. Arma request a Claude con imagen base64 + prompt + contexto.
//   2. Llama judgeWithClaude (unificado en @video-factory/core).
//   3. Aplica thresholds locales — recalcula `pass` con criterios propios (no
//      dejamos que solo Claude decida; aplicamos nuestros mínimos).
//   4. Retorna JudgeReport listo para que el caller decida regenerar o aceptar.
//
// M7 Pieza C v2 (25-may-2026): el fetch + JSON parse + safeParse antes en
// `claude-client.ts` ahora viene del primitivo unificado. claude-client.ts
// queda como capa de compat para callers externos.

import { ok, err, type Result } from 'neverthrow';
import { judgeWithClaude, buildImageMessageContent } from '@video-factory/core';
import { SYSTEM_PROMPT, buildUserPromptText } from './judge-prompt.js';
import {
  type JudgeInput,
  type JudgeOptions,
  type JudgeReport,
  type JudgeError,
  JudgeReportSchema,
} from './types.js';

const DEFAULT_MODEL = 'claude-haiku-4-5';
// v2 (27-may-2026): subido de 1024 → 2048 porque el prompt nuevo pide más
// output (3 nuevos sub-scores + suggestedSystemicPatch por issue).
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_THRESHOLDS = {
  minScoreVisual: 80,
  minScoreBrandFit: 75,
  minScoreHookStrength: 70,
  // v2: nuevos thresholds. Logical coherence es la más crítica.
  minScoreLogicalCoherence: 80,
  minScoreViveness: 60,
  minScoreContinuity: 70,
  failOnAnyCritical: true,
};

/**
 * Evalúa una imagen contra el prompt que la generó.
 * Retorna Result<JudgeReport, JudgeError>.
 *
 * Si la API key no está configurada, retorna err con type 'no-api-key' —
 * el caller debe decidir si saltar la validación o fallar el pipeline.
 */
export async function judgeImage(
  input: JudgeInput,
  options: JudgeOptions = {},
): Promise<Result<JudgeReport, JudgeError>> {
  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };

  const userText = buildUserPromptText(input);
  const content = buildImageMessageContent(
    input.imageBuffer,
    userText,
    input.imageMimeType ?? 'image/png',
  );

  const result = await judgeWithClaude({
    apiKey,
    model,
    maxTokens,
    system: SYSTEM_PROMPT,
    temperature: 0, // determinístico, queremos consistencia entre llamadas
    timeoutMs: options.timeoutMs ?? 30_000,
    userContent: content,
    schema: JudgeReportSchema,
  });
  if (result.isErr()) {
    const e = result.error;
    return err({
      type:
        e.type === 'no-api-key'
          ? 'no-api-key'
          : e.type === 'timeout'
            ? 'timeout'
            : e.type === 'api-error'
              ? 'api-error'
              : 'parse-error',
      message: e.message,
      detail: e.detail,
    });
  }

  // Recalculamos `pass` con nuestros thresholds locales (no confiamos
  // ciegamente en lo que dice Claude — quizás puso pass=true pero los scores
  // están abajo de lo que aceptamos). v2: incluye los nuevos sub-scores.
  const report = result.value;
  const hasCritical = report.issues.some(
    (i: { severity: string }) => i.severity === 'critical',
  );
  // Los nuevos scores son optional (Claude viejo no los devuelve). Si están
  // ausentes, no contribuyen al fail. Si están y son bajos, sí.
  const logicalOk =
    report.scoreLogicalCoherence === undefined ||
    report.scoreLogicalCoherence >= thresholds.minScoreLogicalCoherence;
  const vivenessOk =
    report.scoreViveness === undefined ||
    report.scoreViveness >= thresholds.minScoreViveness;
  const continuityOk =
    report.scoreContinuity === undefined ||
    report.scoreContinuity >= thresholds.minScoreContinuity;
  const localPass =
    report.scoreVisual >= thresholds.minScoreVisual &&
    report.scoreBrandFit >= thresholds.minScoreBrandFit &&
    report.scoreHookStrength >= thresholds.minScoreHookStrength &&
    logicalOk &&
    vivenessOk &&
    continuityOk &&
    !(thresholds.failOnAnyCritical && hasCritical);

  return ok({ ...report, pass: localPass });
}
