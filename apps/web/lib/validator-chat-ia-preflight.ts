// ╔══════════════════════════════════════════════════════════════════════════╗
// ║              VALIDATOR CHAT IA — PRE-FLIGHT                              ║
// ║  Capa preventiva: escanea el imagePrompt ANTES de generar la imagen.     ║
// ║  Si detecta anti-patrones conocidos en el TEXTO del prompt, los elimina  ║
// ║  o fortifica el prompt con instrucciones explícitas para evitarlos.      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// MOTIVACIÓN
// ─────────────────────────────────────────────────────────────────────────────
// El VALIDATOR principal (Sonnet) actúa POST-generación: imagen + clip ya
// existen, gastaste cómputo y tiempo. Si el prompt llevaba "Expression Sheet
// production reference" o hex codes escritos, Sonnet rechaza, regenerás —
// pero ya gastaste el primer intento.
//
// Pre-flight es preventivo: Claude Haiku (~$0.0005, ~1s) lee el prompt textual
// y caza anti-patrones ANTES de mandar al provider de imagen. Devuelve una
// versión fortificada del prompt o lo aprueba tal cual.
//
// COSTO: ~10x más barato que regenerar la imagen. ROI absurdo.
//
// SE INTEGRA en image-gen-multi como un hook `onBeforeGenerate` opcional.

import { z } from 'zod';
import { unifiedJudge } from './unified-judge';
import { VALIDATOR_NAME, getUniqueAntiPatternsForRun } from './validator-chat-ia';

const PREFLIGHT_MODEL = 'claude-haiku-4-5';

// ─── Schema del veredicto pre-flight ────────────────────────────────────────

const PreflightVerdictSchema = z.object({
  ok: z.boolean(),
  detectedAntiPatterns: z.array(
    z.object({
      pattern: z.string(),
      reason: z.string(),
      severity: z
        .union([z.enum(['minor', 'major', 'critical']), z.string()])
        .transform((v): 'minor' | 'major' | 'critical' => {
          if (v === 'minor' || v === 'major' || v === 'critical') return v;
          return 'major';
        }),
    }),
  ),
  /** Prompt fortificado con cambios mínimos. Si ok=true, == prompt original. */
  fortifiedPrompt: z.string().min(1),
  /** Instrucciones específicas a agregar al negativePrompt. */
  negativeReinforcements: z.array(z.string()).default([]),
  rationale: z.string(),
});
export type PreflightVerdict = z.infer<typeof PreflightVerdictSchema>;

// ─── System prompt para Haiku ───────────────────────────────────────────────

const PREFLIGHT_SYSTEM_PROMPT = `Sos "${VALIDATOR_NAME} — Pre-flight", la capa preventiva del validator.

Tu trabajo: leer un imagePrompt que se va a mandar a un provider de imágenes (Imagen, gpt-image-1, Flux) y DETECTAR PALABRAS o frases en el TEXTO que probablemente generen errores conocidos en la imagen resultante.

NO ves la imagen — solo el TEXTO del prompt. Tu output es JSON puro sin markdown:

{
  "ok": boolean,
  "detectedAntiPatterns": [
    { "pattern": "<frase del prompt>", "reason": "<por qué es problemática>", "severity": "minor"|"major"|"critical" }
  ],
  "fortifiedPrompt": "<el prompt original, modificado mínimamente para evitar los anti-patrones>",
  "negativeReinforcements": ["<frase para agregar al negativePrompt>"],
  "rationale": "1-2 oraciones explicando tu veredicto"
}

ANTI-PATRONES A DETECTAR (devolvé los que veas, no inventés):

### A) Production / reference labels — CRITICAL
Si el prompt contiene cualquiera de: "expression sheet", "character sheet",
"concept art", "production reference", "model sheet", "turnaround", "design doc",
"reference layout", "T-pose reference" → eliminá la frase del fortifiedPrompt
y agregá a negativeReinforcements: "NO production sheets, NO character sheets,
NO concept art layouts, single pose only".

### B) Hex codes escritos como texto in-image — CRITICAL
Si el prompt menciona colores como TEXTO ("color #5DC3D2", "label with #FF6B35",
"sign reading #2C1810") → los hex codes son palette colors, no labels. Eliminá
la mención textual y dejá solo "warm sepia palette" o equivalente descriptivo.
Agregá negativeReinforcements: "NO hex codes (#XXXXXX) as readable text in the
image".

### C) Burned-in text crítico
Si el prompt pide "text that says X", "sign reading X", "label with X", "banner
saying X" PARA UN AD QUE LUEGO RENDEREA TEXTO EN POST: marcá CRITICAL y eliminá
del fortifiedPrompt, agregá "NO text overlays in the image, text is added in
post-production".

EXCEPCIÓN: si la escena es legítimamente sobre un producto con label visible
("dropper bottle with VITALY label clearly visible"), eso es OK — el packaging
del producto SÍ tiene texto. La regla aplica a texto NARRATIVO (diálogos,
títulos, CTAs).

### D) "Multiple expressions" / "various poses" / "grid of poses" — MAJOR
Si el prompt sugiere un layout multi-pose → fortificá pidiendo "single dynamic
pose, mid-action gesture, asymmetric posture". Cero "gallery of poses".

### E) Idioma incorrecto (cuando el ad es ES)
Si el prompt está en español PERO pide explicitamente "before"/"after" como
texto in-image, o "click here", o cualquier inglés textual → traducí o eliminá.

### F) Anti-pattern previo del MISMO run
Si el user te pasa "anti-patrones acumulados" (patrones que VALIDATOR rechazó en
escenas previas), VERIFICÁ que el prompt actual NO los repita. Si los repite,
fortificá agresivamente.

### G) Unhealthy character descriptors
Si el prompt usa palabras como "gaunt", "hollow-eyed", "sickly", "emaciated"
sin razón narrativa → fortificá con "healthy vibrant features, well-fed normal
proportions, glowing skin".

REGLA DE ORO:
- Si el prompt no tiene ningún anti-patrón → ok=true, fortifiedPrompt = prompt
  original tal cual, detectedAntiPatterns vacío.
- Si tiene anti-patrones MINOR → ok=true igual, pero fortifiedPrompt con micro
  ajustes y negativeReinforcements pobladas.
- Si tiene anti-patrones MAJOR o CRITICAL → ok=false, fortifiedPrompt
  significativamente reescrito.

SÉ CONCISO. No reescribas el prompt entero si solo necesita una corrección
puntual. Preservá la intención narrativa original.`;

// ─── API pública ────────────────────────────────────────────────────────────

export interface PreflightOptions {
  imagePrompt: string;
  /** Si pasás runId, leemos los anti-patrones acumulados de este run para que
   * Haiku verifique que el prompt no los repita.
   */
  runId?: string;
  /** Idioma esperado del ad (default 'es'). */
  expectedLanguage?: string;
  /** Override de model (default claude-haiku-4-5). */
  model?: string;
  apiKey?: string;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface PreflightResult {
  verdict: PreflightVerdict | null;
  error?: { type: string; message: string };
  durationMs: number;
}

/**
 * Pre-flight: corre Haiku contra el imagePrompt buscando anti-patrones
 * textuales. Devuelve un veredicto + prompt fortificado.
 *
 * Diseñado para invocarse JUSTO antes de mandar el prompt al provider de imagen.
 * Si verdict.ok = true y detectedAntiPatterns está vacío, el caller usa el
 * prompt original. Sino, usa fortifiedPrompt + agrega negativeReinforcements
 * al negativePrompt.
 *
 * Latencia esperada: 1-2s con Haiku. Costo: ~$0.0005 por scene.
 */
export async function preflightImagePrompt(
  opts: PreflightOptions,
): Promise<PreflightResult> {
  const t0 = Date.now();
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = opts.model ?? PREFLIGHT_MODEL;
  const language = opts.expectedLanguage ?? 'es';

  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    return {
      verdict: null,
      error: { type: 'no-api-key', message: 'ANTHROPIC_API_KEY no configurada' },
      durationMs: Date.now() - t0,
    };
  }

  // Cargar anti-patrones acumulados del run si nos lo pidieron
  let antiPatternsAccum: string[] = [];
  if (opts.runId) {
    antiPatternsAccum = await getUniqueAntiPatternsForRun(opts.runId).catch(() => []);
  }

  const userText = [
    `# Pre-flight evaluation`,
    ``,
    `**imagePrompt a analizar:**`,
    `"${opts.imagePrompt}"`,
    ``,
    `**idioma del ad:** ${language}`,
    ``,
    antiPatternsAccum.length > 0
      ? `**Anti-patrones rechazados en escenas previas de este run (NO los repitas):**\n${antiPatternsAccum
          .slice(-15)
          .map((p) => `  - ${p}`)
          .join('\n')}\n`
      : '',
    `Devolvé SOLO el JSON estructurado.`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await unifiedJudge({
      apiKey,
      model,
      maxTokens: 1500,
      temperature: 0,
      timeoutMs: 30_000,
      skipProjectContext: true, // pre-flight es liviano, no necesita full system context
      roleSystemPrompt: PREFLIGHT_SYSTEM_PROMPT,
      userContent: userText,
      schema: PreflightVerdictSchema,
    });
    const durationMs = Date.now() - t0;
    if (result.isErr()) {
      opts.logger?.warn(
        {
          err: result.error.message,
          type: result.error.type,
          entity: VALIDATOR_NAME,
        },
        'validator-chat-ia-preflight:api_error',
      );
      return { verdict: null, error: result.error, durationMs };
    }
    opts.logger?.info(
      {
        ok: result.value.ok,
        antiPatternsCount: result.value.detectedAntiPatterns.length,
        reinforcementsCount: result.value.negativeReinforcements.length,
        durationMs,
        entity: VALIDATOR_NAME,
      },
      'validator-chat-ia-preflight:verdict',
    );
    return { verdict: result.value, durationMs };
  } catch (e) {
    return {
      verdict: null,
      error: { type: 'api-error', message: (e as Error).message },
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Helper: aplica el pre-flight y devuelve { promptToUse, negativeToAppend } —
 * lo que el caller necesita para mandar al provider. Si el pre-flight falla,
 * devuelve el prompt original sin cambios (fail-open).
 */
export async function preflightAndApply(
  opts: PreflightOptions,
): Promise<{ promptToUse: string; negativeToAppend: string[]; verdict: PreflightVerdict | null }> {
  const result = await preflightImagePrompt(opts);
  if (!result.verdict) {
    return { promptToUse: opts.imagePrompt, negativeToAppend: [], verdict: null };
  }
  return {
    promptToUse: result.verdict.fortifiedPrompt,
    negativeToAppend: result.verdict.negativeReinforcements,
    verdict: result.verdict,
  };
}
