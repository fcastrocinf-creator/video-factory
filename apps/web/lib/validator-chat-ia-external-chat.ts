// ╔══════════════════════════════════════════════════════════════════════════╗
// ║         VALIDATOR CHAT IA — EXTERNAL CHAT (owner ↔ entidad)              ║
// ║  Endpoint conversacional para que el OWNER hable con VALIDATOR sobre    ║
// ║  un run específico. Multi-turn: cada mensaje agrega al historial.        ║
// ║                                                                          ║
// ║  Capacidades:                                                            ║
// ║    - Owner pregunta: "por qué falló scene 7?" → VALIDATOR responde con  ║
// ║      su rationale del veredicto + evidencia.                            ║
// ║    - Owner instruye: "ignora burned-text en scene 3, es intencional" → ║
// ║      VALIDATOR persiste el override y lo respeta en futuras validaciones║
// ║    - Owner ordena: "re-validá scene 12 con foco en anatomía" →         ║
// ║      VALIDATOR retorna acción ejecutable que la UI puede disparar.      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  callAnthropicMessages,
  extractFinalText,
  extractJsonFromClaudeText,
  type ClaudeMessage,
  type ClaudeMessageContent,
} from './unified-judge';
import {
  VALIDATOR_NAME,
  VALIDATOR_STORAGE_ABS,
  appendOwnerOverride,
  readAntiPatterns,
  readOwnerOverrides,
  readValidatorHistory,
} from './validator-chat-ia';
import { readHolisticVerdict } from './validator-chat-ia-holistic';

const CHAT_MODEL = 'claude-sonnet-4-5';
const CHAT_TIMEOUT_MS = 60_000;
const MAX_HISTORY_MESSAGES = 20; // ventana de contexto razonable

// ─── Schema de la respuesta ─────────────────────────────────────────────────

const ChatResponseSchema = z.object({
  /** Mensaje conversacional de VALIDATOR al owner. */
  message: z.string().min(1).max(3000),
  /** Acciones que VALIDATOR detectó del mensaje del owner. */
  actions: z
    .array(
      z.object({
        type: z
          .union([
            z.enum([
              'add-override', // owner pide ignorar un issue
              'request-revalidation', // owner pide re-validar una scene
              'request-regeneration', // owner pide regenerar una scene con instrucciones
              'request-holistic-rerun', // owner pide rerun del holistic
              'none', // solo conversación
            ]),
            z.string(),
          ])
          .transform((v) => {
            const allowed = [
              'add-override',
              'request-revalidation',
              'request-regeneration',
              'request-holistic-rerun',
              'none',
            ];
            return (allowed.includes(v as string) ? v : 'none') as
              | 'add-override'
              | 'request-revalidation'
              | 'request-regeneration'
              | 'request-holistic-rerun'
              | 'none';
          }),
        scope: z
          .union([z.enum(['global', 'scene']), z.string()])
          .transform((v): 'global' | 'scene' =>
            v === 'global' || v === 'scene' ? v : 'global',
          )
          .nullish(),
        sceneIndex: z.number().int().nonnegative().nullish().transform((v) => v ?? undefined),
        instruction: z.string().min(1).max(1000).nullish().transform((v) => v ?? undefined),
      }),
    )
    .default([]),
  /** Refs a entries de history que VALIDATOR cita en su respuesta. */
  citedHistoryRefs: z
    .array(z.object({ sceneIndex: z.number().int().nonnegative(), attempt: z.number().int().positive() }))
    .default([]),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ─── System prompt — VALIDATOR como entidad conversacional ──────────────────

const EXTERNAL_CHAT_SYSTEM_PROMPT = `Sos "${VALIDATOR_NAME}" — el validador con memoria total del run. El owner del proyecto está conversando con vos sobre un run específico.

Tu personalidad:
  - Directo, breve, técnicamente preciso.
  - Hablás español neutro (formas con "tú", sin argentinismos).
  - Cuando citás evidencia, sos específico: "en scene 7 attempt 2, detecté
    burned-text-hex-codes severity critical en frame 1 region top-right".
  - Si el owner pregunta algo que no podés saber (ej. "¿el cliente lo va a
    aprobar?"), decílo claramente: "no tengo forma de saberlo, mi alcance es
    técnico-visual".

Capacidades que tenés:
  - Recordás TODO el historial de veredictos por scene (jsonl persistido).
  - Recordás los anti-patrones acumulados del run.
  - Recordás los overrides del owner que ya están activos.
  - Si tenés holistic-verdict del run, lo conocés.

Cuando el owner te dice algo, identificá si está pidiendo una ACCIÓN:

  1. "Ignora X en scene Y" / "no me importa X" → action 'add-override',
     scope='scene' o 'global', instruction = lo que hay que ignorar.

  2. "Re-validá scene N" / "volvé a chequear N" → action 'request-revalidation',
     sceneIndex=N.

  3. "Regenerá scene N con instrucciones Z" → action 'request-regeneration',
     sceneIndex=N, instruction=Z.

  4. "Volvé a correr el review global" / "re-evaluá el video entero" →
     action 'request-holistic-rerun'.

  5. Solo conversación / pregunta → action 'none'.

Cuando NO hay acción clara, action = 'none' y solo respondés con texto.

DEVOLVÉ SOLO JSON SIN MARKDOWN FENCES:

{
  "message": "<tu respuesta conversacional al owner>",
  "actions": [
    { "type": "add-override", "scope": "scene", "sceneIndex": 3, "instruction": "ignorar burned-text intencional" }
  ],
  "citedHistoryRefs": [
    { "sceneIndex": 7, "attempt": 2 }
  ]
}

Si tu respuesta cita un veredicto específico de la historia, incluí el ref en
citedHistoryRefs para que la UI pueda linkearlo.

REGLA DE LONGITUD:
  - Respuestas corto y directo (1-4 oraciones) si es pregunta simple.
  - Hasta 8-10 oraciones si es análisis profundo.
  - NUNCA respuestas de 1 línea genéricas — el owner odia el waffle.`;

// ─── Persistencia del chat externo ──────────────────────────────────────────

export interface ExternalChatTurn {
  runId: string;
  turnNumber: number;
  timestampIso: string;
  role: 'owner' | 'validator';
  message: string;
  /** Para el turno del validator, las acciones detectadas. */
  actions?: ChatResponse['actions'];
  citedHistoryRefs?: ChatResponse['citedHistoryRefs'];
  /** Si el turno disparó un override, el id del override creado. */
  appliedOverrideTimestamp?: string;
}

let externalChatWriteLock: Promise<void> = Promise.resolve();

async function appendExternalChatTurn(turn: ExternalChatTurn): Promise<void> {
  const prev = externalChatWriteLock;
  let releaseLock: () => void = () => undefined;
  externalChatWriteLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  try {
    await prev;
    const dir = resolve(VALIDATOR_STORAGE_ABS, turn.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'external-chat.jsonl');
    await appendFile(path, JSON.stringify(turn) + '\n', 'utf-8');
    // También un markdown lindo para que el owner lo lea
    await persistExternalChatMarkdown(turn.runId);
  } finally {
    releaseLock();
  }
}

export async function readExternalChatTurns(runId: string): Promise<ExternalChatTurn[]> {
  const path = resolve(VALIDATOR_STORAGE_ABS, runId, 'external-chat.jsonl');
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ExternalChatTurn);
  } catch {
    return [];
  }
}

async function persistExternalChatMarkdown(runId: string): Promise<void> {
  const turns = await readExternalChatTurns(runId);
  if (turns.length === 0) return;
  const md: string[] = [];
  md.push(`# ${VALIDATOR_NAME} — Chat con owner`);
  md.push('');
  md.push(`_Run:_ \`${runId}\``);
  md.push(`_Última actualización:_ ${new Date().toISOString()}`);
  md.push(`_Turnos:_ ${turns.length}`);
  md.push('');
  md.push('---');
  md.push('');
  for (const t of turns) {
    if (t.role === 'owner') {
      md.push(`## 🧑 Owner (turno ${t.turnNumber}) · ${t.timestampIso}`);
      md.push('');
      md.push(t.message);
      md.push('');
    } else {
      md.push(`## 🤖 ${VALIDATOR_NAME} (turno ${t.turnNumber}) · ${t.timestampIso}`);
      md.push('');
      md.push(t.message);
      md.push('');
      if (t.actions && t.actions.length > 0) {
        md.push('**Acciones detectadas:**');
        for (const a of t.actions) {
          md.push(
            `  - \`${a.type}\`${a.scope ? ` scope=${a.scope}` : ''}${a.sceneIndex !== undefined ? ` scene=${a.sceneIndex}` : ''}${a.instruction ? `: ${a.instruction}` : ''}`,
          );
        }
        md.push('');
      }
      if (t.citedHistoryRefs && t.citedHistoryRefs.length > 0) {
        md.push(
          `_Citó:_ ${t.citedHistoryRefs.map((r) => `scene #${r.sceneIndex} attempt ${r.attempt}`).join(', ')}`,
        );
        md.push('');
      }
    }
    md.push('---');
    md.push('');
  }
  const path = resolve(VALIDATOR_STORAGE_ABS, runId, 'external-chat.md');
  await writeFile(path, md.join('\n'), 'utf-8');
}

// ─── Construcción del contexto que VALIDATOR ve por turno ───────────────────

async function buildContextForOwnerTurn(
  runId: string,
  ownerMessage: string,
  sceneIndex?: number,
): Promise<string> {
  const [history, antiPatterns, globalOverrides, sceneOverrides, holisticVerdict] =
    await Promise.all([
      readValidatorHistory(runId),
      readAntiPatterns(runId),
      readOwnerOverrides(runId),
      sceneIndex !== undefined ? readOwnerOverrides(runId, sceneIndex) : Promise.resolve([]),
      readHolisticVerdict(runId),
    ]);

  const lines: string[] = [];
  lines.push(`## Estado actual del run ${runId}`);
  lines.push('');
  lines.push(`**Veredictos por scene:**`);
  const grouped = new Map<number, typeof history>();
  for (const h of history) {
    if (!grouped.has(h.sceneIndex)) grouped.set(h.sceneIndex, []);
    grouped.get(h.sceneIndex)!.push(h);
  }
  const sortedIdx = Array.from(grouped.keys()).sort((a, b) => a - b);
  for (const idx of sortedIdx) {
    const entries = grouped.get(idx)!;
    const last = entries[entries.length - 1]!;
    const v = last.verdict;
    lines.push(
      `  - Scene #${idx}: ${entries.length} attempts. Último verdict: ${v ? `${v.verdict} (conf=${v.confidence}, nextAction=${v.nextAction})` : `error API`}`,
    );
    if (v && v.issues.length) {
      const summary = v.issues
        .slice(0, 3)
        .map((i) => `${i.severity}/${i.category}`)
        .join(', ');
      lines.push(`    Issues: ${summary}`);
    }
  }
  lines.push('');

  if (antiPatterns.length > 0) {
    lines.push(`**Anti-patrones acumulados (${antiPatterns.length}):**`);
    for (const ap of antiPatterns.slice(-8)) {
      lines.push(`  - [scene #${ap.sceneIndex}] ${ap.pattern}`);
    }
    lines.push('');
  }

  if (globalOverrides.length > 0 || sceneOverrides.length > 0) {
    lines.push(`**Overrides activos del owner:**`);
    for (const o of globalOverrides) lines.push(`  - [global] ${o}`);
    for (const o of sceneOverrides) lines.push(`  - [scene #${sceneIndex}] ${o}`);
    lines.push('');
  }

  if (holisticVerdict) {
    lines.push(`**Holistic verdict:** ${holisticVerdict.globalVerdict}`);
    lines.push(
      `  - scores: pacing=${holisticVerdict.scorePacing}, characterConsistency=${holisticVerdict.scoreCharacterConsistency}, palette=${holisticVerdict.scorePaletteCoherence}, narrative=${holisticVerdict.scoreNarrativeFlow}, hook=${holisticVerdict.scoreHookStrength}, cta=${holisticVerdict.scoreCtaStrength}`,
    );
    if (holisticVerdict.recommendedRegenerateIndices.length) {
      lines.push(
        `  - recomendaste regenerar: ${holisticVerdict.recommendedRegenerateIndices.join(', ')}`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`## Mensaje del owner ${sceneIndex !== undefined ? `(foco en scene #${sceneIndex})` : ''}`);
  lines.push('');
  lines.push(ownerMessage);
  lines.push('');
  lines.push('---');
  lines.push(`Devolvé SOLO el JSON con tu respuesta. No uses markdown fences.`);

  return lines.join('\n');
}

// ─── API pública ────────────────────────────────────────────────────────────

export interface ExternalChatOptions {
  runId: string;
  ownerMessage: string;
  /** Si el owner está hablando de una scene específica. */
  sceneIndex?: number;
  model?: string;
  apiKey?: string;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface ExternalChatResult {
  response: ChatResponse | null;
  error?: { type: string; message: string };
  appliedActions: Array<{
    type: string;
    sceneIndex?: number;
    appliedAt: string;
  }>;
  durationMs: number;
}

/**
 * Procesa un mensaje del owner en el chat externo de VALIDATOR.
 *
 * Flujo:
 *   1. Persiste el turn del owner en external-chat.jsonl
 *   2. Carga el historial reciente del chat para multi-turn context
 *   3. Construye contexto: history del validator + anti-patterns + overrides + holistic
 *   4. Llama Sonnet con system prompt de "VALIDATOR conversando con owner"
 *   5. Si la respuesta tiene actions del tipo 'add-override', las persiste
 *   6. Persiste el turn del validator y el markdown legible
 */
export async function processExternalChat(
  opts: ExternalChatOptions,
): Promise<ExternalChatResult> {
  const t0 = Date.now();
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = opts.model ?? CHAT_MODEL;
  const logger = opts.logger;
  const appliedActions: ExternalChatResult['appliedActions'] = [];

  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    return {
      response: null,
      error: { type: 'no-api-key', message: 'ANTHROPIC_API_KEY no configurada' },
      appliedActions,
      durationMs: Date.now() - t0,
    };
  }

  // 1. Leer historial. v3.3 fix: NO persistimos el turno del owner todavía — si la
  // llamada a la API falla, quedaría un turno 'owner' huérfano que rompe la
  // alternancia user/assistant en la siguiente llamada (mismo class de bug que
  // tumbó sesiones). Se persiste recién tras una respuesta exitosa (paso 5b).
  const priorTurns = await readExternalChatTurns(opts.runId);
  const ownerTurnNum = priorTurns.length + 1;

  // 2. Construir conversación multi-turn (últimos N turnos para no inflar tokens)
  const recentTurns = priorTurns.slice(-MAX_HISTORY_MESSAGES);
  const conversationMessages: ClaudeMessage[] = [];
  for (const t of recentTurns) {
    if (t.role === 'owner') {
      conversationMessages.push({ role: 'user', content: t.message });
    } else {
      conversationMessages.push({ role: 'assistant', content: t.message });
    }
  }
  // v3.3 fix: la API exige que el PRIMER mensaje sea 'user'. El slice del historial
  // puede arrancar con un 'assistant' → descartamos los assistant iniciales.
  while (conversationMessages.length > 0 && conversationMessages[0]?.role === 'assistant') {
    conversationMessages.shift();
  }

  // 3. Mensaje del owner CURRENT con contexto completo del run
  const contextualUserMessage = await buildContextForOwnerTurn(
    opts.runId,
    opts.ownerMessage,
    opts.sceneIndex,
  );
  const userContent: ClaudeMessageContent[] = [{ type: 'text', text: contextualUserMessage }];
  conversationMessages.push({ role: 'user', content: userContent });

  // 4. Llamar a Sonnet via callAnthropicMessages para soportar multi-turn real
  const callResult = await callAnthropicMessages({
    apiKey,
    model,
    maxTokens: 2000,
    temperature: 0.3,
    timeoutMs: CHAT_TIMEOUT_MS,
    system: EXTERNAL_CHAT_SYSTEM_PROMPT,
    messages: conversationMessages,
  });

  if (callResult.isErr()) {
    logger?.warn(
      { runId: opts.runId, err: callResult.error.message, entity: VALIDATOR_NAME },
      'validator-chat-ia-external-chat:api_error',
    );
    return {
      response: null,
      error: { type: callResult.error.type, message: callResult.error.message },
      appliedActions,
      durationMs: Date.now() - t0,
    };
  }

  const rawText = extractFinalText(callResult.value);
  const extractResult = extractJsonFromClaudeText(rawText);
  if (extractResult.isErr()) {
    logger?.warn(
      { runId: opts.runId, err: extractResult.error.message, entity: VALIDATOR_NAME },
      'validator-chat-ia-external-chat:parse_error',
    );
    return {
      response: null,
      error: { type: extractResult.error.type, message: extractResult.error.message },
      appliedActions,
      durationMs: Date.now() - t0,
    };
  }
  const parseResult = ChatResponseSchema.safeParse(extractResult.value);
  if (!parseResult.success) {
    logger?.warn(
      {
        runId: opts.runId,
        err: parseResult.error.message.slice(0, 300),
        entity: VALIDATOR_NAME,
      },
      'validator-chat-ia-external-chat:schema_error',
    );
    return {
      response: null,
      error: {
        type: 'schema-error',
        message: parseResult.error.message.slice(0, 500),
      },
      appliedActions,
      durationMs: Date.now() - t0,
    };
  }
  const chatResponse = parseResult.data;

  // 5b. v3.3 fix: ahora SÍ persistimos el turno del owner (la llamada tuvo éxito),
  // así nunca queda un turno huérfano que rompa la alternancia user/assistant.
  await appendExternalChatTurn({
    runId: opts.runId,
    turnNumber: ownerTurnNum,
    timestampIso: new Date().toISOString(),
    role: 'owner',
    message: opts.ownerMessage,
  });

  // 5. Procesar acciones (persistir overrides)
  for (const action of chatResponse.actions) {
    if (action.type === 'add-override' && action.instruction) {
      const scope = action.scope ?? (action.sceneIndex !== undefined ? 'scene' : 'global');
      const overrideRecord = {
        runId: opts.runId,
        timestampIso: new Date().toISOString(),
        scope: scope as 'global' | 'scene',
        sceneIndex: action.sceneIndex,
        instruction: action.instruction,
      };
      await appendOwnerOverride(overrideRecord).catch((e) =>
        logger?.warn(
          { runId: opts.runId, err: (e as Error).message },
          'validator-chat-ia-external-chat:override_persist_failed',
        ),
      );
      appliedActions.push({
        type: 'add-override',
        sceneIndex: action.sceneIndex,
        appliedAt: overrideRecord.timestampIso,
      });
    } else if (
      action.type === 'request-revalidation' ||
      action.type === 'request-regeneration' ||
      action.type === 'request-holistic-rerun'
    ) {
      // Esto lo dispara la UI llamando al endpoint correspondiente; solo lo
      // anotamos.
      appliedActions.push({
        type: action.type,
        sceneIndex: action.sceneIndex,
        appliedAt: new Date().toISOString(),
      });
    }
  }

  // 6. Persistir turno del validator
  await appendExternalChatTurn({
    runId: opts.runId,
    turnNumber: ownerTurnNum + 1,
    timestampIso: new Date().toISOString(),
    role: 'validator',
    message: chatResponse.message,
    actions: chatResponse.actions,
    citedHistoryRefs: chatResponse.citedHistoryRefs,
  });

  const durationMs = Date.now() - t0;
  logger?.info(
    {
      runId: opts.runId,
      ownerTurnNum,
      actionsCount: chatResponse.actions.length,
      appliedCount: appliedActions.length,
      citedRefsCount: chatResponse.citedHistoryRefs.length,
      durationMs,
      entity: VALIDATOR_NAME,
    },
    'validator-chat-ia-external-chat:response',
  );

  return { response: chatResponse, appliedActions, durationMs };
}
