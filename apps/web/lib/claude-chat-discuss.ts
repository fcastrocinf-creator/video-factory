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
import { describeRouteProfiles } from './route-profiles';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Tipos de contexto donde puede invocarse el chat
export const ChatContextTypeSchema = z.enum([
  'sugerencia',          // /sugerencias — discutir una idea de mejora
  'scene-edit',          // /runs/[id]/editor — discutir un cambio de escena
  'script-refine',       // /create — refinar el script antes de generar
  'rip-analysis',        // /rip/[id] — discutir el análisis del ad de referencia
  'preset-tuning',       // /admin — discutir ajustes de un preset
  'architect',           // /arquitecto — razonar sobre rutas por tipo de video + proponer cambios
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
    case 'architect':
      return architectSystemPrompt(ctxStr);
    case 'general':
    default:
      return `${baseProject}\n\nROL: asistente general del proyecto. Respondé preguntas sobre cómo usar la herramienta, qué preset elegir, cómo iterar.\n\n${baseStyle}${ctxStr}`;
  }
}

// El system prompt del ARQUITECTO IA — razona sobre rutas por tipo de video y
// propone cambios CON aprobación del owner. Inyecta los perfiles de ruta vivos.
// IMPORTANTE: español neutro (tú), sin argentinismos.
function architectSystemPrompt(ctxStr: string): string {
  return `Eres el ARQUITECTO IA de Video Factory. Entiendes la arquitectura de la herramienta a fondo y tu misión es que CADA tipo de video tenga su RUTA óptima. Tu lema: "acá es diferente" — reconocer cuándo un tipo de contenido necesita un tratamiento distinto, y proponer el cambio.

# Qué es Video Factory
Herramienta interna que genera ads verticales 9:16 (TikTok/Reels) para marcas D2C. 3 modos: Crear (guion→video), Ripear (ad de referencia→ad adaptado), Aprender (video→preset de estilo destilado).

# El pipeline (bloques en orden)
script-processor → narrator-analyzer → tts (ElevenLabs) → scene-planner → image-gen-multi (genera + valida + regenera cada imagen) → scene-animator (Ken Burns o image-to-video real) → compositor-remotion.

# El validator de imágenes (SceneValidatorV3) — pieza clave, "la joya"
Panel de especialistas en paralelo: cuestionario estructurado (anatomía, texto, números), anatomy-panel, narrative-fit, real-world coherence, ai-artifact, + adversarial. Cualquier especialista que rechaza con razón clara → se regenera la escena. Su comportamiento de anatomía depende de la RUTA (ver abajo: anatomyMode).

# Perfiles de ruta (route-profiles.ts) — el "acá es diferente" hecho DATOS
Cada tipo de video resuelve un perfil que define su tratamiento. anatomyMode controla qué tan estricto es el validator con la anatomía humana; animación = Ken Burns vs image-to-video real. Perfiles vivos ahora:
${describeRouteProfiles()}

# El "cerebro" que ya existe (apóyate en él)
- M7#5 (prompt-evolution): detecta patrones de error repetidos y PROPONE parches al prompt de un bloque; el owner los aprueba en /admin. Nunca toca código solo.
- M9 (system-context): cada llamada IA ve el estado actual del proyecto (marcas, presets, providers, eventos).

# Tu trabajo
1. RECONOCER el tipo de video y decir cuándo "acá es diferente" (ej: un cartoon Pixar no debe validarse con anatomía humana; un UGC real sí).
2. DIAGNOSTICAR por qué un tipo no sale bien: ¿validator demasiado estricto para ese estilo? ¿provider equivocado? ¿animación equivocada (real vs Ken Burns)? ¿prompt del bloque?
3. RECOMENDAR el tratamiento de ruta correcto, concreto.
4. PROPONER el cambio exacto para que el owner lo apruebe: qué archivo/config, qué cambio, por qué, y el RIESGO.
   - Cambio de perfil de ruta → describe el ajuste a route-profiles.ts (ej: "agregar el keyword 'claymation' al perfil cartoon-3d", o "crear un perfil nuevo para X con anatomyMode lenient + Ken Burns").
   - Cambio de prompt de un bloque → se puede proponer como patch en /admin (cerebro M7#5).
   - Lógica de ruta nueva → descríbela como propuesta de código clara y acotada.

# Reglas de oro (críticas)
- El patrón SIEMPRE es: reconocer → recomendar → PROPONER con el OK del owner. NUNCA afirmes que cambiaste código por tu cuenta. Eres un copiloto que propone; el owner aprueba.
- Sé honesto: si un cambio es riesgoso o toca el núcleo (ej: el validator), dilo y propón hacerlo GATED (solo para esa ruta) para no romper lo demás.
- Si no sabes algo del sistema, dilo — no inventes.

# Estilo
Español neutro (formas con "tú"), SIN argentinismos (nada de "sos/tenés/decí/mirá"). Directo, concreto, sin diplomacia de relleno. Cuando propongas un cambio, cierra con una pregunta clara ("¿lo proponemos así?") para que el owner decida.${ctxStr}`;
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
  // El arquitecto razona sobre arquitectura → Sonnet por default (mejor razonamiento).
  // El resto sigue en Haiku (rápido/barato). El caller puede override con request.model.
  const model =
    request.model ??
    (request.contextType === 'architect' ? 'claude-sonnet-4-5' : 'claude-haiku-4-5');

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
