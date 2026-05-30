// claude-chat-discuss.ts — M8: Chat IA reusable para inputs del usuario.
//
// Función única `discussWithClaude({ contextType, contextData, conversation })`
// que actúa como asistente conversacional en cualquier sección de la herramienta
// donde el usuario escribe (sugerencias, cambios de escena, notas de rip, etc).
//
// La idea: el usuario tiene un input/sugerencia, lo discute con Claude antes
// de confirmarlo, Claude entiende el contexto del sistema (preset, run, scene)
// y da feedback útil.
//
// Endpoint correspondiente: /api/chat/discuss

import { z } from 'zod';
import { getSystemContextForPrompt } from './system-context';
import { logSystemEvent } from './system-log';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Tipos de contexto donde puede invocarse el chat
export const ChatContextTypeSchema = z.enum([
  'sugerencia',          // /sugerencias — discutir una idea de mejora
  'scene-edit',          // /runs/[id]/editor — discutir un cambio de escena
  'script-refine',       // /create — refinar el script antes de generar
  'rip-analysis',        // /rip/[id] — discutir el análisis del ad de referencia
  'preset-tuning',       // /admin — discutir ajustes de un preset
  'general',             // chat general sobre el proyecto
]);
export type ChatContextType = z.infer<typeof ChatContextTypeSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatDiscussRequestSchema = z.object({
  contextType: ChatContextTypeSchema,
  // Data estructurada del contexto (preset, run, scene, etc.) que Claude debe saber
  contextData: z.record(z.unknown()).optional(),
  // Historial de la conversación. El último mensaje debe ser del usuario.
  conversation: z.array(ChatMessageSchema).min(1).max(40),
  model: z.string().optional(),
});
export type ChatDiscussRequest = z.infer<typeof ChatDiscussRequestSchema>;

export const ChatDiscussResponseSchema = z.object({
  reply: z.string(),
  elapsedSec: z.number(),
  modelUsed: z.string(),
  tokensUsed: z.object({
    input: z.number(),
    output: z.number(),
  }),
});
export type ChatDiscussResponse = z.infer<typeof ChatDiscussResponseSchema>;

// ============================================================
// System prompts por tipo de contexto
// ============================================================

function systemPromptFor(contextType: ChatContextType, contextData?: Record<string, unknown>): string {
  const baseProject = `Sos un asistente integrado en Video Factory — herramienta interna para generar ads verticales 9:16 (TikTok/Reels) para marcas D2C (Vitaly, Nelo). El sistema tiene 3 modos: Crear (script→video), Ripear (video referencia→video adaptado), Aprender (video→preset destilado). Stack: TypeScript + Next.js + Remotion + Drizzle + pipeline de bloques con cascada multi-provider de imágenes.`;

  const baseStyle = `Hablás en español neutro (formas con "tú", sin argentinismos). Sos directo, concreto, sin diplomacia innecesaria. Si pediste info que falta, pedila explícita. Si una propuesta del usuario tiene un problema obvio, decílo. Si está bien, decí "está bien" y por qué. NO inventes — si no sabés algo del sistema, decí "no tengo info de eso".`;

  const ctxStr = contextData ? `\n\nCONTEXTO DEL SISTEMA (data estructurada que conoces):\n${JSON.stringify(contextData, null, 2)}` : '';

  switch (contextType) {
    case 'sugerencia':
      return `${baseProject}\n\nROL: ayudás al owner a refinar una sugerencia de mejora antes de que la registre formalmente. Discutí pros/contras, sugerí variantes, mencioná si algo similar ya existe en el sistema, da estimación rough de esfuerzo.\n\n${baseStyle}${ctxStr}`;
    case 'scene-edit':
      return `${baseProject}\n\nROL: ayudás al owner a editar una escena específica del video. Conocés el prompt original, el preset, el contexto narrativo. Sugerí cambios concretos al prompt, alertá sobre limitaciones del modelo de imagen.\n\n${baseStyle}${ctxStr}`;
    case 'script-refine':
      return `${baseProject}\n\nROL: ayudás al owner a refinar el script de un ad antes de generarlo. Mirá hook (primeros 3s), estructura AIDA/PAS, claims del producto (verificá compliance), CTA. Sugerí ajustes concretos. Si el script viola algún claim médico (Vitaly = suplemento), alertá.\n\n${baseStyle}${ctxStr}`;
    case 'rip-analysis':
      return `${baseProject}\n\nROL: ayudás al owner a interpretar el análisis multimodal de un ad de referencia que el sistema ripeó. Conocés el análisis (estilo, hook, paleta, personaje). Respondé preguntas sobre cómo adaptarlo a otro producto/brand, qué preset elegir, qué ajustar.\n\n${baseStyle}${ctxStr}`;
    case 'preset-tuning':
      return `${baseProject}\n\nROL: ayudás al owner a ajustar un preset (promptTemplate, negativePrompt, scenesPerMinute, etc.) basado en feedback de runs anteriores. Sugerí ajustes específicos y por qué.\n\n${baseStyle}${ctxStr}`;
    case 'general':
    default:
      return `${baseProject}\n\nROL: asistente general del proyecto. Respondé preguntas sobre cómo usar la herramienta, qué preset elegir, cómo iterar.\n\n${baseStyle}${ctxStr}`;
  }
}

// ============================================================
// API principal
// ============================================================

export async function discussWithClaude(
  request: ChatDiscussRequest,
): Promise<ChatDiscussResponse> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }
  const model = request.model ?? 'claude-haiku-4-5';

  // M9: prepend system context completo del proyecto al system prompt del rol.
  // Claude ahora SIEMPRE sabe brands, presets, providers, decisiones recientes y
  // eventos del sistema — sin que el caller tenga que hardcodear nada.
  const roleSystemPrompt = systemPromptFor(request.contextType, request.contextData);
  let projectContext = '';
  try {
    projectContext = await getSystemContextForPrompt();
  } catch {
    // Si falla el context fetch, no bloquear el chat — usar solo el rol prompt.
  }
  const systemPrompt = projectContext
    ? `${projectContext}\n\n---\n\n# Tu rol actual\n\n${roleSystemPrompt}`
    : roleSystemPrompt;

  // Validar que el último mensaje sea del usuario
  const last = request.conversation[request.conversation.length - 1];
  if (last?.role !== 'user') {
    throw new Error('El último mensaje de la conversación debe ser del usuario');
  }

  const t0 = Date.now();
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      temperature: 0.4, // un poco más conversacional que validation strict
      messages: request.conversation,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as {
    content?: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const reply = json.content?.[0]?.text ?? '';
  if (!reply) {
    throw new Error('Claude respondió sin contenido text');
  }
  const elapsedSec = (Date.now() - t0) / 1000;

  // M9: log automático del evento
  void logSystemEvent({
    kind: 'chat-discuss-message',
    data: {
      contextType: request.contextType,
      userMessageLength: last.content.length,
      replyLength: reply.length,
      model,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      tokensIn: json.usage?.input_tokens ?? 0,
      tokensOut: json.usage?.output_tokens ?? 0,
    },
    summary: `Chat ${request.contextType}: "${last.content.slice(0, 80)}..." → reply ${reply.length}ch`,
  });

  return {
    reply,
    elapsedSec,
    modelUsed: model,
    tokensUsed: {
      input: json.usage?.input_tokens ?? 0,
      output: json.usage?.output_tokens ?? 0,
    },
  };
}
