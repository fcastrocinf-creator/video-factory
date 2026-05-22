// Script suggester: dado un AdAnalysis (anuncio de referencia) + datos del
// producto del usuario, propone 3 guiones nuevos que respetan la "línea
// editorial" del original pero hablan del producto del usuario.
//
// También expone refineScript() para que el usuario pida modificaciones puntuales
// sobre una propuesta específica.

import { randomUUID } from 'node:crypto';
import { GeminiClient } from '@video-factory/block-scene-planner';
import type {
  AdAnalysis,
  BrandConfig,
  Product,
  ScriptProposal,
} from '@video-factory/contracts';
import { ScriptProposalSchema } from '@video-factory/contracts';
import { z } from 'zod';

const SUGGESTER_MODEL = 'gemini-2.5-pro';

const SUGGESTER_SYSTEM = `You are a creative copywriter for vertical short-form ads (TikTok / Reels). You read an analysis of a SUCCESSFUL competitor or reference ad, and write fresh script proposals that RHYME with its editorial mechanic — same hook type, same emotional arc, similar structure — but TALK ABOUT a different product (the user's product).

Output language: Spanish (neutral, NO regionalisms like vos, pibe, che). Tone: conversational, no medical claims, no superlatives that AI moderators flag.

RULES:
1. Each proposal must hit the SAME hookType as the reference. If reference was pain-agitation, all 3 proposals are pain-agitation. If autoridad, all 3 are autoridad.
2. The PRODUCT must be the user's, not the reference's. Use the productName + productDescription + productClaim provided.
3. Each proposal varies in ANGLE (different way to enter the same hook). Examples for pain-agitation:
   - Proposal A: focus on physical pain
   - Proposal B: focus on social/emotional pain
   - Proposal C: focus on "I tried everything" frustration
4. Length: between 40 and 90 seconds spoken (you can estimate ~3 words/second). Target durationSeconds for each.
5. Write in first person if the reference is first-person testimonio; in third person if reference is autoridad/expert; etc.
6. No medical absolutes ("cura", "elimina al 100%"). Use observational language ("ayuda a", "puedes notar", "muchas mujeres reportan").
7. fidelityNote: 1 sentence explaining what editorial element you preserved from the reference.

Return EXCLUSIVELY this JSON shape (array of 3):

{
  "proposals": [
    {
      "title": "<short descriptive title, e.g. 'Hook con dolor físico'>",
      "approach": "<2 sentence explanation of the angle>",
      "durationSeconds": <number 40-90>,
      "script": "<the actual script text, ready to be narrated. Use line breaks for natural pauses.>",
      "fidelityNote": "<1 sentence>"
    }
    // exactly 3 proposals
  ]
}`;

const ProposalsResponseSchema = z.object({
  proposals: z
    .array(
      z.object({
        title: z.string(),
        approach: z.string(),
        durationSeconds: z.number().positive(),
        script: z.string(),
        fidelityNote: z.string(),
      }),
    )
    .min(1)
    .max(5),
});

export interface SuggestScriptsOptions {
  analysis: AdAnalysis;
  brand: BrandConfig;
  // Producto específico del brand sobre el que escribir. Si null, usamos
  // el primer producto del brand.
  product?: Product;
  // Idioma destino del guion. Default 'es'.
  targetLanguage?: string;
  // Duración objetivo en segundos. Si null, el modelo elige (40-90).
  targetDurationSeconds?: number;
  // Cuántas propuestas pedir. Default 3.
  count?: number;
}

function buildSuggesterPrompt(opts: SuggestScriptsOptions): string {
  const a = opts.analysis;
  const product = opts.product ?? opts.brand.products[0];
  if (!product) {
    throw new Error('Brand sin productos. Agrega al menos uno en brand.products.');
  }
  const targetLang = opts.targetLanguage ?? 'es';
  const count = opts.count ?? 3;
  const targetDur = opts.targetDurationSeconds
    ? `Target duration per script: aproximadamente ${opts.targetDurationSeconds} segundos.`
    : 'Target duration: between 40 and 90 seconds.';

  return `# REFERENCE AD ANALYSIS

Resumen: ${a.summary}
Editorial line: ${a.editorialLine}
Hook type: ${a.hookType}
Producto del anuncio referencia: ${a.product.name ?? '(sin marca específica)'} — ${a.product.visualDescription ?? '(sin descripción)'}
Claim principal del anuncio referencia: ${a.product.mainClaim ?? '(sin claim explícito)'}
CTA del anuncio referencia: ${a.cta ?? '(sin CTA explícito)'}
Narración literal del referencia (idioma ${a.language}):
"""
${a.fullNarration.slice(0, 1500)}
"""

# USER'S PRODUCT (para escribir SOBRE este)

Marca: ${opts.brand.displayName}
Producto: ${product.name}
Descripción: ${product.description}
${product.dimensions ? `Dimensiones: ${product.dimensions}` : ''}
Brand tone — preferir: ${(opts.brand.toneRules?.prefer ?? []).join(', ') || '(sin reglas)'}
Brand tone — evitar: ${(opts.brand.toneRules?.avoid ?? []).join(', ') || '(sin reglas)'}

# TASK

Escribe ${count} propuestas de guiones en ${targetLang} para el producto del usuario.
- Cada propuesta MANTIENE la línea editorial + hook-type del referencia.
- Cada propuesta varía el ÁNGULO de entrada (3 ángulos distintos).
- ${targetDur}
- NO uses claims médicos absolutos.
- NO menciones la marca del competidor.

Devuelve el JSON con el shape definido en system instruction.`;
}

/**
 * Pide N propuestas de guiones similares (default 3) basadas en un AdAnalysis.
 */
export async function suggestScripts(opts: SuggestScriptsOptions): Promise<ScriptProposal[]> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY no configurada');

  const client = new GeminiClient({ apiKey });
  const userPrompt = buildSuggesterPrompt(opts);

  const raw = await client.generateJson<unknown>({
    prompt: userPrompt,
    systemInstruction: SUGGESTER_SYSTEM,
    model: SUGGESTER_MODEL,
  });

  const parsed = ProposalsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `script-suggester: respuesta inválida del modelo. ${parsed.error.message.slice(0, 300)}`,
    );
  }

  return parsed.data.proposals.map((p): ScriptProposal => {
    const proposal = {
      id: randomUUID(),
      title: p.title,
      approach: p.approach,
      durationSeconds: p.durationSeconds,
      script: p.script,
      fidelityNote: p.fidelityNote,
    };
    // Final validation contra el schema oficial
    return ScriptProposalSchema.parse(proposal);
  });
}

export interface RefineScriptOptions {
  originalProposal: ScriptProposal;
  // El feedback del usuario en lenguaje natural. Ej "Más informal", "Acorta a 30s",
  // "Cambia el final por una pregunta", "Que sea menos agresivo".
  feedback: string;
  analysis: AdAnalysis;
  brand: BrandConfig;
  product?: Product;
  targetLanguage?: string;
}

const REFINER_SYSTEM = `You are a copywriter refining a script proposal based on user feedback. Keep the editorial line of the original ad reference; apply the user's feedback faithfully without losing the hook mechanic.

Return EXCLUSIVELY this JSON:

{
  "title": "<updated title>",
  "approach": "<short angle explanation>",
  "durationSeconds": <number 30-120>,
  "script": "<the refined script>",
  "fidelityNote": "<1 sentence: what was changed and what was preserved>"
}`;

const RefinedResponseSchema = z.object({
  title: z.string(),
  approach: z.string(),
  durationSeconds: z.number().positive(),
  script: z.string(),
  fidelityNote: z.string(),
});

/**
 * Refina una propuesta de guion con feedback del usuario. Mantiene el id original.
 */
export async function refineScript(opts: RefineScriptOptions): Promise<ScriptProposal> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY no configurada');
  const client = new GeminiClient({ apiKey });

  const product = opts.product ?? opts.brand.products[0];
  const userPrompt = `# ORIGINAL PROPOSAL

Title: ${opts.originalProposal.title}
Approach: ${opts.originalProposal.approach}
Script (${opts.originalProposal.durationSeconds}s):
"""
${opts.originalProposal.script}
"""

# REFERENCE AD ANALYSIS (mantener línea editorial)
Editorial line: ${opts.analysis.editorialLine}
Hook type: ${opts.analysis.hookType}

# USER PRODUCT
${product ? `${product.name} — ${product.description}` : '(sin producto específico)'}

# USER FEEDBACK
"${opts.feedback}"

# TASK
Refina el script aplicando el feedback del usuario. Output JSON estricto (sin la propiedad 'id', la maneja el caller).`;

  const raw = await client.generateJson<unknown>({
    prompt: userPrompt,
    systemInstruction: REFINER_SYSTEM,
    model: SUGGESTER_MODEL,
  });

  const parsed = RefinedResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refineScript: respuesta inválida del modelo. ${parsed.error.message.slice(0, 300)}`,
    );
  }

  return ScriptProposalSchema.parse({
    id: opts.originalProposal.id, // mantenemos el id para que el frontend actualice la misma card
    ...parsed.data,
  });
}
