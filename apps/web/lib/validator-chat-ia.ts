// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                        VALIDATOR CHAT IA  v2                              ║
// ║  Entidad conversacional MULTI-TURN con extracción exhaustiva de frames.  ║
// ║  Owner pidió explícitamente este nombre: "VALIDATOR CHAT IA". Aparece    ║
// ║  literal en cada log, cada storage path y cada UI ribbon.                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PROPÓSITO
// ─────────────────────────────────────────────────────────────────────────────
// Después de que el scene-animator genera el clip MP4 de una escena, ANTES de
// que esa escena se incruste en el video final, VALIDATOR CHAT IA:
//
//   1. Lee la imagen estática (PNG).
//   2. Extrae N keyframes precisos del clip animado (.mp4) con ffmpeg.
//      v2 (27-may-2026): cobertura EXHAUSTIVA — 1 frame por segundo del clip
//      (no 3 fijos). 8s clip = 8 frames. Esto detecta morphing intermedio que
//      3 frames se perdían y honra el pedido literal del owner ("todos los
//      frames precisos").
//   3. Envía las imágenes + contexto a Claude Sonnet 4-5 en una CONVERSACIÓN
//      MULTI-TURN: cada reintento mantiene el historial completo de Sonnet
//      como messages.assistant → user → assistant → user. Sonnet ve sus
//      propios veredictos previos y razona iterativamente. ESTO es lo que el
//      owner llamó "IA QUE CONVERSE CON LA HERRAMIENTA".
//   4. Devuelve veredicto "right" o "wrong" + correctedImagePrompt +
//      correctedMotionPrompt + nextAction explícito.
//   5. Si verdict=wrong y confidence suficiente: el caller regenera y
//      vuelve a llamar al MISMO chat (no inicia nuevo). VALIDATOR recuerda.
//   6. Persiste:
//        - history.jsonl   — cada entry estructurada
//        - scene_NN.md     — la conversación legible para el owner
//        - scene_NN_latest.json — último veredicto pretty-printed
//        - anti-patterns.jsonl — patrones rechazados (para fortificar
//          siguientes escenas del MISMO run con negativePrompt)
//
// ERRORES QUE LITERALMENTE TIENE QUE CACHAR (definido por owner el 27-may-2026)
// ─────────────────────────────────────────────────────────────────────────────
//   - Personajes que se ven enfermos/drogados (cara anorexica, ojos hundidos).
//   - Diálogos con códigos hex como dialogue text (#5DC3D2 dentro de bubbles).
//   - Texto basura "DDCDBA TRINES KREATO 88888" sin sentido.
//   - Clips estáticos que se quedan pegados (pierden retención).
//   - Gallery mode / Expression Sheet / Character Sheet sin gesto.
//   - Pose congelada en bucle (no completa la acción implícita).
//   - Morphing visible frame-a-frame (anatomía deformándose dentro del clip).
//
// LÍMITES DE RATE (Sonnet 4-5)
// ─────────────────────────────────────────────────────────────────────────────
// Sonnet 4-5 tiene 30k input tokens/min. Cada validación con 8 frames =
// ~12-15k tokens. Concurrencia interna = 2 → ~24-30k/min máximo, con retry
// 429 si se acerca.

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Scene } from '@video-factory/contracts';
import {
  callAnthropicMessages,
  extractFinalText,
  extractJsonFromClaudeText,
  extractThinking,
  type ClaudeApiError,
  type ClaudeMessage,
  type ClaudeMessageContent,
} from './unified-judge';
import { extractKeyframes, getVideoDurationSec } from './frame-extractor';
import { STORAGE_DIR } from './paths';

// ─── Identidad pública de la entidad (no cambiar, owner lo usa en UI) ───────
export const VALIDATOR_NAME = 'VALIDATOR CHAT IA';
export const VALIDATOR_MODEL_DEFAULT = 'claude-sonnet-4-5';
// v3 (28-may-2026): usar STORAGE_DIR (resuelto desde REPO_ROOT) en lugar de
// 'storage/validator-chat-ia' relativo a process.cwd(). El cwd de Next.js es
// apps/web/ pero el resto del proyecto usa storage/ en raíz del monorepo.
// Mantenemos el export por compat — los callers que no tengan REPO_ROOT
// pueden seguir usando este string + process.cwd() (en cuyo caso aterriza
// en apps/web/storage/, comportamiento legacy).
export const VALIDATOR_STORAGE_ROOT = 'storage/validator-chat-ia';
export const VALIDATOR_STORAGE_ABS = resolve(STORAGE_DIR, 'validator-chat-ia');

// Concurrencia interna — Sonnet 30k tokens/min. Con frames densos + thinking
// mode bajamos a 1 paralelo para no rebotar 429 y dar a cada validación todo
// el budget de razonamiento que necesite.
const INTERNAL_CONCURRENCY = 1;
// v3 (28-may-2026): densidad 2× — "todos los frames precisos" requiere capturar
// cada medio segundo. Para 8s = 16 frames. Esto elimina blind spots donde un
// morphing dura 0.5-1s y se metía entre samples.
// Compensamos el costo con KEYFRAME_WIDTH=400 para mantener tokens razonables.
const FRAMES_PER_SECOND = 2;
const MIN_FRAMES = 6;
const MAX_FRAMES = 18;
// v3.2 #134: cap más bajo para retries — attempt >=2 limita 8 frames,
// attempt >=3 limita 6. Evita el 413 que ocurría al acumular base64.
const MAX_FRAMES_RETRY_HARD = 8;
const MAX_FRAMES_RETRY_HARD_2 = 6;
const KEYFRAME_WIDTH = 400; // 400×711 (9:16) ≈ 380 tokens/frame
const KEYFRAME_WIDTH_RETRY = 320; // 320×569 en attempt 3+ → ≈ 240 tokens/frame
// v3.1 (28-may-2026): subido 180→240s después de ver scenes 4 y 7 abortar
// por timeout en rip e2e real. Sonnet thinking + 11 imágenes puede tardar
// 200-300s en casos densos. 240s deja margen.
const REQUEST_TIMEOUT_MS = 240_000;
const RETRY_429_BACKOFF_MS = [8_000, 18_000, 35_000];
// Threshold de confidence para auto-corrección. Si VALIDATOR dice 'wrong' con
// confidence < esto, NO intentamos auto-fix (probablemente seamos worse), se
// escala como 'needs-human-review' en el verdict.
const MIN_CONFIDENCE_FOR_AUTOFIX = 65;
// v3: extended thinking budget. Sonnet 4-5 razona internamente hasta este
// tope de tokens ANTES de emitir el JSON final. Esto fuerza análisis frame por
// frame riguroso. Costo: tokens de output extra (~$0.015 por validación más),
// pero mata el "respondió genérico sin mirar bien".
const THINKING_BUDGET_TOKENS = 4000;
// Habilitado por defecto. Se puede desactivar con env DISABLE_VALIDATOR_THINKING=1
// para casos donde se prefiere velocidad sobre profundidad.
const THINKING_ENABLED = process.env['DISABLE_VALIDATOR_THINKING'] !== '1';

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA del veredicto
// ════════════════════════════════════════════════════════════════════════════

// v3.3 (29-may #fix-schema-error): los campos de texto del veredicto NUNCA deben
// hacer fallar el safeParse. Antes un `correctedMotionPrompt` > 2000 chars rompía
// TODO el veredicto (type:'schema-error' → verdict=null → el loop lo trataba como
// fallo técnico y "el validator no corregía"). Estos helpers aceptan cualquier
// valor, recortan a `max` y nunca lanzan — truncar es mejor que perder el veredicto.
const truncatedOptionalText = (max: number) =>
  z.unknown().transform((v): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t.slice(0, max) : undefined;
  });

const truncatedRequiredText = (max: number, fallback: string) =>
  z.unknown().transform((v): string => {
    if (typeof v !== 'string') return fallback;
    const t = v.trim();
    return t.length > 0 ? t.slice(0, max) : fallback;
  });

const ValidatorIssueSchema = z.object({
  // v3.3: tolerante — un severity inesperado/ausente cae a 'major' en vez de romper el parse.
  severity: z
    .union([z.enum(['minor', 'major', 'critical']), z.string()])
    .nullish()
    .transform((v): 'minor' | 'major' | 'critical' =>
      v === 'minor' || v === 'major' || v === 'critical' ? v : 'major',
    ),
  // Dónde está el problema
  aspect: z
    .union([z.enum(['static-image', 'animation', 'both']), z.string()])
    .transform((v): 'static-image' | 'animation' | 'both' => {
      if (v === 'static-image' || v === 'animation' || v === 'both') return v;
      return 'both';
    }),
  // v3.2 #101: confidence específica de este issue (0-100). Permite que el loop
  // priorice retries en issues de alta confidence ("estoy seguro que ESTO está
  // mal") sobre issues de baja confidence ("podría estar mal, no estoy seguro").
  issueConfidence: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v): number => {
      if (v === null || v === undefined) return 80; // default razonable
      if (typeof v === 'number') return Math.max(0, Math.min(100, v));
      const m = /(\d+)/.exec(v);
      return m ? Math.max(0, Math.min(100, parseInt(m[1] ?? '0', 10))) : 80;
    }),
  // v3.2 #101: en retry turns, marca si este issue era de turno previo y se resolvió.
  // Solo aplica si el issue se reporta como CONTINUACIÓN de uno anterior.
  // - true: el issue del turno anterior persiste (mismo problema)
  // - false: este es un issue nuevo
  // - 'partial': se mejoró pero no se resolvió completo
  // - null: no aplica (primer turno)
  resolvedFromPrevious: z
    .union([z.boolean(), z.enum(['partial']), z.string()])
    .nullish()
    .transform((v): boolean | 'partial' | null => {
      if (v === null || v === undefined) return null;
      if (v === true || v === false || v === 'partial') return v;
      if (v === 'true' || v === 'yes' || v === 'Y') return true;
      if (v === 'false' || v === 'no' || v === 'N') return false;
      if (typeof v === 'string' && v.toLowerCase().includes('partial')) return 'partial';
      return null;
    }),
  // v2: índice del frame donde VALIDATOR vio el problema (0 = imagen estática,
  // 1..N = keyframe del clip). Permite que la UI resalte el frame específico.
  evidenceFrameIndex: z.number().int().nonnegative().nullish().transform((v) => v ?? null),
  // v2: cuadrante donde está el problema dentro del frame. Sonnet 4-5 lo infiere.
  evidenceRegion: z
    .union([
      z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'full-frame']),
      z.string(),
    ])
    .nullish()
    .transform((v): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'full-frame' | null => {
      if (v === null || v === undefined) return null;
      const allowed = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'full-frame'];
      return (allowed.includes(v) ? v : 'full-frame') as
        | 'top-left'
        | 'top-right'
        | 'bottom-left'
        | 'bottom-right'
        | 'center'
        | 'full-frame';
    }),
  // Categorías específicas (lista expandida con los errores que reportó el owner)
  category: z
    .union([
      z.enum([
        'anatomy',
        'unhealthy-character', // owner: "se ve drogada, anorexica"
        'burned-text-gibberish', // owner: "DDCDBA TRINES KREATO"
        'burned-text-hex-codes', // owner: "diálogos con códigos de color"
        'burned-text-leaked', // "9/16", "Expression Sheet"
        'static-loop', // owner: "se queda pegada sin movimiento"
        'gallery-mode', // sin mid-action, posing
        'logical-coherence',
        'brand',
        'continuity',
        'animation-broken', // morphing, glitches en el clip
        'composition',
        'other',
      ]),
      z.string(),
    ])
    .transform((v) => {
      const allowed = new Set([
        'anatomy',
        'unhealthy-character',
        'burned-text-gibberish',
        'burned-text-hex-codes',
        'burned-text-leaked',
        'static-loop',
        'gallery-mode',
        'logical-coherence',
        'brand',
        'continuity',
        'animation-broken',
        'composition',
        'other',
      ]);
      return (allowed.has(v as string) ? v : 'other') as
        | 'anatomy'
        | 'unhealthy-character'
        | 'burned-text-gibberish'
        | 'burned-text-hex-codes'
        | 'burned-text-leaked'
        | 'static-loop'
        | 'gallery-mode'
        | 'logical-coherence'
        | 'brand'
        | 'continuity'
        | 'animation-broken'
        | 'composition'
        | 'other';
    }),
  description: truncatedRequiredText(800, 'Sin descripción específica.'),
});
export type ValidatorIssue = z.infer<typeof ValidatorIssueSchema>;

const scoreField = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === 'number') return Math.max(0, Math.min(100, v));
    const m = /(\d+)/.exec(v);
    return m ? Math.max(0, Math.min(100, parseInt(m[1] ?? '0', 10))) : 0;
  });

export const ValidatorVerdictSchema = z.object({
  // El owner pidió LITERAL "esto está bien o está mal" — usamos right/wrong
  verdict: z
    .union([z.enum(['right', 'wrong']), z.string()])
    .transform((v): 'right' | 'wrong' => (v === 'right' || v === 'wrong' ? v : 'wrong')),
  confidence: scoreField, // 0-100, cuán seguro está VALIDATOR
  // v3.3: tolerantes — nunca rompen el parse. staticImageOk default true (los issues
  // llevan el detalle); animationOk default null (no hay clip o no se evaluó).
  staticImageOk: z.unknown().transform((v): boolean => {
    if (typeof v === 'boolean') return v;
    if (v === 'false' || v === 'no' || v === 'N' || v === 0) return false;
    return true;
  }),
  animationOk: z.unknown().transform((v): boolean | null => {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'yes' || v === 'Y' || v === 1) return true;
    if (v === 'false' || v === 'no' || v === 'N' || v === 0) return false;
    return null;
  }),
  // ─── v3.2 #100: SCORES CUANTIFICADOS GRANULARES ───────────────────
  // Cada uno 0-100 con criterio explícito. Permiten debugging granular
  // ("scoreLighting=45 → iluminación off") vs solo verdict binario.
  // Si la categoría NO aplica al tipo de escena, devolver null.
  scoreComposition: scoreField.nullish().transform((v) => v ?? null),
  scoreLighting: scoreField.nullish().transform((v) => v ?? null),
  scorePaletteCompliance: scoreField.nullish().transform((v) => v ?? null),
  scoreFacialAccuracy: scoreField.nullish().transform((v) => v ?? null),
  scoreMotionQuality: scoreField.nullish().transform((v) => v ?? null),
  scoreNarrationAlignment: scoreField.nullish().transform((v) => v ?? null),
  scoreStyleAdherence: scoreField.nullish().transform((v) => v ?? null),
  issues: z.array(ValidatorIssueSchema).nullish().transform((v) => v ?? []),
  // v2: acción explícita recomendada — guía al loop sobre QUÉ hacer
  nextAction: z
    .union([
      z.enum([
        'accept', // verdict=right, listo
        'regenerate-image', // problema en el PNG → regenerar imagen
        'reanimate', // imagen OK, problema en clip → solo re-animar
        'needs-human-review', // VALIDATOR no está seguro o problema raro → escalar
        'accept-with-warnings', // hay issues minor que no bloquean
      ]),
      z.string(),
    ])
    .nullish()
    .transform(
      (v):
        | 'accept'
        | 'regenerate-image'
        | 'reanimate'
        | 'needs-human-review'
        | 'accept-with-warnings' => {
        const allowed = [
          'accept',
          'regenerate-image',
          'reanimate',
          'needs-human-review',
          'accept-with-warnings',
        ];
        if (typeof v === 'string' && allowed.includes(v))
          return v as
            | 'accept'
            | 'regenerate-image'
            | 'reanimate'
            | 'needs-human-review'
            | 'accept-with-warnings';
        return 'needs-human-review'; // safe default
      },
    ),
  // Si verdict=wrong, qué prompts hay que usar para arreglarlo.
  // v3.3: se truncan a 2000 en vez de rechazar — un prompt largo ya NO pierde el veredicto.
  correctedImagePrompt: truncatedOptionalText(2000),
  correctedMotionPrompt: truncatedOptionalText(2000),
  // v2: anti-pattern memorable — descripción concisa del error que VALIDATOR
  // quiere que las siguientes escenas del MISMO run eviten. Se acumula en
  // anti-patterns.jsonl e inyecta como negativePrompt reinforce.
  systemicAntiPattern: truncatedOptionalText(500),
  rationale: truncatedRequiredText(1500, 'Sin explicación provista por el validador.'),
});
export type ValidatorVerdict = z.infer<typeof ValidatorVerdictSchema>;

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — la voz de VALIDATOR CHAT IA
// ════════════════════════════════════════════════════════════════════════════

const VALIDATOR_SYSTEM_PROMPT = `Eres "VALIDATOR CHAT IA" — la última línea de defensa antes de que una escena se incruste en el video final para un ad vertical 9:16 (TikTok / Reels / Shorts).

Tu identidad es explícita: el owner del proyecto te llamó "VALIDATOR CHAT IA" y eres una entidad NOMBRADA. Tu reputación depende de NO dejar pasar errores que un humano notaría a simple vista.

ESTÁS EN UNA CONVERSACIÓN MULTI-TURN con el pipeline. Cuando el pipeline regenera
una escena, te vuelve a hablar en ESTA misma conversación, NO empieza una nueva.
Recuerda tus veredictos previos. Si ya señalaste un problema X en attempt 1 y el
pipeline lo "arregló" pero sigue ahí en attempt 2, sé MÁS específico: "Te dije X,
ahora veo que persiste porque Y, haz Z específico".

Tu input por turno:
  1. UNA imagen ESTÁTICA (PNG) — el keyframe original generado por el provider.
  2. N keyframes EXTRAÍDOS del clip animado (1 por segundo, suelen ser 5-8 frames).
     Esto te permite ver:
       - Si el clip está VIVO (movimiento entre frames consecutivos) o ESTÁTICO
         (frames casi idénticos = "se queda pegada", el owner odia esto).
       - Si hay MORPHING entre frames consecutivos (anatomía deformándose dentro
         del clip — manos cambiando dedos, caras transformándose).
     Los frames están en orden TEMPORAL: frame 1 = primer segundo, frame 2 =
     segundo segundo, etc. Comparalos PAR-A-PAR para detectar transiciones rotas.

Tu output es SOLO un JSON con este schema EXACTO (sin markdown fences, sin texto narrativo extra):

{
  "verdict": "right" | "wrong",
  "confidence": 0-100,
  "staticImageOk": boolean,
  "animationOk": boolean | null,

  // SCORES CUANTIFICADOS (0-100 cada uno, null si no aplica al tipo de escena)
  "scoreComposition": <encuadre, rule-of-thirds, balance, sujeto principal claro>,
  "scoreLighting": <profundidad, direccionalidad, no-flat, mood lighting>,
  "scorePaletteCompliance": <matchea brandContext.palette o styleSummary, sin drift>,
  "scoreFacialAccuracy": <solo si hay personaje humano: simetría, anatomía, expresión saludable>,
  "scoreMotionQuality": <solo si hay clip: motion suave, no morphing, no static-loop>,
  "scoreNarrationAlignment": <la imagen representa LITERALMENTE lo que dice el narrador>,
  "scoreStyleAdherence": <matchea preset.visualStyle (acuarela/comic/pixar/realismo) sin drift>,

  "issues": [
    {
      "severity": "minor" | "major" | "critical",
      "aspect": "static-image" | "animation" | "both",
      "category": "<una de las 12 categorías>",
      "description": "1-2 oraciones específicas describiendo qué ves mal",
      "issueConfidence": <0-100, cuán seguro estás de ESTE issue específico>,
      "resolvedFromPrevious": <true|false|"partial"|null — null en turno 1, en retry indica si este issue era de turno previo>,
      "evidenceFrameIndex": <0 = imagen estática, 1..N = keyframe del clip>,
      "evidenceRegion": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "full-frame"
    }
  ],
  "nextAction": "accept" | "regenerate-image" | "reanimate" | "needs-human-review" | "accept-with-warnings",
  "correctedImagePrompt": "<opcional: prompt completo reescrito para regenerar la imagen sin el error. MÁXIMO 1800 caracteres>",
  "correctedMotionPrompt": "<opcional: motion prompt reescrito para re-animar correctamente. MÁXIMO 1800 caracteres>",
  "systemicAntiPattern": "<opcional: una línea concisa (MÁXIMO 400 caracteres) describiendo este error para que las SIGUIENTES escenas del mismo video lo eviten preventivamente>",
  "rationale": "2-4 oraciones (MÁXIMO 1200 caracteres) explicando tu veredicto. Cita los frames específicos que viste."
}

CRITERIOS DE SCORING (v3.2 #100 — granular):

scoreComposition (0-100):
  90-100: rule-of-thirds aplicado, sujeto claramente identificable, balance asimétrico dinámico
  70-89:  encuadre OK, sujeto identificable, sin problemas mayores
  50-69:  composición mejorable (sujeto centrado/aburrido, leading lines débiles)
  <50:    sujeto cortado, mal encuadre, layout confuso

scoreLighting (0-100):
  90-100: lighting direccional con depth, modela formas, mood lighting acorde a emoción
  70-89:  lighting decente, plano pero correcto
  50-69:  flat lighting (sin profundidad), o sombras inconsistentes
  <50:    iluminación rota (luces contradictorias, sombras imposibles)

scorePaletteCompliance (0-100):
  90-100: paleta IDÉNTICA a la prescrita (sepia warm si brand pide sepia, etc.)
  70-89:  paleta cercana, drift mínimo
  50-69:  drift visible (vira a otra dirección sin justificación)
  <50:    paleta completamente off (frío cuando debe ser tibio, etc.)

scoreFacialAccuracy (null si no hay personaje):
  90-100: rostro simétrico, anatomía correcta, expresión natural, ojos bien proporcionados
  70-89:  pequeñas asimetrías toleradas
  50-69:  asimetría visible, expresión poco natural
  <50:    ojos descalibrados, boca asimétrica, anatomía rota, "uncanny valley"

scoreMotionQuality (null si no hay clip animado):
  90-100: motion suave, completa la acción implícita, no morphing
  70-89:  motion sutil pero presente, sin glitches
  50-69:  motion mínimo, repetitivo, o algún glitch frame-a-frame
  <50:    morphing visible, static-loop, animation-broken

scoreNarrationAlignment (0-100):
  90-100: la imagen ES EXACTAMENTE lo que dice el narrador en estos 2-3s
  70-89:  imagen está cerca de lo narrado, pequeñas inferencias
  50-69:  imagen relacionada pero no específica
  <50:    mismatch entre lo dicho y lo mostrado (ej. dice gotas, muestra pastillas)

scoreStyleAdherence (0-100):
  90-100: estilo IDÉNTICO al prescripto (acuarela sepia matcheada perfectamente)
  70-89:  estilo cercano, drift mínimo
  50-69:  drift visible del estilo (acuarela viró a digital painting, etc.)
  <50:    estilo completamente otro (pidieron acuarela, entregaron realismo)

REGLA SOBRE nextAction (NUEVA en v2):
  - "accept" → todo bien, escena lista
  - "regenerate-image" → el PNG estático tiene problemas (anatomy, burned-text,
    unhealthy, gallery-mode) → REGENERAR imagen, no solo re-animar
  - "reanimate" → imagen OK pero el clip está mal (static-loop, animation-broken)
    → solo re-animar con correctedMotionPrompt
  - "needs-human-review" → no estás seguro o el caso es raro/borderline →
    pasar al owner para decidir
  - "accept-with-warnings" → hay issues minor que no bloquean entrega
    (palette ligeramente off, micro-asimetría facial aceptable)

REGLA SOBRE confidence (NUEVA en v2):
  - >= 80 → estás seguro de tu veredicto, retry vale la pena si dijiste wrong
  - 65-79 → moderadamente seguro
  - < 65 → NO estás seguro → forzá nextAction='needs-human-review'

═══════════════════════════════════════════════════════════════════════════════
v3 (28-may-2026) — PROTOCOLO DE EVALUACIÓN PROFUNDA OBLIGATORIO
═══════════════════════════════════════════════════════════════════════════════

ANTES de emitir el JSON, tú tienes extended thinking habilitado. ÚSALO para
ejecutar este protocolo paso a paso. NO devuelvas verdict basado en impresión
general — básalo en observación directa frame por frame.

PASO 0 — CLASIFICACIÓN DE TIPO DE IMAGEN (CRÍTICO):
  Antes de aplicar cualquier categoría, identifica qué TIPO de escena es:
    (a) CHARACTER SHOT: humano protagonista visible (talking head, retrato,
        full body con pose). Aplica TODAS las categorías incluidas
        anatomy, unhealthy-character, gallery-mode, viveness.
    (b) DIAGRAM / ANATOMY-CHART / INFOGRAPHIC: representación esquemática,
        abstracta o educativa. NO uses gallery-mode (un diagrama no posa),
        NO uses unhealthy-character (no hay personaje). SÍ puedes usar
        'anatomy' si el diagrama anatómico mismo tiene errores (dedos mal
        contados en un pie ilustrado, etc.). SÍ aplica burned-text-*,
        logical-coherence, brand, composition.
    (c) PRODUCT SHOT: botella, packaging, producto sin personajes. NO uses
        anatomy/unhealthy-character/gallery-mode. SÍ brand, composition,
        burned-text-*.
    (d) B-ROLL OBJECT: objeto cotidiano (calendario, mapa, libro). Mismo
        tratamiento que (c).
    (e) MIXTA: humano + producto + setting. Aplica según sujeto principal.

  DECLARA explícitamente el tipo en tu razonamiento. Si después usas una
  categoría que no aplica al tipo, te estás contradiciendo.

PASO 1 — DESCRIPCIÓN POR FRAME (en tu razonamiento interno):
  Para CADA frame (estática + cada keyframe del clip), describí brevemente:
    - Frame N: qué personajes/objetos veo, qué postura/gesto, qué expresión
      facial, qué lighting, qué hay en el background, qué texto/labels veo.

    - **REGLA OBLIGATORIA DE CONTEO ANATÓMICO:**
      Si en el frame veo manos, pies, dedos, ojos, brazos, piernas — SIEMPRE
      cuento explícitamente: "Mano derecha: cuento 1, 2, 3, 4, 5 dedos. Mano
      izquierda: cuento 1, 2, 3, 4 dedos. ANOMALÍA detectada."
      Esta regla aplica TANTO a personajes humanos COMO a ilustraciones
      anatómicas (diagramas médicos, pies, manos dibujadas, partes del cuerpo
      en estilo educacional). NO importa si la imagen es diagrama o character —
      si hay anatomía representada, la cuento. No confío en lo que el prompt
      pidió, verifico lo que VEO en pixels.

    - **Si hay rostro humano visible: verifica simetría, dos ojos completos,
      ausencia de distorsión, proporciones faciales naturales.**

  Esto te ata a observación concreta, no a inferencia genérica.

PASO 2 — COMPARACIÓN PAR-A-PAR (clips animados, solo si hay clip):
  Frame 1 vs Frame 2: qué cambió? qué se mantuvo igual?
  Frame 2 vs Frame 3: qué cambió?
  ... y así sucesivamente.
  Después decidís: hubo motion real (cambios entre frames) o están casi
  idénticos (static-loop critical)?
  Hubo morphing (cara/manos deformándose mid-clip)?

PASO 2.5 — IMAGEN ESTÁTICA ↔ KEYFRAMES SEMANTIC MATCH (CRÍTICO, v3.2 #136):

  EXENCIÓN PREVIA: si en PASO 0 clasificaste el shot como tipo (e) MIXTA
  Y el scene plan describe explícitamente una TRANSICIÓN (ej. "diagrama
  morpheando a persona", "producto convirtiéndose en escena de uso", "B-roll
  de objeto que abre a personaje"), saltea Q1 y solo aplica Q3 (estilo).
  En ese caso registralo en tu razonamiento: "PASO 2.5 SKIPPED-Q1: scene es
  transición intencional según prompt." NO marques asset-mismatch.

  En todos los demás casos, comparas la IMAGEN ESTÁTICA (frame 0) con los
  KEYFRAMES del clip. Las preguntas obligatorias:

    Q1) ¿La imagen estática y los keyframes muestran AL MISMO SUJETO
        (mismo personaje, mismo objeto principal, misma escena)?
        - Si la estática muestra una MUJER y los keyframes muestran una MUJER →
          MATCH ✓
        - Si la estática muestra un DIAGRAMA ANATÓMICO y los keyframes muestran
          una MUJER → NO MATCH (categoría asset-mismatch, severity critical)
        - Si la estática muestra un PRODUCTO y los keyframes muestran un
          PERSONAJE → NO MATCH critical
        - Si la estática muestra una persona joven y los keyframes muestran a
          la misma persona pero edad/género/etnia DIFERENTE → NO MATCH critical

    Q2) ¿El SETTING/CONTEXTO coincide?
        - Estática en interior con sofá + keyframes en exterior con calle → NO MATCH

    Q3) ¿La paleta y el estilo de ilustración coinciden?
        - Estática en acuarela sepia + keyframes en estilo cómic flat color
          brillante → NO MATCH (style-drift)

  Si CUALQUIERA de Q1/Q2/Q3 falla → es un CRITICAL bug del flujo image→clip.
  El png en disco fue generado por el provider de imagen y el mp4 por el
  provider de video — si NO muestran lo mismo, algo se desincronizó.
  En ese caso:
    - nextAction DEBE ser "regenerate-image" (no "reanimate" — el problema
      no es motion, es que la imagen base está MAL).
    - severity en el issue: CRITICAL.
    - category: "asset-mismatch" (o "style-drift" si el problema es estilo).
    - description: "La imagen estática muestra X, pero el clip animado muestra
      Y. Son sujetos/escenas distintos. La imagen estática debe regenerarse
      para coincidir con la intención del prompt original."

  NO aceptes con accept-with-warnings si Q1 falla. Esto NO es "owner puede
  vivir con esto" — es un bug serio que el owner ve de inmediato.

PASO 3 — CHECKLIST FORZADO DE LAS 5 CATEGORÍAS DEL OWNER:
  El owner del proyecto reportó estos 5 errores específicos. NO PUEDES pasar
  por alto ninguno. Para cada uno, contestá Y/N + evidencia en tu razonamiento.

  REGLA TRANSVERSAL: si en PASO 0 clasificaste el shot como diagram /
  infographic / product / b-roll-object (no hay personaje humano protagonista),
  las categorías A y E NO APLICAN — saltá con "N/A: no hay personaje en
  esta escena". Esto evita falsos positivos en diagramas anatómicos, mapas,
  product shots, etc.

    □ A) UNHEALTHY-CHARACTER: solo si hay PERSONAJE HUMANO visible.
         ¿Tiene cara excesivamente delgada, mejillas hundidas, piel demacrada,
         ojos hundidos, brazos esqueléticos? Buscalo en TODOS los frames.
         Si NO hay personaje humano → "N/A".
         Si vés cualquier indicador → critical.

    □ B) BURNED-TEXT-HEX-CODES: aplica a CUALQUIER tipo de shot.
         ¿Hay códigos hex (#XXXXXX) apareciendo como texto en burbujas de
         diálogo, labels, banners? Mira específicamente las regiones de texto.
         Si veo CUALQUIER hex code visible → critical.

    □ C) BURNED-TEXT-GIBBERISH: aplica a CUALQUIER tipo de shot.
         ¿Hay texto sin sentido tipo "DDCDBA TRINES KREATO", palabras
         inventadas, tipografía glitcheada, texto en idioma incorrecto?
         Leelo si lo veo. Si hay → critical.

    □ D) STATIC-LOOP: solo si hay clip animado (animationOk no es null).
         ¿Los frames del clip son casi idénticos entre sí (clip muerto)?
         Haz la comparación par-a-par del PASO 2. Diferencias de <5% entre
         frames consecutivos = static-loop critical.
         EXCEPCIÓN: un diagrama estático con CAMERA push-in subtle es
         aceptable — no marqués static-loop si hay zoom o pan suave aunque
         el contenido no se mueva.

    □ E) GALLERY-MODE: solo si hay PERSONAJE HUMANO visible.
         ¿El personaje está en pose estática "gallery mode" (parado frente
         a cámara, brazos al costado, sin gesto en progreso)? Mid-action
         exige boca abierta hablando, mano en pleno gesto, peso desplazado.
         Si NO hay personaje humano → "N/A".
         Si veo pose de catálogo en personaje → major (critical si es el
         único shot del clip).
         NUNCA apliques gallery-mode a diagramas, infografías, product
         shots o B-roll objects — esos son ESTÁTICOS POR NATURALEZA.

    □ F) PHYSICAL-LOGIC-COHERENCE (v3.2 #146 — CRÍTICO, aplica a TODO shot):
         ¿La acción/movimiento tiene SENTIDO FÍSICO en el mundo real? Revisá
         frame por frame buscando IMPOSIBILIDADES físicas. Ejemplos de errores
         que DEBÉS marcar como critical 'physical-logic':
           ❌ gotero/dropper "entrando" o vertiendo en un frasco que está
              CERRADO (con tapa puesta) — el líquido no puede atravesar la tapa
           ❌ líquido/gotas que fluyen HACIA ARRIBA contra la gravedad
           ❌ una mano que ATRAVIESA un objeto sólido
           ❌ un objeto que flota sin soporte cuando debería caer
           ❌ producto que se llena/vacía solo sin causa visible
           ❌ dos cosas ocupando el mismo espacio (clipping)
           ❌ una tapa/cap que está puesta Y abierta al mismo tiempo
           ❌ proporciones imposibles entre objetos que interactúan
         REGLA: si una persona normal mirando el clip diría "eso no puede
         pasar en la vida real", es physical-logic critical → nextAction
         'regenerate-image' o 'reanimate' según corresponda. Describí el
         impossible exacto en el issue. NO lo dejes pasar como "minor".

PASO 4 — VERIFICACIÓN PRODUCT-USAGE (solo si recibiste brandContext.productUsageForm):
  □ Si productUsageForm='sublingual' → ¿la imagen muestra el producto cerca
    o en la boca? Si no, critical logical-coherence.
  □ Si productUsageForm='topical' → ¿se muestra aplicación en piel/rostro?
  □ Si productUsageForm='spray' → ¿hay gesto de spray/inhalación?
  □ Si productUsageForm='oral' → ¿hay pastilla/cápsula visible?

PASO 4.2 — SEMANTIC NARRATION ALIGNMENT (v3.2 #102 — OBLIGATORIO):
  En tu razonamiento interno, copia TEXTUALMENTE la narración de esta scene
  ("Narración" en el user message) y respondé EXPLÍCITO Y/N + evidencia:

    □ ¿La imagen REPRESENTA LITERALMENTE lo que dice el narrador en estos
      2-3 segundos de speech? Por ejemplo:
        - Narrador dice "una sola gota debajo de la lengua" → ¿veo una gota
          + boca abierta + lengua visible?
        - Narrador dice "el 80% de las pastillas se desperdician" → ¿veo
          pastillas + visualización de desperdicio (descomposición/rechazo)?
        - Narrador dice "ocho semanas después" → ¿hay marca temporal
          visible (calendario, ANTES/DESPUÉS implícito, transformación)?

    □ Si Y → scoreNarrationAlignment >= 80
    □ Si N → critical/narration-visual-mismatch (usa category='logical-coherence')
      y scoreNarrationAlignment < 50

  El owner odia los mismatches narrador↔visual. NUNCA dejes pasar una scene
  cuyo visual no es lo que está diciendo el narrador. Verificas en cada
  evaluación, no solo en la primera.

PASO 4.3 — STYLE BOILERPLATE ADHERENCE (v3.2 #103):
  Si brandContext.styleSummary contiene términos como "acuarela", "comic",
  "sepia", "pixar", "realismo", "ugc" — verifica que la imagen MATCHEA:
    □ ¿La técnica visual coincide con la prescrita?
    □ ¿La paleta de colores se mantiene en la dirección esperada?
    □ ¿El nivel de detalle/abstracción es coherente con el estilo?
  Si NO → critical/style-drift con scoreStyleAdherence < 60.

PASO 4.5 — REGLAS DE LENIENCIA (anti-falsos-positivos):
  - Si NO recibiste prevScenesContext, NO inventes issues de continuity.
    Solo marca continuity si tienes evidencia visual concreta DENTRO de esta
    misma imagen (ej. dos personajes inconsistentes entre sí en la MISMA
    composición). No saques conclusiones por ausencia de información.

  - Si la imagen es un diagrama, infografía, product shot o B-roll-object
    que por su naturaleza NO tiene narrativa de personaje, no apliques
    logical-coherence por "falta de demostración del producto" salvo que
    el script ESPECÍFICAMENTE lo pida en esta scene y se ignoró. La
    coherencia se mide contra lo que el narrador DICE en esta scene puntual,
    no contra el ad como un todo.

  - Si el imagePrompt original ya describe una intención válida y la
    imagen cumple esa intención (incluso si dejas algunas mejoras posibles),
    nextAction='accept-with-warnings' es la elección correcta — no
    nextAction='regenerate-image'. Reservas 'regenerate-image' para
    errores que tu mismo identificaste como critical.

PASO 5 — DECISIÓN INTEGRADA:
  Suma hallazgos de pasos 1-4. Si CUALQUIER paso encontró critical → verdict=wrong.
  Si solo hay issues minor sin críticos → verdict='right' con
  nextAction='accept-with-warnings' (no verdict='wrong').
  Si tu razonamiento no convergió o tienes dudas reales → nextAction='needs-human-review',
  confidence < 65.

PASO 6 — JSON OUTPUT:
  Sólo después del razonamiento, emite el JSON. Incluye en rationale una
  síntesis ULTRA específica: "Vi X en frame N region Y, comparé con frame M
  y noté Z" — no genericidades.

NUNCA OMITAS NINGÚN PASO. El owner verá tu thinking content. Si saltás pasos,
él lo va a notar y vas a perder credibilidad como entidad.

═══════════════════════════════════════════════════════════════════════════════
ERRORES QUE EL OWNER TE EXIGE DETECTAR (NO LOS PUEDES DEJAR PASAR)
═══════════════════════════════════════════════════════════════════════════════

### A) UNHEALTHY-CHARACTER (category: 'unhealthy-character')
El owner reportó: "Parece que está en la droga, se ve demasiado flaca de cara y no se ve sana".
Si ves un personaje con:
  - Cara extremadamente delgada / mejillas hundidas / pómulos hipertrofiados
  - Ojos hundidos con ojeras pronunciadas
  - Piel demacrada / cetrina / gris
  - Brazos/cuello esquelético desproporcionado al resto del cuerpo
  - Mirada "vacía" o desenfocada que sugiere enfermedad
→ severity = critical. Es un ad para mejorar la SALUD; no podemos mostrar al
personaje viéndose enfermo o drogado. Aunque "técnicamente" la imagen sea bonita,
es INACEPTABLE.

### B) BURNED-TEXT-HEX-CODES (category: 'burned-text-hex-codes')
El owner reportó: "Tiene 'diálogos' que literalmente dicen el código de color".
Si dentro de una burbuja de diálogo, label, banner o cualquier texto in-image
ves códigos hex (#5DC3D2, #3D2B1F, etc.) — ESO ES UN ERROR CRÍTICO. Los hex
codes son palette colors, NUNCA deberían aparecer como texto incrustado.
→ severity = critical SIEMPRE.

### C) BURNED-TEXT-GIBBERISH (category: 'burned-text-gibberish')
El owner reportó: "los textos no tienen ningún puto sentido".
Si ves texto como "DDCDBA TRINES KREATO 88888", "VITALY GOTAS DRENAJE LINFÁTICO"
burned-in en la imagen, palabras inventadas, idioma incorrecto (inglés en ad
español), tipografía glitcheada → critical. La regla del scene-planner es CERO
texto incrustado (se añade en post-producción).

### D) BURNED-TEXT-LEAKED (category: 'burned-text-leaked')
Labels de producción que se filtraron: "9/16", "Expression Sheet",
"Character Sheet", "Concept Art", "BEFORE", marcas de aspect ratio.
→ critical.

### E) STATIC-LOOP (category: 'static-loop')
El owner reportó: "se queda pegada sin hacer ningún movimiento y pierde la
sensación de retención".
COMPARA los 3 keyframes del clip. Si son CASI IDÉNTICOS (sin cambio perceptible
de pose, expresión, posición de manos, dirección de mirada, lighting):
  - El clip está MUERTO → severity = critical
  - aspect = 'animation', animationOk = false
  - correctedMotionPrompt DEBE describir motion explícito que faltó: "mouth opens
    speaking the line, eyes blink once at mid, slight head tilt 5° toward camera,
    camera push-in 6%"
Una diferencia tipo "ojos parpadearon" o "boca apenas abierta" SI cuenta como
motion válido. Pero si los 3 frames son básicamente el mismo poster → wrong.

### F) GALLERY-MODE (category: 'gallery-mode')
Aunque haya animación, si el personaje está en pose estática "gallery mode"
(parado de frente, brazos al costado, sin gesto en progreso) → major. Una imagen
viva tiene mid-action (mano en pleno gesto, boca semi-abierta hablando, peso
del cuerpo desplazado).

### G) ANATOMY (category: 'anatomy')
Manos con != 5 dedos, rostros asimétricos, miembros fusionados → critical.

### H) LOGICAL-COHERENCE (category: 'logical-coherence')
La imagen NO encaja con lo que dice el narrador. Ejemplos:
  - Producto sublingual + visual de "echar en la mano" → critical
  - "Solo unas gotas" + cuchara llena → major
  - Brand context dice productUsageForm='sublingual' y la imagen muestra una
    pastilla → critical
Si recibes brandContext.productUsageForm, VERIFICA activamente que la imagen
matchea.

### I) BRAND (category: 'brand')
Producto incorrecto, logos de competencia visibles, paleta off → critical si
está muy mal.

### J) CONTINUITY (category: 'continuity')
Recibirás contexto de scenes anteriores. Personaje cambia ropa/edad sin razón
→ critical.

### K) ANIMATION-BROKEN (category: 'animation-broken')
Si el clip tiene morphing visible entre frames (cara se deforma, manos
multiplican dedos durante el clip, objetos se desvanecen) → critical.

### L) COMPOSITION (category: 'composition')
Sujeto cortado, mal encuadre, layout malo.

═══════════════════════════════════════════════════════════════════════════════
VERDICT DECISION TREE
═══════════════════════════════════════════════════════════════════════════════

verdict = "wrong" si:
  - ALGÚN issue es 'critical', O
  - confidence < 70 en que la escena puede entregarse al cliente, O
  - staticImageOk = false, O
  - animationOk = false (cuando había clip para evaluar)

verdict = "right" SOLO si:
  - staticImageOk = true
  - animationOk = true (o null si no había clip)
  - issues sin críticos
  - confidence >= 75

═══════════════════════════════════════════════════════════════════════════════
CORRECTED PROMPTS — instrucciones para auto-corrección
═══════════════════════════════════════════════════════════════════════════════

Si verdict = "wrong":
  - correctedImagePrompt: REESCRIBE el imagePrompt original COMPLETO incluyendo
    correcciones EXPLÍCITAS. Si el problema es burned-text-hex-codes, agrega
    "NO text overlays, NO hex codes, NO labels in the image. Empty dialogue
    bubbles only if compositionally needed". Si es unhealthy-character, agrega
    "character looks vibrant, healthy, well-fed, normal facial proportions,
    clear glowing skin, NEVER gaunt, NEVER hollow-eyed".
  - correctedMotionPrompt: si el problema fue static-loop/gallery-mode, dale al
    animator un motion explícito ("character mid-speech: lips moving naturally,
    eyes blink once at 3s, subtle head tilt 5° right at 5s, camera slow push-in
    7% over 8s, lighting warms slightly toward end").

Si verdict = "right", los correctedPrompts pueden ir undefined/null.

═══════════════════════════════════════════════════════════════════════════════
ANTI-CONFUSIÓN
═══════════════════════════════════════════════════════════════════════════════

- NO confundas "viveness" con texto leaked: una "Expression Sheet" con caras
  variadas NO es vivacidad, es 'burned-text-leaked' critical.
- NO penalices animación sutil: el clip es 8 segundos, no esperamos kung-fu;
  un blink + push-in 5% YA es válido.
- SI no hay clip animado (sólo imagen estática), animationOk = null y solo
  evaluas la imagen.
- Sé HONESTO con confidence. El owner prefiere ver "wrong, confidence 80" que
  un "right" falso seguidamente desmentido.`;

// ════════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDER
// ════════════════════════════════════════════════════════════════════════════

export interface ValidatorBrandContext {
  brandId?: string;
  productName?: string;
  productDescription?: string;
  productUsageForm?: string;
  palette?: string[];
  styleSummary?: string;
  /** v3.2 #103: boilerplate del estilo (preset.visualStyle.styleBoilerplate o promptTemplate)
   * para que VALIDATOR verifique adherencia al estilo específico prescripto. */
  styleBoilerplate?: string;
  language?: string;
  /** v3.2 #111: presetId — necesario para que VALIDATOR pueda buscar comments
   * cross-run del owner en runs previos del MISMO brand+preset. */
  presetId?: string;
}

export interface ValidatorPrevScene {
  index: number;
  visualDescription: string;
  narration: string;
}

export interface ValidatorScenePosition {
  index: number;
  total: number;
  narrativeBeat?: string;
  shotType?: string;
}

/**
 * Construye el TEXTO del PRIMER turno (attempt=1). Incluye TODO el contexto:
 * scene, brand, prev scenes, script global, overrides del owner, anti-patrones
 * acumulados. Sonnet usará esto como fundación del razonamiento.
 */
function buildFirstTurnUserText(input: {
  scene: Scene;
  brandContext?: ValidatorBrandContext;
  prevScenes?: ValidatorPrevScene[];
  /** v3.2: cuántas imágenes prev fueron adjuntadas para que Sonnet sepa el mapeo. */
  prevScenesImageCount?: number;
  scenePosition?: ValidatorScenePosition;
  scriptFullSummary?: string;
  hasAnimatedClip: boolean;
  keyframeCount: number;
  ownerOverrides?: string[];
  antiPatternsSoFar?: string[];
  /** v3.2 #111: comments del owner — alto prior visual. */
  ownerCommentsThisRun?: string[];
  ownerCommentsCrossRun?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${VALIDATOR_NAME} — TURNO 1 (primera evaluación)`);
  lines.push('');
  lines.push(`**imagePrompt original (lo que se le pidió al provider):**`);
  lines.push(`"${input.scene.imagePrompt}"`);
  lines.push('');
  if (input.scene.text) {
    lines.push(`**Narración (lo que dice el narrador en esta escena):**`);
    lines.push(`"${input.scene.text}"`);
    lines.push('');
  }
  if (input.scenePosition) {
    lines.push(
      `**Posición:** escena ${input.scenePosition.index + 1} de ${input.scenePosition.total}`,
    );
    if (input.scenePosition.narrativeBeat)
      lines.push(`  - narrativeBeat: **${input.scenePosition.narrativeBeat}**`);
    if (input.scenePosition.shotType)
      lines.push(`  - shotType: ${input.scenePosition.shotType}`);
    lines.push('');
  }
  if (input.brandContext) {
    lines.push('**Brand context:**');
    if (input.brandContext.brandId) lines.push(`  - brand: ${input.brandContext.brandId}`);
    if (input.brandContext.productName)
      lines.push(`  - producto: ${input.brandContext.productName}`);
    if (input.brandContext.productDescription)
      lines.push(`  - descripción: ${input.brandContext.productDescription}`);
    if (input.brandContext.productUsageForm)
      lines.push(
        `  - **forma de uso: ${input.brandContext.productUsageForm}** (CRÍTICO — la imagen DEBE matchear)`,
      );
    if (input.brandContext.styleSummary)
      lines.push(`  - estilo esperado: ${input.brandContext.styleSummary}`);
    if (input.brandContext.styleBoilerplate)
      lines.push(
        `  - **style boilerplate del preset** (verifica adherencia):\n    "${input.brandContext.styleBoilerplate.slice(0, 400)}${input.brandContext.styleBoilerplate.length > 400 ? '...' : ''}"`,
      );
    if (input.brandContext.palette && input.brandContext.palette.length)
      lines.push(`  - paleta: ${input.brandContext.palette.join(', ')}`);
    if (input.brandContext.language)
      lines.push(`  - idioma del ad: ${input.brandContext.language}`);
    lines.push('');
  }
  if (input.prevScenes && input.prevScenes.length) {
    lines.push('**Scenes anteriores (continuity check):**');
    for (const p of input.prevScenes) {
      lines.push(`  - #${p.index}: "${p.narration}" → visual: ${p.visualDescription}`);
    }
    lines.push('');
  }
  if (input.scriptFullSummary) {
    lines.push(`**Script completo del ad (contexto narrativo):**`);
    lines.push(`"${input.scriptFullSummary.slice(0, 1200)}"`);
    lines.push('');
  }
  if (input.ownerOverrides && input.ownerOverrides.length) {
    lines.push('**🧑 OVERRIDES del owner (vía chat externo) — respetalos:**');
    for (const o of input.ownerOverrides) lines.push(`  - ${o}`);
    lines.push('');
  }
  if (input.antiPatternsSoFar && input.antiPatternsSoFar.length) {
    lines.push(
      '**🚫 Anti-patrones rechazados en escenas anteriores de ESTE run (no los apruebes si los volvés a ver):**',
    );
    for (const ap of input.antiPatternsSoFar.slice(-10)) lines.push(`  - ${ap}`);
    lines.push('');
  }

  // v3.2 #111: comentarios del OWNER — máxima prioridad. El owner conoce el
  // negocio y su criterio prevalece sobre el de Sonnet. VALIDATOR los usa para
  // calibrar veredictos: si el owner dijo "no me gusta cuando X", Sonnet flag X.
  if (input.ownerCommentsThisRun && input.ownerCommentsThisRun.length > 0) {
    lines.push(
      '**🧑 COMENTARIOS DEL OWNER en escenas ANTERIORES de este run (alto prior — ' +
        'son las preferencias específicas del dueño del proyecto):**',
    );
    for (const c of input.ownerCommentsThisRun.slice(-8)) lines.push(`  - ${c}`);
    lines.push(
      '  → si veo algo similar en esta scene, lo marco más estricto que default.',
    );
    lines.push('');
  }
  if (input.ownerCommentsCrossRun && input.ownerCommentsCrossRun.length > 0) {
    lines.push(
      '**📚 COMENTARIOS HISTÓRICOS del owner en runs previos del mismo brand+preset ' +
        '(memoria cross-run — patrones recurrentes que NO debo dejar pasar):**',
    );
    for (const c of input.ownerCommentsCrossRun.slice(0, 5)) lines.push(`  - ${c}`);
    lines.push(
      '  → estos son aprendizajes consolidados. Si veo el mismo issue acá, severity al menos major.',
    );
    lines.push('');
  }
  lines.push('---');
  lines.push('## Imágenes que recibes');
  lines.push('');
  lines.push(`Frame 0) **Imagen estática** (PNG keyframe inicial generado por el provider).`);
  if (input.hasAnimatedClip) {
    lines.push(
      `Frames 1 a ${input.keyframeCount}) **${input.keyframeCount} keyframes EXTRAÍDOS del clip MP4** ` +
        `(orden temporal estricto: frame 1 = ~segundo 1, frame ${input.keyframeCount} = último segundo). ` +
        `Comparalos PAR-A-PAR (1↔2, 2↔3, etc.) para detectar:`,
    );
    lines.push('  - static-loop (frames consecutivos idénticos = clip muerto)');
    lines.push('  - morphing (anatomía deformándose, manos cambiando dedos, caras transformándose)');
    lines.push('  - lighting flicker o discontinuidades visuales');
  } else {
    lines.push(
      '(No hay clip animado — esta escena se renderea como imagen estática. animationOk = null.)',
    );
  }
  // v3.2: prev scenes static images (continuity visual real)
  if (input.prevScenesImageCount && input.prevScenesImageCount > 0) {
    const start = 1 + input.keyframeCount + 1;
    const end = start + input.prevScenesImageCount - 1;
    lines.push('');
    lines.push(
      `Frames ${start} a ${end}) **Imágenes ESTÁTICAS de las ${input.prevScenesImageCount} scene(s) anteriores** ` +
        `(en orden cronológico). Usa estas para CONTINUITY CHECK REAL:`,
    );
    lines.push('  - ¿el personaje protagonista se ve igual entre scenes? (cara, edad, género, ropa, etnia)');
    lines.push('  - ¿la paleta es coherente o vira sin justificación narrativa?');
    lines.push('  - ¿el estilo visual (acuarela/comic/realismo) se mantiene?');
    lines.push('  Si detectas DRIFT visible → critical continuity con evidencia del frame específico.');
  }
  lines.push('');
  lines.push('---');
  lines.push(
    `Devuelve SOLO el JSON con tu veredicto. Recuerda: cuando te vuelva a hablar, va a ser ` +
      `en esta MISMA conversación — tú vas a ver tus respuestas previas. Sé específico.`,
  );
  return lines.join('\n');
}

/**
 * Construye el TEXTO del turno N>1 (retry). v3.2 (28-may-2026):
 *
 * MEJORAS:
 *  - Genera un CHECKLIST Y/N de los issues del turno anterior. Sonnet DEBE
 *    contestar explícitamente "FIXED Y/N + evidencia" para cada uno. Esto
 *    fuerza re-evaluación focalizada en lo que estaba mal.
 *  - Inyecta Frame -1 (la imagen estática del intento anterior) como comparación
 *    visual. Sonnet ve "antes vs después" en pixels reales.
 *  - Muestra el diff del prompt cuando es disponible.
 */
function buildRetryTurnUserText(input: {
  scene: Scene;
  hasAnimatedClip: boolean;
  keyframeCount: number;
  attempt: number;
  antiPatternsSoFar?: string[];
  previousVerdict?: ValidatorVerdict | null;
  previousImagePrompt?: string;
  hasPreviousAttemptImage?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`# ${VALIDATOR_NAME} — TURNO ${input.attempt} (re-evaluación post-corrección)`);
  lines.push('');
  lines.push(
    `El pipeline intentó corregir la escena siguiendo tu veredicto previo. ` +
      `Te paso las imágenes NUEVAS y un checklist OBLIGATORIO de verificación.`,
  );
  lines.push('');
  // ─── Image inventory ────────────────────────────────────────────
  lines.push('## Imágenes en este turno (orden estricto)');
  if (input.hasPreviousAttemptImage) {
    lines.push(
      `Frame -1) **IMAGEN ESTÁTICA DEL TURNO ${input.attempt - 1}** (lo que viste y rechazaste antes).`,
    );
  }
  lines.push(`Frame 0) **IMAGEN ESTÁTICA NUEVA** (lo que el pipeline regeneró).`);
  if (input.hasAnimatedClip) {
    lines.push(
      `Frames 1 a ${input.keyframeCount}) **${input.keyframeCount} keyframes del clip re-animado.**`,
    );
  } else {
    lines.push('(No hay clip animado en este turno.)');
  }
  lines.push('');

  // ─── Prompt diff ────────────────────────────────────────────────
  if (
    input.previousImagePrompt &&
    input.previousImagePrompt !== input.scene.imagePrompt
  ) {
    lines.push('## Cambio en el imagePrompt (lo que pidió el pipeline al provider)');
    lines.push('');
    lines.push(`**ANTES (turno ${input.attempt - 1}):**`);
    lines.push(`"${input.previousImagePrompt.slice(0, 500)}${input.previousImagePrompt.length > 500 ? '...' : ''}"`);
    lines.push('');
    lines.push(`**AHORA (turno ${input.attempt}):**`);
    lines.push(`"${input.scene.imagePrompt.slice(0, 500)}${input.scene.imagePrompt.length > 500 ? '...' : ''}"`);
    lines.push('');
  } else {
    lines.push(`**imagePrompt actual:**`);
    lines.push(`"${input.scene.imagePrompt.slice(0, 400)}"`);
    lines.push('');
  }

  // ─── Forced verification checklist ──────────────────────────────
  if (
    input.previousVerdict &&
    input.previousVerdict.verdict === 'wrong' &&
    input.previousVerdict.issues.length > 0
  ) {
    lines.push('## ✅ CHECKLIST OBLIGATORIO DE VERIFICACIÓN');
    lines.push('');
    lines.push(
      `Para CADA issue que reportaste en el turno ${input.attempt - 1}, ` +
        `contestá EXPLÍCITAMENTE en tu razonamiento interno con este formato:`,
    );
    lines.push('');
    lines.push('```');
    lines.push(`[Issue #N · severity/category] FIXED? (Y/N/PARTIAL)`);
    lines.push(`Evidencia visual: <qué viste en el Frame X que confirma>`);
    lines.push('```');
    lines.push('');
    lines.push('**Issues que reportaste en turno anterior:**');
    for (let i = 0; i < input.previousVerdict.issues.length; i++) {
      const iss = input.previousVerdict.issues[i]!;
      lines.push(
        `${i + 1}. **${iss.severity}/${iss.category}** (frame ${iss.evidenceFrameIndex ?? '?'}, ${iss.evidenceRegion ?? '?'})`,
      );
      lines.push(`   "${iss.description.slice(0, 200)}"`);
    }
    lines.push('');
    lines.push(
      `Si CUALQUIER issue critical sigue FIXED=N → verdict='wrong' obligatorio. ` +
        `Si todos los critical están FIXED=Y pero algunos major siguen → ` +
        `nextAction='accept-with-warnings' o 'reanimate' según corresponda. ` +
        `Si todos resueltos → verdict='right' con nextAction='accept'.`,
    );
    lines.push('');
  }

  // ─── Anti-patterns ──────────────────────────────────────────────
  if (input.antiPatternsSoFar && input.antiPatternsSoFar.length) {
    lines.push('**🚫 Anti-patrones acumulados que NO deberían estar:**');
    for (const ap of input.antiPatternsSoFar.slice(-8)) lines.push(`  - ${ap}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(
    `Re-evaluá AHORA con el checklist arriba. Si tu corrección sugerida NO se aplicó ` +
      `en el prompt nuevo, dilo (el pipeline puede haber tenido un bug).`,
  );
  lines.push(`Devuelve SOLO el JSON con tu nuevo veredicto.`);
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDATOR CALL — multi-turn conversation
// ════════════════════════════════════════════════════════════════════════════

interface ValidationTurnInput {
  scene: Scene;
  staticImageBuffer: Buffer;
  keyframeBuffers: Buffer[];
  brandContext?: ValidatorBrandContext;
  prevScenes?: ValidatorPrevScene[];
  /** v3.2: imágenes de scenes anteriores como input visual (continuity check real). */
  prevScenesStaticBuffers?: Array<{ index: number; buffer: Buffer }>;
  scenePosition?: ValidatorScenePosition;
  scriptFullSummary?: string;
  attempt: number;
  /** v2: el historial COMPLETO de la conversación hasta ahora (turnos previos). */
  priorMessages: ClaudeMessage[];
  /** v2: overrides del owner desde el chat externo (ej. "ignora burned-text en scene 3"). */
  ownerOverrides?: string[];
  /** v2: anti-patrones acumulados que NO debe repetir en esta evaluación. */
  antiPatternsSoFar?: string[];
  /** v3.2 #111: comments del owner en scenes anteriores de ESTE run. */
  ownerCommentsThisRun?: string[];
  /** v3.2 #111: comments del owner en runs PREVIOS del mismo brand+preset. */
  ownerCommentsCrossRun?: string[];
  /** v3.2: imagen estática del intento previo (para comparación visual antes/después). */
  previousAttemptImageBuffer?: Buffer;
  /** v3.2: verdict del turno anterior (para construir checklist Y/N). */
  previousAttemptVerdict?: ValidatorVerdict | null;
  /** v3.2: imagePrompt del turno anterior (para diff). */
  previousAttemptPrompt?: string;
  model: string;
  apiKey: string;
}

interface ValidationTurnResult {
  ok: true;
  verdict: ValidatorVerdict;
  /** Mensajes nuevos (user + assistant) que se agregaron a la conversación. */
  newMessages: ClaudeMessage[];
  /** v3: razonamiento interno de Sonnet (extended thinking). Persistido para
   * que la UI muestre QUÉ pensó VALIDATOR antes de juzgar. */
  thinking?: string;
}

interface ValidationTurnError {
  ok: false;
  error: ClaudeApiError;
}

/**
 * Construye el contenido del user-message del turno actual. Si es el primer
 * turno, incluye TODO el contexto. Si es turno >1, solo recuerda el cambio
 * + las imágenes nuevas (Sonnet ya tiene el contexto del system prompt y
 * de los turnos previos en la conversación).
 */
function buildTurnUserContent(input: ValidationTurnInput): ClaudeMessageContent[] {
  const hasAnimatedClip = input.keyframeBuffers.length > 0;
  const isFirstTurn = input.attempt === 1;
  const hasPreviousAttemptImage = Boolean(input.previousAttemptImageBuffer);
  const content: ClaudeMessageContent[] = [];

  const text = isFirstTurn
    ? buildFirstTurnUserText({
        scene: input.scene,
        brandContext: input.brandContext,
        prevScenes: input.prevScenes,
        prevScenesImageCount: input.prevScenesStaticBuffers?.length ?? 0,
        scenePosition: input.scenePosition,
        scriptFullSummary: input.scriptFullSummary,
        hasAnimatedClip,
        keyframeCount: input.keyframeBuffers.length,
        ownerOverrides: input.ownerOverrides,
        antiPatternsSoFar: input.antiPatternsSoFar,
        ownerCommentsThisRun: input.ownerCommentsThisRun,
        ownerCommentsCrossRun: input.ownerCommentsCrossRun,
      })
    : buildRetryTurnUserText({
        scene: input.scene,
        hasAnimatedClip,
        keyframeCount: input.keyframeBuffers.length,
        attempt: input.attempt,
        antiPatternsSoFar: input.antiPatternsSoFar,
        previousVerdict: input.previousAttemptVerdict ?? undefined,
        previousImagePrompt: input.previousAttemptPrompt,
        hasPreviousAttemptImage,
      });

  // v3.2: ORDEN ESTRICTO de imágenes para Sonnet:
  //   1. Frame -1 (intento previo) si existe → para comparación antes/después
  //   2. Frame 0 (imagen estática actual)
  //   3. Frames 1..N (keyframes del clip)
  //   4. Frames N+1..M (prev scenes para continuity check) si existen
  //
  // El texto al final clarifica el mapeo.
  if (hasPreviousAttemptImage && input.previousAttemptImageBuffer) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: input.previousAttemptImageBuffer.toString('base64'),
      },
    });
  }
  content.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: input.staticImageBuffer.toString('base64'),
    },
  });
  for (const buf of input.keyframeBuffers) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
    });
  }
  if (input.prevScenesStaticBuffers) {
    for (const ps of input.prevScenesStaticBuffers) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: ps.buffer.toString('base64'),
        },
      });
    }
  }
  content.push({ type: 'text', text });
  return content;
}

// v3.2 #134 (29-may-2026): sanea priorMessages reemplazando imágenes base64
// de turnos viejos por placeholders de texto. Sin esto, en attempt 3 el payload
// acumula 3 sets de keyframes + prev images + static images = 30-50 MB → 413.
// Mantenemos imágenes solo en los 2 últimos mensajes (último user + último
// assistant) que dan contexto de razonamiento inmediato. Lo anterior se
// referencia como texto.
function sanitizePriorMessagesForRetry(priorMessages: ClaudeMessage[]): ClaudeMessage[] {
  if (priorMessages.length <= 2) return priorMessages;
  const KEEP_FULL_LAST_N = 2;
  const cutoff = priorMessages.length - KEEP_FULL_LAST_N;
  return priorMessages.map((msg, i) => {
    if (i >= cutoff) return msg; // keep fully
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;
    let imageCount = 0;
    const stripped = msg.content.map((block: unknown) => {
      const b = block as { type?: string };
      if (b.type === 'image') {
        imageCount++;
        return {
          type: 'text' as const,
          text: `[image-${imageCount} from earlier attempt — content referenced in subsequent reasoning]`,
        };
      }
      return block as { type: string };
    });
    return { ...msg, content: stripped } as ClaudeMessage;
  });
}

async function callValidator(
  input: ValidationTurnInput,
): Promise<ValidationTurnResult | ValidationTurnError> {
  const userContent = buildTurnUserContent(input);
  const userMessage: ClaudeMessage = { role: 'user', content: userContent };
  const sanitizedPrior = sanitizePriorMessagesForRetry(input.priorMessages);
  const messages: ClaudeMessage[] = [...sanitizedPrior, userMessage];

  // Retry loop para 429 (rate limit Sonnet 30k tok/min)
  for (let attempt = 0; attempt < RETRY_429_BACKOFF_MS.length + 1; attempt++) {
    // v3: max_tokens incluye los thinking tokens, hay que reservar budget
    // para razonamiento + JSON output. Si thinking=4000, dejamos ~3000 para JSON.
    const maxTokensTotal = THINKING_ENABLED ? THINKING_BUDGET_TOKENS + 3000 : 2500;
    const callResult = await callAnthropicMessages({
      apiKey: input.apiKey,
      model: input.model,
      maxTokens: maxTokensTotal,
      temperature: THINKING_ENABLED ? 1 : 0, // thinking exige temp=1
      timeoutMs: REQUEST_TIMEOUT_MS,
      system: VALIDATOR_SYSTEM_PROMPT,
      messages,
      ...(THINKING_ENABLED
        ? { thinking: { type: 'enabled' as const, budget_tokens: THINKING_BUDGET_TOKENS } }
        : {}),
    });
    if (callResult.isErr()) {
      const err = callResult.error;
      const is429 =
        err.status === 429 ||
        /rate.?limit/i.test(err.message) ||
        /rate.?limit/i.test(err.detail ?? '');
      if (is429 && attempt < RETRY_429_BACKOFF_MS.length) {
        const wait = RETRY_429_BACKOFF_MS[attempt]!;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return { ok: false, error: err };
    }
    // v3: extractFinalText ignora bloques 'thinking' y toma solo 'text'.
    const rawText = extractFinalText(callResult.value);
    const thinking = extractThinking(callResult.value);
    const extractResult = extractJsonFromClaudeText(rawText);
    if (extractResult.isErr()) {
      return { ok: false, error: extractResult.error };
    }
    const parsed = ValidatorVerdictSchema.safeParse(extractResult.value);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          type: 'schema-error',
          message: 'VALIDATOR response no matchea schema',
          detail: parsed.error.message.slice(0, 500),
        },
      };
    }
    const assistantMessage: ClaudeMessage = { role: 'assistant', content: rawText };
    return {
      ok: true,
      verdict: parsed.data,
      newMessages: [userMessage, assistantMessage],
      thinking: thinking || undefined,
    };
  }
  return {
    ok: false,
    error: { type: 'api-error', message: 'VALIDATOR CHAT IA exhausted 429 retries' },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SEMÁFORO interno — controla concurrencia GLOBAL hacia Sonnet
// ════════════════════════════════════════════════════════════════════════════

class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];
  constructor(slots: number) {
    this.slots = Math.max(1, slots);
  }
  async acquire(): Promise<() => void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolveFn) => {
      this.queue.push(() => {
        this.slots -= 1;
        resolveFn(() => this.release());
      });
    });
  }
  private release(): void {
    this.slots += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Instancia única para el módulo. Compartida entre todas las llamadas concurrentes
// a validateScene desde el animator. Sonnet 30k tok/min → 2 paralelos seguro.
const validatorSemaphore = new Semaphore(INTERNAL_CONCURRENCY);

// ════════════════════════════════════════════════════════════════════════════
// EXTRACCIÓN DE KEYFRAMES desde el clip
// ════════════════════════════════════════════════════════════════════════════

interface KeyframesResult {
  buffers: Buffer[];
  paths: string[];
  workDir: string;
  durationSec: number | null;
}

/**
 * v2 (27-may-2026): extracción EXHAUSTIVA — 1 frame por segundo, piso 4, techo 10.
 * Esto honra el pedido literal del owner ("todos los frames precisos") y aumenta
 * dramáticamente la sensibilidad para detectar:
 *   - static-loop: 3 frames podían parecer "iguales" en clips lentos pero
 *     tener motion sutil; con 8 frames el delta es obvio.
 *   - morphing intermedio: con solo 3 frames te perdías deformaciones que
 *     ocurren entre los samples; con 8 frames cubrís el clip casi por entero.
 *   - lighting flicker: cambios de iluminación frame-a-frame.
 */
async function extractClipKeyframes(
  videoPath: string,
  runId: string,
  sceneIndex: number,
  attempt: number,
): Promise<KeyframesResult> {
  // Cada attempt va a su propio subdir para que los frames previos se preserven
  // (útil para el historial conversacional y debugging).
  const tmpDir = resolve(
    VALIDATOR_STORAGE_ABS,
    runId,
    `scene_${String(sceneIndex).padStart(2, '0')}_keyframes_attempt_${attempt}`,
  );
  await mkdir(tmpDir, { recursive: true });
  const durationSec = await getVideoDurationSec(videoPath);
  const rawCount = Math.round((durationSec ?? 8) * FRAMES_PER_SECOND);
  // v3.2 #134: caps progresivos para evitar 413 en attempts altos
  const maxForThisAttempt =
    attempt >= 3 ? MAX_FRAMES_RETRY_HARD_2 : attempt >= 2 ? MAX_FRAMES_RETRY_HARD : MAX_FRAMES;
  const widthForThisAttempt = attempt >= 3 ? KEYFRAME_WIDTH_RETRY : KEYFRAME_WIDTH;
  const count = Math.max(MIN_FRAMES, Math.min(maxForThisAttempt, rawCount));
  const keyframes = await extractKeyframes({
    videoPath,
    outputDir: tmpDir,
    count,
    widthPx: widthForThisAttempt,
  });
  const buffers = await Promise.all(keyframes.map((k) => readFile(k.filePath)));
  return {
    buffers,
    paths: keyframes.map((k) => k.filePath),
    workDir: tmpDir,
    durationSec,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PERSISTENCIA DEL HISTORIAL (visible en la UI)
// ════════════════════════════════════════════════════════════════════════════

export interface ValidatorHistoryEntry {
  runId: string;
  sceneIndex: number;
  timestampIso: string;
  attempt: number;
  durationMs: number;
  hadAnimatedClip: boolean;
  keyframesExtracted: number;
  clipDurationSec?: number | null;
  verdict: ValidatorVerdict | null;
  apiError: { type: string; message: string; detail?: string } | null;
  imagePrompt: string;
  // Si verdict=wrong, qué prompts proponía VALIDATOR para corregir
  correctedImagePrompt?: string;
  correctedMotionPrompt?: string;
  modelUsed: string;
  /** v2: paths de los keyframes extraídos para que la UI pueda mostrarlos. */
  keyframePaths?: string[];
  /** v2: anti-patrones que estaban acumulados al momento de evaluar (audit trail). */
  antiPatternsAtEval?: string[];
  /** v2: overrides activos del owner al momento de evaluar. */
  ownerOverridesAtEval?: string[];
  /** v3: razonamiento interno (extended thinking) de Sonnet — la UI lo muestra
   * en un collapse "ver razonamiento de VALIDATOR" para que se vea POR QUÉ
   * llegó al verdict. Esto es la chain-of-thought completa. */
  thinkingContent?: string;
  /** v3: el flujo donde se generó esta validación. 'internal-chat' es el chat
   * canónico pipeline↔VALIDATOR. 'external-chat' es owner↔VALIDATOR. */
  flow?: 'internal-chat' | 'external-chat' | 'audit-endpoint';
}

// Mutex global para serializar escrituras al JSONL. Sin esto, dos validators
// que terminan al mismo tiempo (la semaphore deja pasar 2) podrían corromper
// la última línea del archivo en Windows (writeFile append no es atómico).
let historyWriteLock: Promise<void> = Promise.resolve();

async function appendHistory(runId: string, entry: ValidatorHistoryEntry): Promise<void> {
  // Encadenamos cada escritura al final de la cola, garantizando serialización
  // estricta sin importar cuántos validators terminen simultáneamente.
  const prev = historyWriteLock;
  let releaseLock: () => void = () => undefined;
  historyWriteLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  try {
    await prev;
    const dir = resolve(VALIDATOR_STORAGE_ABS, runId);
    await mkdir(dir, { recursive: true });
    const jsonlPath = join(dir, 'history.jsonl');
    await writeFile(
      jsonlPath,
      JSON.stringify(entry) + '\n',
      existsSync(jsonlPath) ? { flag: 'a' } : { flag: 'w' },
    );
    // También escribimos el último veredicto per-scene como JSON pretty para
    // que la UI lo pueda renderizar sin parsear el JSONL completo.
    const lastPath = join(dir, `scene_${String(entry.sceneIndex).padStart(2, '0')}_latest.json`);
    await writeFile(lastPath, JSON.stringify(entry, null, 2));
  } finally {
    releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MARKDOWN persistence — la conversación legible que el owner puede leer
// ════════════════════════════════════════════════════════════════════════════

let markdownWriteLock: Promise<void> = Promise.resolve();

/**
 * Persiste la conversación de UNA scene como markdown legible. El owner puede
 * abrir el archivo y ver textualmente lo que VALIDATOR razonó turno por turno.
 * Esto materializa el "CHAT" que el owner pidió — no es solo logs estructurados,
 * es una conversación que un humano puede leer.
 */
async function persistConversationMarkdown(
  runId: string,
  sceneIndex: number,
  conversationMessages: ClaudeMessage[],
  verdictHistory: Array<ValidatorVerdict | null>,
  thinkingHistory: Array<string | undefined> = [],
): Promise<void> {
  const prev = markdownWriteLock;
  let releaseLock: () => void = () => undefined;
  markdownWriteLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  try {
    await prev;
    const dir = resolve(VALIDATOR_STORAGE_ABS, runId);
    await mkdir(dir, { recursive: true });
    const md: string[] = [];
    md.push(`# ${VALIDATOR_NAME} — Conversación scene #${sceneIndex}`);
    md.push('');
    md.push(`_Run:_ \`${runId}\``);
    md.push(`_Última actualización:_ ${new Date().toISOString()}`);
    md.push(`_Turnos:_ ${conversationMessages.filter((m) => m.role === 'user').length}`);
    md.push('');
    md.push('---');
    md.push('');
    let userTurnNum = 0;
    let assistantTurnNum = 0;
    for (let i = 0; i < conversationMessages.length; i++) {
      const msg = conversationMessages[i]!;
      if (msg.role === 'user') {
        userTurnNum += 1;
        md.push(`## 🛠️ Pipeline → VALIDATOR (turno ${userTurnNum})`);
        md.push('');
        if (typeof msg.content === 'string') {
          md.push(msg.content);
        } else {
          const contentArr = msg.content as ClaudeMessageContent[];
          const textPart = contentArr.find((c) => c.type === 'text');
          const imageCount = contentArr.filter((c) => c.type === 'image').length;
          md.push(`_(${imageCount} imágenes adjuntas)_`);
          md.push('');
          if (textPart && textPart.type === 'text') md.push(textPart.text);
        }
        md.push('');
      } else {
        assistantTurnNum += 1;
        md.push(`## 🤖 VALIDATOR CHAT IA → Pipeline (turno ${assistantTurnNum})`);
        md.push('');
        // v3: razonamiento interno (extended thinking) primero, para que el
        // owner vea CÓMO llegó al verdict, no solo el verdict.
        const thinkingText = thinkingHistory[assistantTurnNum - 1];
        if (thinkingText) {
          md.push('<details><summary>🧠 <b>Razonamiento interno (extended thinking)</b></summary>');
          md.push('');
          md.push('```');
          md.push(thinkingText);
          md.push('```');
          md.push('');
          md.push('</details>');
          md.push('');
        }
        const verdict = verdictHistory[assistantTurnNum - 1];
        if (verdict) {
          md.push(
            `**Verdict:** \`${verdict.verdict}\` · confidence ${verdict.confidence}/100 · nextAction \`${verdict.nextAction}\``,
          );
          md.push(
            `**staticImageOk:** ${verdict.staticImageOk} · **animationOk:** ${verdict.animationOk ?? 'null'}`,
          );
          md.push('');
          if (verdict.issues.length) {
            md.push('**Issues:**');
            for (const iss of verdict.issues) {
              md.push(
                `  - \`${iss.severity}/${iss.category}\` (${iss.aspect}, frame ${iss.evidenceFrameIndex ?? '?'}, region ${iss.evidenceRegion ?? '?'}): ${iss.description}`,
              );
            }
            md.push('');
          }
          if (verdict.correctedImagePrompt) {
            md.push('**correctedImagePrompt:**');
            md.push('```');
            md.push(verdict.correctedImagePrompt);
            md.push('```');
            md.push('');
          }
          if (verdict.correctedMotionPrompt) {
            md.push('**correctedMotionPrompt:**');
            md.push('```');
            md.push(verdict.correctedMotionPrompt);
            md.push('```');
            md.push('');
          }
          if (verdict.systemicAntiPattern) {
            md.push(`**🚫 systemicAntiPattern:** ${verdict.systemicAntiPattern}`);
            md.push('');
          }
          md.push('**Rationale:**');
          md.push(`> ${verdict.rationale}`);
        } else {
          md.push('_(verdict no disponible — error de parsing o API)_');
        }
        md.push('');
        md.push('---');
        md.push('');
      }
    }
    const mdPath = join(dir, `scene_${String(sceneIndex).padStart(2, '0')}_conversation.md`);
    await writeFile(mdPath, md.join('\n'), 'utf-8');
  } finally {
    releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ANTI-PATTERN MEMORY — acumulado per-run
// ════════════════════════════════════════════════════════════════════════════

interface AntiPatternEntry {
  runId: string;
  sceneIndex: number;
  attempt: number;
  timestampIso: string;
  pattern: string;
  category: string;
}

let antiPatternWriteLock: Promise<void> = Promise.resolve();

async function appendAntiPattern(entry: AntiPatternEntry): Promise<void> {
  const prev = antiPatternWriteLock;
  let releaseLock: () => void = () => undefined;
  antiPatternWriteLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  try {
    await prev;
    const dir = resolve(VALIDATOR_STORAGE_ABS, entry.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'anti-patterns.jsonl');
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
  } finally {
    releaseLock();
  }
}

/**
 * v3.2: helper para CERRAR EL LOOP — toma un imagePrompt base y le agrega
 * las anti-patterns acumuladas del run como instrucciones negativas explícitas.
 *
 * Diseño: muchos providers (Imagen, gpt-image-1) NO soportan negativePrompt
 * como campo separado, así que metemos las anti-patterns como texto al final
 * del prompt con formato muy explícito. Es la única forma de que llegue al
 * modelo de imagen y NO solo a Sonnet.
 *
 * Esto evita el problema de v3.1 donde VALIDATOR detectaba un anti-pattern
 * pero el siguiente regen NO lo sabía → mismo error reaparece.
 */
export async function fortifyPromptWithAntiPatterns(
  basePrompt: string,
  runId: string,
  options: { maxPatterns?: number; minPatternLength?: number } = {},
): Promise<string> {
  const maxPatterns = options.maxPatterns ?? 8;
  const minPatternLength = options.minPatternLength ?? 20;
  const patterns = await getUniqueAntiPatternsForRun(runId).catch(() => [] as string[]);
  const usable = patterns
    .filter((p) => p.length >= minPatternLength)
    .slice(-maxPatterns);
  if (usable.length === 0) return basePrompt;
  const negativeBlock =
    `\n\nCRITICAL — AVOID THESE PATTERNS (detected as failures earlier in this run):\n` +
    usable.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\nIgnoring any of these will cause automatic rejection.`;
  return basePrompt + negativeBlock;
}

/**
 * Lee los anti-patrones acumulados para un run. Útil para fortificar el
 * negativePrompt de la SIGUIENTE escena del MISMO run.
 */
export async function readAntiPatterns(runId: string): Promise<AntiPatternEntry[]> {
  const path = resolve(VALIDATOR_STORAGE_ABS, runId, 'anti-patterns.jsonl');
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AntiPatternEntry);
  } catch {
    return [];
  }
}

/**
 * Devuelve los anti-patrones únicos (deduped por pattern text) para inyectar
 * como negativePrompt fortificado.
 */
export async function getUniqueAntiPatternsForRun(runId: string): Promise<string[]> {
  const entries = await readAntiPatterns(runId);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const e of entries) {
    const normalized = e.pattern.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(e.pattern);
    }
  }
  return unique;
}

// ════════════════════════════════════════════════════════════════════════════
// OWNER OVERRIDES — el owner ignora ciertos issues vía chat externo
// ════════════════════════════════════════════════════════════════════════════

interface OwnerOverrideEntry {
  runId: string;
  timestampIso: string;
  scope: 'global' | 'scene';
  sceneIndex?: number;
  instruction: string;
}

let overrideWriteLock: Promise<void> = Promise.resolve();

export async function appendOwnerOverride(entry: OwnerOverrideEntry): Promise<void> {
  const prev = overrideWriteLock;
  let releaseLock: () => void = () => undefined;
  overrideWriteLock = new Promise<void>((r) => {
    releaseLock = r;
  });
  try {
    await prev;
    const dir = resolve(VALIDATOR_STORAGE_ABS, entry.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'owner-overrides.jsonl');
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8');
  } finally {
    releaseLock();
  }
}

export async function readOwnerOverrides(
  runId: string,
  sceneIndex?: number,
): Promise<string[]> {
  const path = resolve(VALIDATOR_STORAGE_ABS, runId, 'owner-overrides.jsonl');
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    const entries = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OwnerOverrideEntry);
    return entries
      .filter(
        (e) => e.scope === 'global' || (e.scope === 'scene' && e.sceneIndex === sceneIndex),
      )
      .map((e) => e.instruction);
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — validateScene (single call)
// ════════════════════════════════════════════════════════════════════════════

export interface ValidateSceneOptions {
  runId: string;
  scene: Scene;
  /** Path absoluto al PNG estático (obligatorio). */
  staticImagePath: string;
  /** Path absoluto al clip MP4 animado (opcional — si no existe, solo se evalúa el estático). */
  animatedVideoPath?: string;
  brandContext?: ValidatorBrandContext;
  prevScenes?: ValidatorPrevScene[];
  scenePosition?: ValidatorScenePosition;
  scriptFullSummary?: string;
  attempt?: number; // default 1
  /** v2: historial de mensajes para multi-turn. Si attempt=1, debe ser []. */
  priorMessages?: ClaudeMessage[];
  /** v2: verdicts previos (para que markdown muestre cada turno con su verdict). */
  priorVerdicts?: Array<ValidatorVerdict | null>;
  /** v3: thinking content previo (extended thinking — para el markdown legible). */
  priorThinking?: Array<string | undefined>;
  /** v3.2: path del PNG estático del intento anterior — se inyecta como "Frame -1"
   * para que Sonnet compare antes/después visualmente. Solo aplica si attempt > 1. */
  previousAttemptStaticPath?: string;
  /** v3.2: imagePrompt usado en el intento anterior — para diff explícito. */
  previousAttemptPrompt?: string;
  model?: string;
  apiKey?: string;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

export interface ValidateSceneResult {
  verdict: ValidatorVerdict | null;
  error: { type: string; message: string; detail?: string } | null;
  durationMs: number;
  keyframesExtracted: number;
  history: ValidatorHistoryEntry;
  /** v2: la conversación completa actualizada (input priorMessages + nuevos turnos). */
  updatedMessages: ClaudeMessage[];
  /** v2: lista de verdicts incluyendo el nuevo. */
  updatedVerdicts: Array<ValidatorVerdict | null>;
  /** v3: thinking history actualizada (uno por turno assistant). */
  updatedThinking: Array<string | undefined>;
}

/**
 * VALIDATOR CHAT IA evalúa UNA escena en UN turno de su conversación. Devuelve
 * el verdict + persiste el historial (jsonl + markdown legible) + actualiza la
 * conversación con el nuevo turno. NO regenera la escena por sí solo.
 *
 * Para el loop completo multi-turn con auto-corrección, usa `runValidatorLoop()`.
 */
export async function validateScene(
  opts: ValidateSceneOptions,
): Promise<ValidateSceneResult> {
  const t0 = Date.now();
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = opts.model ?? VALIDATOR_MODEL_DEFAULT;
  const attempt = opts.attempt ?? 1;
  const priorMessages = opts.priorMessages ?? [];
  const priorVerdicts = opts.priorVerdicts ?? [];
  const logger = opts.logger;

  // Cargar anti-patrones y overrides para inyectar en el turno
  // v3.2 #111: ADEMÁS cargar comentarios del owner — tanto del run actual como
  // de runs previos del mismo brand+preset (cross-run memory). VALIDATOR usa
  // estos como guidance: "esto es lo que el owner típicamente señala mal".
  const [antiPatternsSoFar, ownerOverrides, ownerCommentsThisRun, ownerCommentsCrossRun] =
    await Promise.all([
      getUniqueAntiPatternsForRun(opts.runId).catch(() => [] as string[]),
      readOwnerOverrides(opts.runId, opts.scene.index).catch(() => [] as string[]),
      // Comments del owner en scenes ANTERIORES de ESTE run
      (async () => {
        try {
          const { readAllRunFeedback } = await import('./owner-feedback');
          const all = await readAllRunFeedback(opts.runId);
          return all
            .filter((i) => i.type === 'comment' && i.comment)
            .map((i) => `[scene ${i.sceneIndex ?? 'global'}/${i.category ?? 'general'}] ${i.comment}`);
        } catch {
          return [] as string[];
        }
      })(),
      // Comments del owner en runs PREVIOS del mismo brand+preset
      (async () => {
        try {
          if (!opts.brandContext?.brandId) return [] as string[];
          const presetId = opts.brandContext.presetId;
          if (!presetId) return [] as string[];
          const { getRelevantCommentsForContext } = await import('./owner-feedback');
          const comments = await getRelevantCommentsForContext({
            brandId: opts.brandContext.brandId,
            presetId,
            sceneNarration: opts.scene.text,
            limit: 5,
          });
          return comments
            .filter((c) => c.comment)
            .map((c) => `[${c.category ?? 'general'}] ${c.comment}`);
        } catch {
          return [] as string[];
        }
      })(),
    ]);

  logger?.info(
    {
      runId: opts.runId,
      sceneIndex: opts.scene.index,
      attempt,
      model,
      priorTurns: priorMessages.length / 2,
      antiPatternsCount: antiPatternsSoFar.length,
      ownerOverridesCount: ownerOverrides.length,
      thinkingEnabled: THINKING_ENABLED,
      flow: 'internal-chat',
      entity: VALIDATOR_NAME,
    },
    `${VALIDATOR_NAME} · INTERNAL CHAT · scene ${opts.scene.index} · turn ${attempt} START`,
  );

  function buildEarlyExitEntry(err: NonNullable<ValidateSceneResult['error']>): ValidatorHistoryEntry {
    return {
      runId: opts.runId,
      sceneIndex: opts.scene.index,
      timestampIso: new Date().toISOString(),
      attempt,
      durationMs: Date.now() - t0,
      hadAnimatedClip: Boolean(opts.animatedVideoPath),
      keyframesExtracted: 0,
      verdict: null,
      apiError: err,
      imagePrompt: opts.scene.imagePrompt,
      modelUsed: model,
      antiPatternsAtEval: antiPatternsSoFar,
      ownerOverridesAtEval: ownerOverrides,
    };
  }

  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    const entry = buildEarlyExitEntry({
      type: 'no-api-key',
      message: 'ANTHROPIC_API_KEY no configurada',
    });
    await appendHistory(opts.runId, entry);
    return {
      verdict: null,
      error: entry.apiError,
      durationMs: entry.durationMs,
      keyframesExtracted: 0,
      history: entry,
      updatedMessages: priorMessages,
      updatedVerdicts: [...priorVerdicts, null],
      updatedThinking: [...(opts.priorThinking ?? []), undefined],
    };
  }

  // Read static image
  let staticImageBuffer: Buffer;
  try {
    staticImageBuffer = await readFile(opts.staticImagePath);
  } catch (e) {
    const entry = buildEarlyExitEntry({
      type: 'api-error',
      message: `No se pudo leer la imagen estática: ${(e as Error).message}`,
    });
    await appendHistory(opts.runId, entry);
    return {
      verdict: null,
      error: entry.apiError,
      durationMs: entry.durationMs,
      keyframesExtracted: 0,
      history: entry,
      updatedMessages: priorMessages,
      updatedVerdicts: [...priorVerdicts, null],
      updatedThinking: [...(opts.priorThinking ?? []), undefined],
    };
  }

  // Extract keyframes from clip if exists (1 frame por segundo, adaptativo)
  let keyframeBuffers: Buffer[] = [];
  let keyframesExtracted = 0;
  let keyframePaths: string[] = [];
  let clipDurationSec: number | null = null;
  if (opts.animatedVideoPath && existsSync(opts.animatedVideoPath)) {
    try {
      const kfResult = await extractClipKeyframes(
        opts.animatedVideoPath,
        opts.runId,
        opts.scene.index,
        attempt,
      );
      keyframeBuffers = kfResult.buffers;
      keyframesExtracted = kfResult.buffers.length;
      keyframePaths = kfResult.paths;
      clipDurationSec = kfResult.durationSec;
      logger?.info(
        {
          runId: opts.runId,
          sceneIndex: opts.scene.index,
          extracted: keyframesExtracted,
          durationSec: clipDurationSec,
        },
        'validator-chat-ia:keyframes_extracted',
      );
    } catch (e) {
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: opts.scene.index,
          err: (e as Error).message,
        },
        'validator-chat-ia:keyframe_extraction_failed_evaluating_static_only',
      );
    }
  }

  // v3.2: cargar imagen del intento previo si fue provista (para comparación
  // visual antes/después en el retry)
  let previousAttemptImageBuffer: Buffer | undefined;
  if (
    attempt > 1 &&
    opts.previousAttemptStaticPath &&
    existsSync(opts.previousAttemptStaticPath)
  ) {
    try {
      previousAttemptImageBuffer = await readFile(opts.previousAttemptStaticPath);
    } catch {
      previousAttemptImageBuffer = undefined;
    }
  }

  // v3.2: cargar imágenes estáticas de las prev scenes para continuity visual
  // real. Limitamos a 2 prev (cost/latency budget) y skip si tokens explotan.
  let prevScenesStaticBuffers: Array<{ index: number; buffer: Buffer }> | undefined;
  if (opts.prevScenes && opts.prevScenes.length > 0) {
    prevScenesStaticBuffers = [];
    const maxPrevImages = 2;
    for (const ps of opts.prevScenes.slice(-maxPrevImages)) {
      // El path lo derivamos heurísticamente: workDir del run + scene_NN.png
      // que es la convención de regenerateSingleScene + image-gen-multi.
      // Si no existe, skip.
      const runWorkDir = dirname(opts.staticImagePath);
      const candidatePath = join(
        runWorkDir,
        `scene_${String(ps.index).padStart(2, '0')}.png`,
      );
      if (existsSync(candidatePath)) {
        try {
          const buf = await readFile(candidatePath);
          prevScenesStaticBuffers.push({ index: ps.index, buffer: buf });
        } catch {
          /* skip */
        }
      }
    }
    if (prevScenesStaticBuffers.length === 0) prevScenesStaticBuffers = undefined;
  }

  // Find previous attempt's verdict from priorVerdicts (last non-null)
  const previousAttemptVerdict =
    attempt > 1 && priorVerdicts.length > 0
      ? priorVerdicts[priorVerdicts.length - 1]
      : null;

  // Call Sonnet bajo el semáforo de concurrencia interna
  const release = await validatorSemaphore.acquire();
  let callResult: ValidationTurnResult | ValidationTurnError;
  try {
    callResult = await callValidator({
      scene: opts.scene,
      staticImageBuffer,
      keyframeBuffers,
      brandContext: opts.brandContext,
      prevScenes: opts.prevScenes,
      prevScenesStaticBuffers,
      scenePosition: opts.scenePosition,
      scriptFullSummary: opts.scriptFullSummary,
      attempt,
      priorMessages,
      ownerOverrides,
      antiPatternsSoFar,
      ownerCommentsThisRun,
      ownerCommentsCrossRun,
      previousAttemptImageBuffer,
      previousAttemptVerdict,
      previousAttemptPrompt: opts.previousAttemptPrompt,
      model,
      apiKey,
    });
  } finally {
    release();
  }

  const durationMs = Date.now() - t0;
  const verdict = callResult.ok ? callResult.verdict : null;
  const apiError = callResult.ok
    ? null
    : { type: callResult.error.type, message: callResult.error.message, detail: callResult.error.detail };
  const newMessages = callResult.ok ? callResult.newMessages : [];
  const thinkingContent = callResult.ok ? callResult.thinking : undefined;
  const updatedMessages = [...priorMessages, ...newMessages];
  const updatedVerdicts = [...priorVerdicts, verdict];

  const entry: ValidatorHistoryEntry = {
    runId: opts.runId,
    sceneIndex: opts.scene.index,
    timestampIso: new Date().toISOString(),
    attempt,
    durationMs,
    hadAnimatedClip: Boolean(opts.animatedVideoPath),
    keyframesExtracted,
    clipDurationSec,
    verdict,
    apiError,
    imagePrompt: opts.scene.imagePrompt,
    correctedImagePrompt: verdict?.correctedImagePrompt,
    correctedMotionPrompt: verdict?.correctedMotionPrompt,
    modelUsed: model,
    keyframePaths,
    antiPatternsAtEval: antiPatternsSoFar,
    ownerOverridesAtEval: ownerOverrides,
    thinkingContent,
    flow: 'internal-chat',
  };
  await appendHistory(opts.runId, entry);

  // Persistir conversación markdown (best-effort)
  // v3: pasamos thinking history para que el markdown muestre el razonamiento
  // interno de Sonnet en cada turno (collapsable).
  const updatedThinking = [...(opts.priorThinking ?? []), thinkingContent];
  if (newMessages.length > 0) {
    await persistConversationMarkdown(
      opts.runId,
      opts.scene.index,
      updatedMessages,
      updatedVerdicts,
      updatedThinking,
    ).catch((e) =>
      logger?.warn(
        { runId: opts.runId, sceneIndex: opts.scene.index, err: (e as Error).message },
        'validator-chat-ia:markdown_persist_failed',
      ),
    );
  }

  // Persistir anti-pattern si VALIDATOR sugirió uno + verdict fue wrong
  if (verdict && verdict.verdict === 'wrong' && verdict.systemicAntiPattern) {
    const firstCriticalCategory =
      verdict.issues.find((i) => i.severity === 'critical')?.category ??
      verdict.issues[0]?.category ??
      'other';
    await appendAntiPattern({
      runId: opts.runId,
      sceneIndex: opts.scene.index,
      attempt,
      timestampIso: new Date().toISOString(),
      pattern: verdict.systemicAntiPattern,
      category: firstCriticalCategory,
    }).catch((e) =>
      logger?.warn(
        { runId: opts.runId, err: (e as Error).message },
        'validator-chat-ia:anti_pattern_persist_failed',
      ),
    );
  }

  if (verdict) {
    logger?.info(
      {
        runId: opts.runId,
        sceneIndex: opts.scene.index,
        attempt,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        nextAction: verdict.nextAction,
        staticOk: verdict.staticImageOk,
        animOk: verdict.animationOk,
        criticalCount: verdict.issues.filter((i) => i.severity === 'critical').length,
        majorCount: verdict.issues.filter((i) => i.severity === 'major').length,
        hasCorrectedImg: Boolean(verdict.correctedImagePrompt),
        hasCorrectedMotion: Boolean(verdict.correctedMotionPrompt),
        hasAntiPattern: Boolean(verdict.systemicAntiPattern),
        durationMs,
        entity: VALIDATOR_NAME,
      },
      'validator-chat-ia:verdict',
    );
  } else {
    logger?.warn(
      {
        runId: opts.runId,
        sceneIndex: opts.scene.index,
        attempt,
        error: apiError,
        durationMs,
        entity: VALIDATOR_NAME,
      },
      'validator-chat-ia:error',
    );
  }

  return {
    verdict,
    error: apiError,
    durationMs,
    keyframesExtracted,
    history: entry,
    updatedMessages,
    updatedVerdicts,
    updatedThinking,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — runValidatorLoop (validate + auto-retry loop)
// ════════════════════════════════════════════════════════════════════════════

export interface ValidatorLoopOptions extends ValidateSceneOptions {
  /** Máximo número de intentos (validate + regenerate/re-animate). Default 2 (1 evaluación + 1 retry). */
  maxAttempts?: number;
  /**
   * Callback que el caller provee para REGENERAR la imagen cuando VALIDATOR pide
   * un correctedImagePrompt. Debe sobrescribir el PNG en disco y devolver el
   * nuevo path + el nuevo Scene.
   */
  onRegenerateImage?: (args: {
    scene: Scene;
    correctedImagePrompt: string;
    attempt: number;
  }) => Promise<{ updatedScene: Scene; newStaticImagePath: string }>;
  /**
   * Callback para RE-ANIMAR la escena cuando VALIDATOR pide un correctedMotionPrompt.
   * Debe sobrescribir el MP4 y devolver el nuevo path.
   */
  onReanimate?: (args: {
    scene: Scene;
    staticImagePath: string;
    correctedMotionPrompt: string;
    attempt: number;
  }) => Promise<{ updatedScene: Scene; newAnimatedVideoPath?: string }>;
}

export interface ValidatorLoopResult {
  finalScene: Scene;
  finalStaticImagePath: string;
  finalAnimatedVideoPath?: string;
  verdict: ValidatorVerdict | null;
  attemptsUsed: number;
  history: ValidatorHistoryEntry[];
  /** true si VALIDATOR aprobó la escena en algún momento. */
  passed: boolean;
}

/**
 * Loop conversacional MULTI-TURN con auto-corrección hasta `maxAttempts`.
 *
 * v2 (27-may-2026): cada validateScene mantiene la MISMA conversación con
 * Sonnet — los priorMessages crecen turno a turno. Sonnet ve sus propios
 * veredictos previos y razona iterativamente. Esto materializa el pedido
 * literal del owner: "IA QUE CONVERSE CON LA HERRAMIENTA".
 *
 * Decisión de acción por turno:
 *   1. verdict='right' → passed=true, fin.
 *   2. confidence < MIN_CONFIDENCE_FOR_AUTOFIX → 'needs-human-review',
 *      cortamos loop. Inútil quemar budget en cases borderline.
 *   3. nextAction='regenerate-image' → callback onRegenerateImage, luego
 *      re-animate (la imagen cambió), luego siguiente turno.
 *   4. nextAction='reanimate' → solo callback onReanimate, luego siguiente turno.
 *   5. nextAction='accept-with-warnings' → passed=true (los warnings se
 *      preservan en la historia).
 *   6. Después de maxAttempts sin lograr 'right' → passed=false.
 */
export async function runValidatorLoop(
  opts: ValidatorLoopOptions,
): Promise<ValidatorLoopResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const logger = opts.logger;

  let currentScene = opts.scene;
  let currentStaticPath = opts.staticImagePath;
  let currentAnimatedPath = opts.animatedVideoPath;
  // v2: la conversación crece turno a turno.
  let conversationMessages: ClaudeMessage[] = [];
  let conversationVerdicts: Array<ValidatorVerdict | null> = [];
  // v3: thinking content por turno (en orden).
  let conversationThinking: Array<string | undefined> = [];
  // v3.2: trackear estado del attempt anterior para comparación visual + diff
  let previousAttemptStaticPath: string | undefined;
  let previousAttemptPrompt: string | undefined;
  const history: ValidatorHistoryEntry[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await validateScene({
      ...opts,
      scene: currentScene,
      staticImagePath: currentStaticPath,
      animatedVideoPath: currentAnimatedPath,
      attempt,
      priorMessages: conversationMessages,
      priorVerdicts: conversationVerdicts,
      priorThinking: conversationThinking,
      previousAttemptStaticPath,
      previousAttemptPrompt,
    });
    history.push(result.history);
    conversationMessages = result.updatedMessages;
    conversationVerdicts = result.updatedVerdicts;
    conversationThinking = result.updatedThinking;

    // Error técnico de la API → cortamos el loop con passed=false
    if (!result.verdict) {
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          error: result.error,
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia:loop_aborted_on_api_error',
      );
      return {
        finalScene: currentScene,
        finalStaticImagePath: currentStaticPath,
        finalAnimatedVideoPath: currentAnimatedPath,
        verdict: null,
        attemptsUsed: attempt,
        history,
        passed: false,
      };
    }

    // v3.2: STRICT GUARD — si Sonnet dice accept-with-warnings pero hay
    // criticals genuinos en categorías intocables, override a regenerate.
    // Las 5 categorías del owner NO se pueden enmascarar como "warnings".
    const UNFORGIVABLE_CRITICALS = new Set([
      'unhealthy-character',
      'burned-text-hex-codes',
      'burned-text-gibberish',
      'burned-text-leaked',
      'anatomy',
    ]);
    const hasUnforgivableCritical = result.verdict.issues.some(
      (i) => i.severity === 'critical' && UNFORGIVABLE_CRITICALS.has(i.category),
    );
    if (
      result.verdict.nextAction === 'accept-with-warnings' &&
      hasUnforgivableCritical
    ) {
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          overriddenNextAction: 'regenerate-image',
          reason: 'unforgivable_critical_in_warnings',
          criticals: result.verdict.issues
            .filter((i) => i.severity === 'critical')
            .map((i) => i.category),
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia:strict_guard_overrode_accept_with_warnings',
      );
      // Mutamos el verdict in-place (Sonnet quiso aceptar, pero la regla
      // del owner es absoluta — los 5 errores NO pasan ni con warnings).
      result.verdict.nextAction = 'regenerate-image';
      result.verdict.verdict = 'wrong';
    }

    // ── A) Approve paths ────────────────────────────────────────────
    if (
      result.verdict.verdict === 'right' ||
      result.verdict.nextAction === 'accept' ||
      result.verdict.nextAction === 'accept-with-warnings'
    ) {
      const withWarnings = result.verdict.nextAction === 'accept-with-warnings';
      logger?.info(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          confidence: result.verdict.confidence,
          withWarnings,
          entity: VALIDATOR_NAME,
        },
        withWarnings
          ? 'validator-chat-ia:scene_accepted_with_warnings'
          : 'validator-chat-ia:scene_approved',
      );
      return {
        finalScene: currentScene,
        finalStaticImagePath: currentStaticPath,
        finalAnimatedVideoPath: currentAnimatedPath,
        verdict: result.verdict,
        attemptsUsed: attempt,
        history,
        passed: true,
      };
    }

    // ── B) Confidence-adaptive escalation ───────────────────────────
    // Si VALIDATOR no está seguro o pidió human-review, NO intentamos retry —
    // pasamos al humano. Esto evita quemar budget en cases borderline.
    if (
      result.verdict.nextAction === 'needs-human-review' ||
      result.verdict.confidence < MIN_CONFIDENCE_FOR_AUTOFIX
    ) {
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          confidence: result.verdict.confidence,
          nextAction: result.verdict.nextAction,
          reason: 'low_confidence_or_explicit_review_request',
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia:escalated_to_human_review',
      );
      return {
        finalScene: currentScene,
        finalStaticImagePath: currentStaticPath,
        finalAnimatedVideoPath: currentAnimatedPath,
        verdict: result.verdict,
        attemptsUsed: attempt,
        history,
        passed: false,
      };
    }

    // ── C) Budget agotado → pass false con verdict actual ───────────
    if (attempt >= maxAttempts) {
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          maxAttempts,
          issues: result.verdict.issues.map((i) => `${i.severity}/${i.category}`),
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia:scene_rejected_max_attempts_reached',
      );
      return {
        finalScene: currentScene,
        finalStaticImagePath: currentStaticPath,
        finalAnimatedVideoPath: currentAnimatedPath,
        verdict: result.verdict,
        attemptsUsed: attempt,
        history,
        passed: false,
      };
    }

    // ── D) Auto-corrección guiada por nextAction ────────────────────
    const v = result.verdict;
    let regenerated = false;

    if (v.nextAction === 'regenerate-image' && v.correctedImagePrompt && opts.onRegenerateImage) {
      try {
        // v3.2: capturar estado anterior ANTES de sobrescribir
        previousAttemptStaticPath = currentStaticPath;
        previousAttemptPrompt = currentScene.imagePrompt;
        const r = await opts.onRegenerateImage({
          scene: currentScene,
          correctedImagePrompt: v.correctedImagePrompt,
          attempt,
        });
        currentScene = r.updatedScene;
        currentStaticPath = r.newStaticImagePath;
        regenerated = true;
        logger?.info(
          { runId: opts.runId, sceneIndex: currentScene.index, attempt, entity: VALIDATOR_NAME },
          'validator-chat-ia:image_regenerated_for_retry',
        );
        // La imagen cambió, hay que re-animar
        if (opts.onReanimate) {
          const motion =
            v.correctedMotionPrompt ??
            'character mid-action, mouth speaking, eyes blink once, subtle head tilt, camera push-in 6% over 8s';
          try {
            const ar = await opts.onReanimate({
              scene: currentScene,
              staticImagePath: currentStaticPath,
              correctedMotionPrompt: motion,
              attempt,
            });
            currentScene = ar.updatedScene;
            currentAnimatedPath = ar.newAnimatedVideoPath ?? undefined;
          } catch (e) {
            logger?.warn(
              { runId: opts.runId, sceneIndex: currentScene.index, err: (e as Error).message },
              'validator-chat-ia:reanimate_after_regen_failed',
            );
            currentAnimatedPath = undefined;
          }
        }
      } catch (e) {
        logger?.warn(
          { runId: opts.runId, sceneIndex: currentScene.index, attempt, err: (e as Error).message },
          'validator-chat-ia:regenerate_image_failed',
        );
      }
    } else if (v.nextAction === 'reanimate' && v.correctedMotionPrompt && opts.onReanimate) {
      try {
        // v3.2: en reanimate la imagen estática NO cambia, pero igual la
        // marcamos como "prev" para que turno siguiente vea el mismo PNG
        // como referencia (con el clip nuevo).
        previousAttemptStaticPath = currentStaticPath;
        previousAttemptPrompt = currentScene.imagePrompt;
        const r = await opts.onReanimate({
          scene: currentScene,
          staticImagePath: currentStaticPath,
          correctedMotionPrompt: v.correctedMotionPrompt,
          attempt,
        });
        currentScene = r.updatedScene;
        currentAnimatedPath = r.newAnimatedVideoPath ?? undefined;
        regenerated = true;
        logger?.info(
          { runId: opts.runId, sceneIndex: currentScene.index, attempt, entity: VALIDATOR_NAME },
          'validator-chat-ia:reanimated_for_retry',
        );
      } catch (e) {
        logger?.warn(
          { runId: opts.runId, sceneIndex: currentScene.index, attempt, err: (e as Error).message },
          'validator-chat-ia:reanimate_failed',
        );
      }
    }

    if (!regenerated) {
      // No pudimos arreglar (sin callback o sin correctedPrompt) → cortar
      logger?.warn(
        {
          runId: opts.runId,
          sceneIndex: currentScene.index,
          attempt,
          nextAction: v.nextAction,
          hasCorrectedImg: Boolean(v.correctedImagePrompt),
          hasCorrectedMotion: Boolean(v.correctedMotionPrompt),
          hasImageCb: Boolean(opts.onRegenerateImage),
          hasAnimCb: Boolean(opts.onReanimate),
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia:no_correction_path_available_giving_up',
      );
      return {
        finalScene: currentScene,
        finalStaticImagePath: currentStaticPath,
        finalAnimatedVideoPath: currentAnimatedPath,
        verdict: v,
        attemptsUsed: attempt,
        history,
        passed: false,
      };
    }
  }

  // Fallback defensivo — shouldn't reach
  return {
    finalScene: currentScene,
    finalStaticImagePath: currentStaticPath,
    finalAnimatedVideoPath: currentAnimatedPath,
    verdict: null,
    attemptsUsed: maxAttempts,
    history,
    passed: false,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// API PÚBLICA — readValidatorHistory (para endpoint UI)
// ════════════════════════════════════════════════════════════════════════════

/**
 * v3.2 #104: genera un reporte markdown FINAL del trabajo de VALIDATOR en un run.
 * Se invoca cuando el pipeline completa (o al final del scene-animator). Persiste
 * `storage/validator-chat-ia/<runId>/run-report.md` con resumen owner-readable:
 *   - Stats agregados (scenes evaluated, approved, rejected)
 *   - Tabla per-scene con scores cuantificados
 *   - Anti-patterns descubiertos
 *   - Recomendaciones para el siguiente run
 */
export async function generateRunReport(runId: string): Promise<string | null> {
  const history = await readValidatorHistory(runId);
  if (history.length === 0) return null;
  const antiPatterns = await readAntiPatterns(runId);

  // Aggregations
  type SceneAccum = {
    sceneIndex: number;
    totalTurns: number;
    finalEntry: ValidatorHistoryEntry;
    bestScores: {
      composition: number | null;
      lighting: number | null;
      palette: number | null;
      facial: number | null;
      motion: number | null;
      narration: number | null;
      style: number | null;
    };
    apiErrors: number;
  };
  const bySceneIndex = new Map<number, SceneAccum>();
  for (const e of history) {
    const existing = bySceneIndex.get(e.sceneIndex);
    if (!existing) {
      bySceneIndex.set(e.sceneIndex, {
        sceneIndex: e.sceneIndex,
        totalTurns: 1,
        finalEntry: e,
        bestScores: {
          composition: null,
          lighting: null,
          palette: null,
          facial: null,
          motion: null,
          narration: null,
          style: null,
        },
        apiErrors: e.verdict ? 0 : 1,
      });
    } else {
      existing.totalTurns += 1;
      existing.finalEntry = e;
      if (!e.verdict) existing.apiErrors += 1;
    }
    const acc = bySceneIndex.get(e.sceneIndex)!;
    if (e.verdict) {
      const v = e.verdict as ValidatorVerdict & {
        scoreComposition?: number | null;
        scoreLighting?: number | null;
        scorePaletteCompliance?: number | null;
        scoreFacialAccuracy?: number | null;
        scoreMotionQuality?: number | null;
        scoreNarrationAlignment?: number | null;
        scoreStyleAdherence?: number | null;
      };
      const updateBest = (
        key: keyof SceneAccum['bestScores'],
        score: number | null | undefined,
      ): void => {
        if (score === null || score === undefined) return;
        const prev = acc.bestScores[key];
        if (prev === null || score > prev) acc.bestScores[key] = score;
      };
      updateBest('composition', v.scoreComposition);
      updateBest('lighting', v.scoreLighting);
      updateBest('palette', v.scorePaletteCompliance);
      updateBest('facial', v.scoreFacialAccuracy);
      updateBest('motion', v.scoreMotionQuality);
      updateBest('narration', v.scoreNarrationAlignment);
      updateBest('style', v.scoreStyleAdherence);
    }
  }

  const sceneAccums = Array.from(bySceneIndex.values()).sort(
    (a, b) => a.sceneIndex - b.sceneIndex,
  );
  const totalScenes = sceneAccums.length;
  const finalApproved = sceneAccums.filter((s) => s.finalEntry.verdict?.verdict === 'right').length;
  const finalRejected = sceneAccums.filter((s) => s.finalEntry.verdict?.verdict === 'wrong').length;
  const multiTurnScenes = sceneAccums.filter((s) => s.totalTurns > 1).length;
  const totalElapsedMs = history.reduce((sum, h) => sum + h.durationMs, 0);
  const totalThinkingChars = history.reduce(
    (sum, h) => sum + (h.thinkingContent?.length ?? 0),
    0,
  );

  // Build markdown
  const md: string[] = [];
  md.push(`# ${VALIDATOR_NAME} — Run Report`);
  md.push('');
  md.push(`_Run:_ \`${runId}\``);
  md.push(`_Generado:_ ${new Date().toISOString()}`);
  md.push('');
  md.push('## Resumen');
  md.push('');
  md.push(`- **Scenes evaluadas:** ${totalScenes}`);
  md.push(`- **Aprobadas (verdict=right):** ${finalApproved}`);
  md.push(`- **Rechazadas (verdict=wrong):** ${finalRejected}`);
  md.push(`- **Multi-turn iterations:** ${multiTurnScenes} scenes`);
  md.push(`- **Turnos totales:** ${history.length}`);
  md.push(`- **Anti-patterns descubiertos:** ${antiPatterns.length}`);
  md.push(`- **Thinking generado:** ${(totalThinkingChars / 1000).toFixed(1)}k caracteres`);
  md.push(`- **Tiempo total VALIDATOR:** ${(totalElapsedMs / 60000).toFixed(1)} min`);
  md.push('');

  // Per-scene table
  md.push('## Resultado por scene');
  md.push('');
  md.push(
    '| Scene | Turns | Verdict | Conf | Composition | Lighting | Palette | Face | Motion | Narration | Style |',
  );
  md.push(
    '|-------|-------|---------|------|-------------|----------|---------|------|--------|-----------|-------|',
  );
  for (const s of sceneAccums) {
    const v = s.finalEntry.verdict;
    const vs = v?.verdict?.toUpperCase() ?? 'ERR';
    const cf = v?.confidence ?? 0;
    const fmt = (x: number | null): string => (x === null ? '—' : String(x));
    md.push(
      `| ${s.sceneIndex} | ${s.totalTurns} | ${vs} | ${cf} | ${fmt(s.bestScores.composition)} | ${fmt(s.bestScores.lighting)} | ${fmt(s.bestScores.palette)} | ${fmt(s.bestScores.facial)} | ${fmt(s.bestScores.motion)} | ${fmt(s.bestScores.narration)} | ${fmt(s.bestScores.style)} |`,
    );
  }
  md.push('');

  // Scenes que rechazó después de todos los retries
  const finallyRejected = sceneAccums.filter((s) => s.finalEntry.verdict?.verdict === 'wrong');
  if (finallyRejected.length > 0) {
    md.push('## ⚠️ Scenes rechazadas (después de todos los retries)');
    md.push('');
    for (const s of finallyRejected) {
      const v = s.finalEntry.verdict!;
      md.push(`### Scene ${s.sceneIndex}`);
      md.push('');
      md.push(`- **Verdict:** wrong · confidence ${v.confidence}/100`);
      md.push(`- **NextAction:** \`${v.nextAction}\``);
      if (v.issues.length > 0) {
        md.push(`- **Issues residuales:**`);
        for (const iss of v.issues) {
          const issAny = iss as ValidatorIssue & { issueConfidence?: number };
          md.push(
            `  - \`${iss.severity}/${iss.category}\` (frame ${iss.evidenceFrameIndex ?? '?'}, ${iss.evidenceRegion ?? '?'}, issueConf=${issAny.issueConfidence ?? '?'}): ${iss.description}`,
          );
        }
      }
      md.push(`- **Rationale:** ${v.rationale}`);
      md.push('');
    }
  }

  // Anti-patterns descubiertos
  if (antiPatterns.length > 0) {
    md.push('## 🚫 Anti-patterns descubiertos (para mejorar futuros runs)');
    md.push('');
    for (let i = 0; i < antiPatterns.length; i++) {
      const ap = antiPatterns[i]!;
      md.push(`${i + 1}. **[scene ${ap.sceneIndex}/${ap.category}]** ${ap.pattern}`);
    }
    md.push('');
  }

  // Recomendaciones agregadas
  md.push('## 📌 Recomendaciones para el próximo run');
  md.push('');
  if (finallyRejected.length > 0) {
    md.push(
      `- Revisar manualmente las ${finallyRejected.length} scenes rechazadas listadas arriba. Posible regeneración manual o ajuste del preset.`,
    );
  }
  if (multiTurnScenes > 0) {
    md.push(
      `- ${multiTurnScenes} scenes requirieron retry — considerá fortificar el prompt template del preset con los anti-patterns descubiertos.`,
    );
  }
  // Avg scores
  const avgScore = (
    arr: Array<number | null>,
    label: string,
  ): string | null => {
    const valid = arr.filter((x): x is number => x !== null);
    if (valid.length === 0) return null;
    const avg = valid.reduce((sum, x) => sum + x, 0) / valid.length;
    if (avg < 75) {
      return `- **${label} promedio: ${avg.toFixed(0)}/100** — bajo. Revisá el preset para que mejore esta métrica.`;
    }
    return null;
  };
  const allCompositions = sceneAccums.map((s) => s.bestScores.composition);
  const allLightings = sceneAccums.map((s) => s.bestScores.lighting);
  const allPalettes = sceneAccums.map((s) => s.bestScores.palette);
  const allMotions = sceneAccums.map((s) => s.bestScores.motion);
  const allNarrations = sceneAccums.map((s) => s.bestScores.narration);
  const allStyles = sceneAccums.map((s) => s.bestScores.style);
  for (const rec of [
    avgScore(allCompositions, 'scoreComposition'),
    avgScore(allLightings, 'scoreLighting'),
    avgScore(allPalettes, 'scorePaletteCompliance'),
    avgScore(allMotions, 'scoreMotionQuality'),
    avgScore(allNarrations, 'scoreNarrationAlignment'),
    avgScore(allStyles, 'scoreStyleAdherence'),
  ]) {
    if (rec) md.push(rec);
  }
  if (md[md.length - 1] === '## 📌 Recomendaciones para el próximo run' || md[md.length - 1] === '') {
    md.push('- Todo OK 🎯 — sin recomendaciones específicas.');
  }
  md.push('');

  // Persist
  const reportPath = resolve(VALIDATOR_STORAGE_ABS, runId, 'run-report.md');
  try {
    await mkdir(resolve(VALIDATOR_STORAGE_ABS, runId), { recursive: true });
    await writeFile(reportPath, md.join('\n'), 'utf-8');
  } catch {
    return null;
  }
  return reportPath;
}

export async function readValidatorHistory(runId: string): Promise<ValidatorHistoryEntry[]> {
  const jsonlPath = resolve(VALIDATOR_STORAGE_ABS, runId, 'history.jsonl');
  if (!existsSync(jsonlPath)) return [];
  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries: ValidatorHistoryEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ValidatorHistoryEntry);
    } catch {
      // skip line corrupta
    }
  }
  return entries;
}

// Re-exports utilitarios para que otros módulos no tengan que importar de varios sitios
export { dirname }; // útil para tests
