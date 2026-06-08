// Ad ripper: replica un anuncio analizado adaptado al producto del usuario.
//
// Toma un AdAnalysis + brand/preset elegidos + producto del usuario, y:
//   1. Adapta el script (traduce + reemplaza producto + ajusta tono cultural)
//   2. Inserta el run en DB
//   3. Dispara runPipeline (mismo pipeline que /api/generate)
//
// Lo que el usuario obtiene es un video con la MISMA estructura narrativa
// del original pero ahora hablando de su producto.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { GeminiClient } from '@video-factory/block-scene-planner';
import type { AdAnalysis, BrandConfig } from '@video-factory/contracts';
import { z } from 'zod';
import { db, runs } from './db';
import { workDirFor } from './paths';
import { runPipeline } from './pipeline';

const RIPPER_MODEL = 'gemini-2.5-pro';

const RIPPER_SYSTEM = `You are a copywriter adapting a successful reference ad to a different product. You receive:
- A literal transcript of the reference ad's narration.
- Target language (where to translate to).
- Replacement product info (name, description, claim).

Your job: rewrite the narration in the target language, keeping the EXACT same structure, beats, hooks, rhythm, and emotional flow — but TALK ABOUT the replacement product instead of the original.

RULES:
1. Same NUMBER of beats/sentences as the original.
2. Same emotional arc (hook → problem → mechanism → solution → CTA).
3. Translate idioms culturally (don't literal-translate).
4. Replace the product name/claim with the user's product.
5. NO medical absolutes ("cura", "elimina al 100%"). Use observational ("ayuda a", "muchas personas notan").
6. Tone: natural conversational, NO regionalisms unless the source had them.

Return EXCLUSIVELY this JSON:

{
  "adaptedScript": "<full narration in target language, ready to be narrated, NO additional commentary>",
  "estimatedDurationSeconds": <number>,
  "notes": "<1-2 sentence note about what you adapted vs preserved>"
}`;

const RippedScriptSchema = z.object({
  adaptedScript: z.string().min(20),
  estimatedDurationSeconds: z.number().positive(),
  notes: z.string(),
});

export interface RipAdOptions {
  analysis: AdAnalysis;
  brand: BrandConfig;
  presetId: string;
  productId: string | null;
  targetLanguage?: string;
  /**
   * Si está, activa el flujo de "Ripeo fiel" en runPipeline: por cada escena
   * generada, hace un loop iterativo comparando contra keyframes del video
   * original hasta lograr ≥95% similitud (o agotar intentos). Más lento + caro
   * pero mucho más fiel al estilo del original. Si null/undefined → flujo rápido
   * normal con image-gen-multi (default histórico).
   */
  referenceVideoPath?: string | null;
  /**
   * Si está, USA este guion EXACTO sin adaptarlo/traducirlo con Gemini (el owner
   * quiere fidelidad literal al texto). Si null/undefined → adaptación normal.
   */
  literalScript?: string | null;
  /**
   * Fuerza el género de la voz del narrador ('male'|'female'). Si null/undefined,
   * se infiere del análisis del original.
   */
  narratorGenderOverride?: 'male' | 'female' | null;
}

export interface RipAdResult {
  runId: string;
  adaptedScript: string;
  notes: string;
  estimatedDurationSeconds: number;
}

/**
 * Ejecuta el ripeo end-to-end:
 *   1. Adapta el script con Gemini (translation + product swap)
 *   2. Inserta nuevo run en DB
 *   3. Dispara runPipeline en background (no espera)
 *   4. Devuelve runId para que el frontend lo siga
 */
export async function ripAd(opts: RipAdOptions): Promise<RipAdResult> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY no configurada');

  const product = opts.productId
    ? opts.brand.products.find((p) => p.id === opts.productId)
    : opts.brand.products[0];
  if (!product) {
    throw new Error(
      `Producto ${opts.productId ?? '(default)'} no encontrado en brand ${opts.brand.id}`,
    );
  }

  // 1. Obtener el guion. Si el owner pasó un guion LITERAL, lo usamos EXACTO (sin
  //    adaptar/traducir con Gemini). Si no, adaptamos el original (traduce + cambia
  //    el producto + ajusta tono cultural).
  let adaptedScript: string;
  let estimatedDurationSeconds: number;
  let notes: string;

  if (opts.literalScript && opts.literalScript.trim()) {
    adaptedScript = opts.literalScript.trim();
    // Estimación simple: ~2.6 palabras/seg en un VSL en español.
    const words = adaptedScript.split(/\s+/).filter(Boolean).length;
    estimatedDurationSeconds = Math.max(1, Math.round(words / 2.6));
    notes = 'Guion literal del owner (sin adaptación de Gemini).';
  } else {
    const targetLang = opts.targetLanguage ?? opts.brand.language.split('-')[0] ?? 'es';
    const client = new GeminiClient({ apiKey });
    const userPrompt = `# REFERENCE NARRATION (original language: ${opts.analysis.language})

"""
${opts.analysis.fullNarration}
"""

# REFERENCE PRODUCT (replace this in the new script)
Name: ${opts.analysis.product.name ?? '(no name)'}
Visual: ${opts.analysis.product.visualDescription ?? '(no description)'}
Claim: ${opts.analysis.product.mainClaim ?? '(no claim)'}

# REPLACEMENT PRODUCT (talk about this instead)
Brand: ${opts.brand.displayName}
Name: ${product.name}
Description: ${product.description}
${product.dimensions ? `Dimensions: ${product.dimensions}` : ''}

# TARGET LANGUAGE: ${targetLang} (neutral, no regional slang)

# EDITORIAL LINE (preserve)
${opts.analysis.editorialLine}

# TASK
Rewrite the narration in ${targetLang}, replacing the reference product with the user's product. Keep the same structure, beats, hook, and emotional arc.`;

    const raw = await client.generateJson<unknown>({
      prompt: userPrompt,
      systemInstruction: RIPPER_SYSTEM,
      model: RIPPER_MODEL,
    });
    const parsed = RippedScriptSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`ad-ripper: respuesta inválida. ${parsed.error.message.slice(0, 300)}`);
    }
    adaptedScript = parsed.data.adaptedScript;
    estimatedDurationSeconds = parsed.data.estimatedDurationSeconds;
    notes = parsed.data.notes;
  }

  // 2. Insertar nuevo run en DB
  const runId = randomUUID();
  const workDir = workDirFor(runId);
  await db.insert(runs).values({
    id: runId,
    brandId: opts.brand.id,
    presetId: opts.presetId,
    productId: opts.productId ?? null,
    scriptRaw: adaptedScript,
    status: 'pending',
    workDir,
    progress: 0,
  });

  // Preservamos la fidelidad: si el análisis detectó un narrador con género claro
  // (no "neutral"), forzamos ese mismo género en la voz del ripeo para que la
  // sensación auditiva del original se mantenga. Si era neutral o no detectado,
  // dejamos al inferidor del pipeline elegir.
  const inferredGender = opts.analysis.narratorProfile?.gender ?? null;
  const narratorGenderOverride =
    opts.narratorGenderOverride ??
    (inferredGender === 'male' || inferredGender === 'female' ? inferredGender : null);

  // 3. Dispara pipeline en background — el endpoint del ripper retorna inmediatamente
  void runPipeline(runId, opts.brand.id, opts.presetId, adaptedScript, {
    voiceOverride: null,
    narratorGenderOverride,
    referenceVideoPath: opts.referenceVideoPath ?? null,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ad-ripper] pipeline uncaught error for run', runId, err);
    void db
      .update(runs)
      .set({
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(runs.id, runId))
      .catch((dbErr) => {
        // Si hasta el update de DB falla, no podemos persistir el estado pero
        // al menos lo dejamos en logs para forense. El run quedará "running"
        // hasta que alguien lo limpie manualmente.
        // eslint-disable-next-line no-console
        console.error(
          '[ad-ripper] failed to persist failure state for run',
          runId,
          dbErr,
        );
      });
  });

  return { runId, adaptedScript, notes, estimatedDurationSeconds };
}
