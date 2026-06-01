// POST /api/runs/[id]/translate-feedback
//
// El owner escribe feedback EN LENGUAJE NATURAL (sin tecnicismos):
//   "el baile no tiene sentido, sería mejor que se toque la barbilla
//    con cara de duda"
//
// Este endpoint toma ese feedback + el imagePrompt original + el verdict de
// VALIDATOR + el brand context + el texto narrado, y le pide a Claude Sonnet
// que GENERE UN NUEVO imagePrompt técnico que incorpore la corrección del owner
// manteniendo el estilo del preset.
//
// Resultado: el owner NO necesita aprender a escribir prompts. Habla normal,
// Claude lo traduce al lenguaje que el provider de imagen necesita.
//
// Body:
//   {
//     "naturalFeedback": "el baile no tiene sentido...",
//     "sceneIndex": 1,
//     "currentImagePrompt": "...",
//     "sceneText": "...",  // opcional, narración
//     "verdictRationale": "...",  // opcional, lo que dijo VALIDATOR
//     "brandContext": { ... }  // opcional
//   }
//
// Response:
//   {
//     "translatedPrompt": "<imagePrompt técnico nuevo>",
//     "preservedFromOriginal": ["paleta sepia", "estilo acuarela", ...],
//     "appliedCorrections": ["personaje tocándose la barbilla", "expresión confusión"],
//     "reasoning": "..."
//   }

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { unifiedJudge } from '@/lib/unified-judge';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RequestSchema = z.object({
  naturalFeedback: z.string().min(3).max(2000),
  sceneIndex: z.number().int().nonnegative(),
  currentImagePrompt: z.string().min(10).max(5000).optional(),
  sceneText: z.string().max(500).optional(),
  verdictRationale: z.string().max(2000).optional(),
  brandContext: z
    .object({
      brandId: z.string().optional(),
      productName: z.string().optional(),
      productDescription: z.string().optional(),
      productUsageForm: z.string().optional(),
      styleSummary: z.string().optional(),
      styleBoilerplate: z.string().optional(),
      language: z.string().optional(),
    })
    .optional(),
});

const TranslationSchema = z.object({
  translatedPrompt: z.string().min(20).max(4000),
  preservedFromOriginal: z.array(z.string()).default([]),
  appliedCorrections: z.array(z.string()).default([]),
  reasoning: z.string(),
});

const TRANSLATOR_SYSTEM_PROMPT = `Eres un traductor de feedback natural → image prompt técnico para Video Factory.

El OWNER (dueño del proyecto) te dice en LENGUAJE NATURAL qué quiere cambiar en una scene. Tu job: producir un imagePrompt nuevo, COMPLETO Y BIEN FORMADO, que:

1. INCORPORE las correcciones que el owner pidió explícitamente
2. PRESERVE el estilo, paleta, brand context, y elementos válidos del imagePrompt original
3. Esté escrito en INGLÉS técnico (los providers de imagen funcionan mejor con inglés)
4. Sea CONCISO pero específico (250-700 palabras ideal)
5. NUNCA agregue text overlays, hex codes escritos, "Expression Sheet", o anti-patterns conocidos

Tu output es SOLO JSON sin markdown fences:

{
  "translatedPrompt": "<el nuevo imagePrompt completo en inglés>",
  "preservedFromOriginal": ["paleta sepia acuarela", "estilo comic", "5 dedos visibles"],
  "appliedCorrections": ["character touching chin", "puzzled expression", "removed dancing"],
  "reasoning": "<2-3 oraciones explicando qué cambiaste y por qué>"
}

REGLAS:
- Si el owner dice "remover X" → quita X del prompt
- Si el owner dice "agregar X" → agrégalo de forma específica
- Si el owner dice "más Y" → refuerza Y con descriptores adicionales
- Si el owner dice "se ve mal porque Z" → elimina Z y propone alternativa contextual
- Si el owner usa metáforas o ejemplos ("como en X película") → traduce a descripción visual concreta
- MANTÉN las palabras-clave técnicas del prompt original: aspect ratio, NO text overlays, palette descriptors, art style
- NUNCA ignores las correcciones del owner — ellos tienen contexto que tú no

EJEMPLOS DE TRADUCCIÓN:

Owner: "el baile no tiene sentido, debería tocarse la barbilla con cara de duda"
→ Remové "dancing/baile", agregaste "character touching chin thoughtfully, puzzled expression with furrowed brow, head slightly tilted in confusion"

Owner: "se ve drogada, debería verse saludable"
→ Remové descriptores de demacración, agregaste "vibrant healthy skin, well-fed proportions, alert clear eyes, natural rosy cheeks"

Owner: "está muy realista, debería ser acuarela"
→ Remové "photorealistic", reforzaste "hand-painted watercolor style, visible brush strokes, painterly texture, organic color blending"`;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await req.json();
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body inválido: ${parsed.error.message.slice(0, 200)}` },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Body no es JSON válido' }, { status: 400 });
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY no configurada' },
      { status: 503 },
    );
  }

  // Build user message
  const userText = [
    `# Traducción de feedback natural → imagePrompt técnico`,
    ``,
    `**Scene a corregir:** #${body.sceneIndex}`,
    ``,
    body.sceneText ? `**Texto narrado en esta scene:**\n"${body.sceneText}"\n` : '',
    `**imagePrompt actual (lo que se generó y el owner quiere cambiar):**\n"${(body.currentImagePrompt ?? 'No disponible').slice(0, 2500)}"\n`,
    body.verdictRationale
      ? `**Análisis previo de VALIDATOR (para contexto):**\n"${body.verdictRationale.slice(0, 800)}"\n`
      : '',
    body.brandContext
      ? `**Brand context:**\n${[
          body.brandContext.brandId && `  - Brand: ${body.brandContext.brandId}`,
          body.brandContext.productName && `  - Producto: ${body.brandContext.productName}`,
          body.brandContext.styleSummary && `  - Estilo: ${body.brandContext.styleSummary}`,
          body.brandContext.styleBoilerplate &&
            `  - Style boilerplate: ${body.brandContext.styleBoilerplate.slice(0, 400)}`,
        ]
          .filter(Boolean)
          .join('\n')}\n`
      : '',
    `---`,
    ``,
    `## 🧑 FEEDBACK DEL OWNER (en lenguaje natural):`,
    ``,
    `"${body.naturalFeedback}"`,
    ``,
    `---`,
    ``,
    `Traduce el feedback del owner a un imagePrompt técnico nuevo. Devuelve SOLO el JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await unifiedJudge({
    apiKey,
    model: 'claude-sonnet-4-5',
    maxTokens: 3000,
    temperature: 0.2,
    timeoutMs: 60_000,
    skipProjectContext: true,
    roleSystemPrompt: TRANSLATOR_SYSTEM_PROMPT,
    userContent: userText,
    schema: TranslationSchema,
  });

  if (result.isErr()) {
    return NextResponse.json(
      {
        error: 'No se pudo traducir el feedback',
        detail: result.error.message,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(result.value);
}
