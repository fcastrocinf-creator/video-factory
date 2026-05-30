// POST /api/runs/[id]/suggest-feedback
//
// PRE-PROMPT ASSISTANT — v3.2 (29-may-2026)
//
// El owner escribe una observación CORTA y poco técnica:
//   "parece embarazada, debería ser hinchada"
//   "se ve muy joven, necesito que sea mayor"
//   "el fondo no tiene relación con lo que se dice"
//
// Este endpoint expande esa observación a un COMENTARIO RICO en lenguaje
// natural que el siguiente paso (translate-feedback) va a entender mucho mejor.
//
// La diferencia entre pasarle al traductor "parece embarazada" vs el
// comentario expandido es enorme: el segundo incluye contraste explícito
// (qué NO queremos vs qué SÍ), descriptores anatómicos, contexto narrativo,
// y referencias visuales concretas. Eso convierte una corrección de 6 palabras
// en un prompt técnico de 400 palabras bien aterrizado.
//
// Body:
//   {
//     "shortObservation": "parece embarazada, debería ser hinchada",
//     "sceneIndex": 1,
//     "sceneText": "Te sentís hinchada todo el día...",  // opcional
//     "currentImagePrompt": "...",                       // opcional
//     "verdictRationale": "...",                         // opcional
//     "brandContext": { ... }                            // opcional
//   }
//
// Response:
//   {
//     "expandedComment": "<comentario completo listo para pegar en la caja de observación>",
//     "contrast": {
//       "wrong": ["descriptor que NO queremos #1", "descriptor que NO queremos #2"],
//       "right": ["descriptor que SÍ queremos #1", "descriptor que SÍ queremos #2"]
//     },
//     "reasoning": "<2-3 oraciones explicando la lectura del problema>"
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
  shortObservation: z.string().min(3).max(500),
  sceneIndex: z.number().int().nonnegative(),
  sceneText: z.string().max(500).optional(),
  currentImagePrompt: z.string().max(5000).optional(),
  verdictRationale: z.string().max(2000).optional(),
  brandContext: z
    .object({
      brandId: z.string().optional(),
      productName: z.string().optional(),
      productDescription: z.string().optional(),
      styleSummary: z.string().optional(),
      language: z.string().optional(),
    })
    .optional(),
});

const ExpansionSchema = z.object({
  expandedComment: z.string().min(40).max(3000),
  contrast: z.object({
    wrong: z.array(z.string()).default([]),
    right: z.array(z.string()).default([]),
  }),
  reasoning: z.string(),
});

// Sistema prompt en español NEUTRO (forma tú). Aplica las reglas del producto
// del usuario: marcas D2C con audiencias hispanohablantes multi-mercado.
const PRE_PROMPT_SYSTEM_PROMPT = `Eres un asistente de PRE-PROMPT para Video Factory.

El OWNER (dueño del proyecto) te da una OBSERVACIÓN CORTA sobre lo que está mal en una scene generada. Tu trabajo es EXPANDIR esa observación a un COMENTARIO COMPLETO en lenguaje natural que después otro modelo (traductor) va a convertir a un imagePrompt técnico en inglés.

REGLAS DE EXPANSIÓN:

1. INTERPRETACIÓN LITERAL DEL SCRIPT:
   El owner siempre quiere que el visual respete LITERALMENTE lo que dice la narración, no metáforas. Si el script dice "hinchada", el visual debe mostrar hinchazón corporal real, no embarazo. Si dice "cansada", debe mostrar cansancio físico, no aburrimiento. Cuando expandas la observación, ANCLA tu lectura al sceneText narrado cuando esté disponible.

2. CONTRASTE EXPLÍCITO:
   Estructura tu comentario con un patrón "NO queremos X (porque sería ambiguo/equivocado), SÍ queremos Y (porque coincide literal con el script)". Esto le da al traductor descriptores claros para preservar/eliminar.

3. DESCRIPTORES ANATÓMICOS O VISUALES CONCRETOS:
   Reemplaza adjetivos vagos por descriptores específicos. "Se ve mal" no sirve. "Vientre algo distendido pero no redondo de embarazo, anillos apretados en los dedos, cara con leve hinchazón, expresión de cansancio" sí sirve. Si la observación menciona edad, traduce a rasgos: arrugas de expresión, canas, ropa, contexto. Si menciona estado de ánimo, traduce a gestos: postura, expresión facial específica, mirada.

4. PRESERVA ESTILO:
   Si el imagePrompt original tiene un estilo válido (acuarela, sepia, brush strokes, comic), el comentario expandido debe pedir explícitamente PRESERVARLO. Nunca propongas cambiar el estilo a menos que la observación lo pida.

5. TONO:
   El comentario debe sonar como si lo hubiera escrito el propio owner: español neutro (forma "tú"), directo, conversacional, sin tecnicismos del provider (nada de "watercolor brush strokes", "subject centered", "shallow depth of field" — eso se lo deja al traductor de inglés técnico).

6. CIERRE CON DIRECTIVA LITERAL:
   El comentario debe terminar con una línea del tipo "Interpretar el script literalmente: si dice X, mostrar X, no Y, no metáfora." Esto refuerza la regla #1 cada vez.

7. NO INCLUYAS:
   - Hex codes, valores numéricos arbitrarios
   - Términos técnicos de generadores ("seed", "aspect ratio", "negative prompt")
   - Texto en inglés (el traductor de la siguiente etapa lo va a traducir)

Tu output es SOLO JSON sin markdown fences:

{
  "expandedComment": "<comentario completo, 80-300 palabras, español neutro>",
  "contrast": {
    "wrong": ["descriptor visual que NO queremos #1", "descriptor visual que NO queremos #2", ...],
    "right": ["descriptor visual que SÍ queremos #1", "descriptor visual que SÍ queremos #2", ...]
  },
  "reasoning": "<2-3 oraciones explicando cómo leíste la observación del owner y por qué expandiste así>"
}

EJEMPLOS DE EXPANSIÓN:

Owner: "parece embarazada, debería ser hinchada"
ScriptText: "Te sientes hinchada todo el día y no entiendes por qué"
→ expandedComment: "La persona se ve embarazada, pero el script habla de hinchazón por retención de líquidos, no de embarazo. Necesito que se vea inflamada por retención: vientre algo distendido pero no redondo ni esférico como un embarazo, anillos apretados en los dedos, cara con leve hinchazón y ojeras, expresión de cansancio y malestar, ropa ajustada que se nota tirante en cintura y muñecas. Mantén el estilo acuarela sepia del preset. Interpretar el script literalmente: si dice hinchada, mostrar inflamación corporal real por retención de líquidos, no embarazo, no metáfora."
contrast.wrong: ["vientre redondo esférico de embarazo", "postura típica de mujer embarazada con mano en lumbar", "glow facial maternal"]
contrast.right: ["vientre algo distendido por retención de líquidos", "anillos apretados en dedos hinchados", "ojeras y cara levemente inflamada", "expresión de malestar y cansancio"]

Owner: "se ve muy joven, necesito que sea mayor"
ScriptText: "Como experta en bienestar, te puedo decir..."
→ expandedComment: "La persona se ve demasiado joven, parece tener 20-25 años. Necesito que se vea con autoridad de experiencia: alrededor de 45-55 años, con arrugas de expresión visibles en frente y comisuras, algunas canas naturales en el cabello, vestimenta profesional sutil que sugiera trayectoria, mirada directa y serena. No la quiero maquillada como una persona joven con efecto envejecedor — debe verse genuinamente madura. Mantén el estilo del preset. Interpretar el script literalmente: si habla de experiencia/expertise, mostrar una persona que claramente tiene esa edad y trayectoria, no una joven disfrazada de mayor."
contrast.wrong: ["rostro sin arrugas", "piel tersa joven", "cabello sin canas", "vestimenta juvenil"]
contrast.right: ["líneas de expresión en frente y ojos", "canas naturales mezcladas en el pelo", "vestimenta profesional madura", "mirada serena y experimentada"]
`;

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
    `# Expansión de pre-prompt`,
    ``,
    `**Scene:** #${body.sceneIndex}`,
    body.sceneText ? `**Texto narrado en esta scene:**\n"${body.sceneText}"\n` : '',
    body.currentImagePrompt
      ? `**imagePrompt actual (resumen):**\n"${body.currentImagePrompt.slice(0, 1500)}${body.currentImagePrompt.length > 1500 ? '…' : ''}"\n`
      : '',
    body.verdictRationale
      ? `**Análisis de VALIDATOR:**\n"${body.verdictRationale.slice(0, 600)}"\n`
      : '',
    body.brandContext
      ? `**Brand context:**\n${[
          body.brandContext.brandId && `  - Brand: ${body.brandContext.brandId}`,
          body.brandContext.productName && `  - Producto: ${body.brandContext.productName}`,
          body.brandContext.styleSummary && `  - Estilo: ${body.brandContext.styleSummary}`,
        ]
          .filter(Boolean)
          .join('\n')}\n`
      : '',
    `---`,
    ``,
    `## 🧑 OBSERVACIÓN CORTA DEL OWNER:`,
    ``,
    `"${body.shortObservation}"`,
    ``,
    `---`,
    ``,
    `Expande la observación a un comentario completo en español neutro, con contraste visual y anclaje literal al script. Devuelve SOLO el JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await unifiedJudge({
    apiKey,
    model: 'claude-sonnet-4-5',
    maxTokens: 2500,
    temperature: 0.3,
    timeoutMs: 60_000,
    skipProjectContext: true,
    roleSystemPrompt: PRE_PROMPT_SYSTEM_PROMPT,
    userContent: userText,
    schema: ExpansionSchema,
  });

  if (result.isErr()) {
    return NextResponse.json(
      {
        error: 'No se pudo expandir la observación',
        detail: result.error.message,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(result.value);
}
