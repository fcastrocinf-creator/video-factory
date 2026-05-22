import { GeminiVisionClient, GeminiVisionApiError } from './gemini-vision-client.js';

export interface SceneValidationInput {
  // Texto narrado durante la escena (lo que se está diciendo).
  text: string;
  // Prompt usado para generar la imagen.
  imagePrompt: string;
  // Buffer PNG de la imagen generada.
  imageBuffer: Buffer;
  // Estilo visual base esperado (del preset). Lo usamos para validar coherencia.
  styleBase?: string;
  // Información del narrador (gender, age) — si dispuesta, se valida que el
  // personaje en pantalla coincida cuando la escena lo muestra.
  narratorProfile?: { gender?: 'male' | 'female' | 'neutral'; ageRange?: string };
}

export type ValidationVerdict = 'pass' | 'regenerate' | 'fatal';

export interface SceneValidationResult {
  verdict: ValidationVerdict;
  // Score de 0 a 100 (100 = perfecta).
  score: number;
  // Lista de issues detectados, vacía si verdict='pass'.
  issues: string[];
  // Sugerencia concreta de cómo refinar el prompt para evitar los issues.
  // Se concatena al prompt original en el siguiente intento.
  refinementHint: string | null;
  // Razonamiento breve del modelo (debug).
  reasoning: string;
}

const SYSTEM_INSTRUCTION = `Eres un revisor visual experto en ads publicitarios premium y profesor de anatomía y composición. Tu trabajo es evaluar si una imagen generada por IA cumple SEIS criterios obligatorios. Sé ESTRICTO — los videos publicitarios de marca NO toleran errores lógicos visibles.

1. COHERENCIA SEMÁNTICA
   La imagen debe mostrar visualmente lo que el texto narrado describe. Si el texto dice "anillos no entran" la imagen debe mostrar una mano con dedo hinchado y anillo a medio camino, NO un anillo solo, NO una mano sin contexto.

2. INTEGRIDAD ANATÓMICA
   - Manos: exactamente 5 dedos (1 pulgar + 4 dedos), bien separados, sin fusionarse
   - Pies: exactamente 5 dedos por pie
   - Rostros: ojos simétricos, sin ojos extra, nariz/boca/orejas proporcionadas
   - Cuerpo: brazos/piernas sin duplicados ni miembros extraños

3. PROPORCIONES CORPORALES (CRÍTICO — muchas IA fallan acá)
   Reglas básicas de proporción humana realista, incluso en estilo ilustrado:
   - La cabeza es ~1/7 a 1/8 de la altura del cuerpo entero
   - Las manos son aproximadamente del tamaño de la cara (palma + dedos ≈ frente a mentón)
   - Los pies son aproximadamente 1/7 de la altura del cuerpo — NUNCA más grandes que la cabeza
   - El brazo extendido llega aproximadamente hasta la mitad del muslo
   - Los hombros son ~2-3 veces el ancho de la cabeza
   FALLOS COMUNES a detectar:
   - "Pies/manos gigantescas" desproporcionadas al cuerpo
   - "Cabeza pequeña sobre cuerpo enorme" o viceversa
   - "Brazos demasiado cortos/largos respecto al torso"
   - "Piernas con un muslo mucho más grande que la pantorrilla"

4. PERSPECTIVA Y ESCALA RELATIVA
   - Objetos cercanos a la cámara deben verse más grandes que los lejanos
   - Si la imagen muestra una persona y un objeto (frasco, taza), la escala debe ser razonable (un frasco no debería ser del tamaño de la persona)
   - Líneas de fuga consistentes — no debe haber múltiples puntos de fuga incoherentes
   - El suelo/horizonte debe ser plano y consistente

5. ILUMINACIÓN COHERENTE
   - Una sola dirección dominante de luz (o múltiples luces explicables: ventana + lámpara)
   - Sombras consistentes con la dirección de luz — todas en el mismo lado
   - No sombras contradictorias entre objetos cercanos

6. CONSISTENCIA DE PERSONAJE
   Si el texto menciona un narrador con gender específico (ej. "doctor japonés" = hombre), la persona en pantalla cuando representa al narrador debe coincidir en gender, edad, etnia, y rasgos descritos en su CHARACTER CARD.

SCORING (0-100) — SÉ ESTRICTO:
- 95-100: Sin issues, listo para publicar
- 80-94: Defectos menores que no afectan el mensaje (color, sombra leve)
- 60-79: Issues notables pero la imagen aún transmite el mensaje principal — REGENERATE
- 30-59: Errores claros visibles (proporciones, anatomía, semántica) — REGENERATE con hint específico
- 0-29: Fallo crítico (gender erróneo, irrelevante semánticamente, anatomía grotesca) — REGENERATE o FATAL

REGLAS DE VEREDICTO:
- "pass" — score >= 80 y SIN issues críticos. La imagen es USABLE para el ad publicado.
- "regenerate" — score < 80 O tiene al menos UN issue crítico. La imagen NO es usable.
- "fatal" — La imagen es semánticamente irrelevante O viola safety (texto/marcas no autorizadas, contenido inapropiado).

REFINEMENT HINT (obligatorio cuando regenerate):
Debe ser una instrucción CONCRETA y ACCIONABLE que se concatena al prompt original. Ejemplos buenos:
- "Body proportions must be realistic: the feet should be no larger than the character's face. Redraw with anatomically correct proportions where the head is approximately 1/7 of the body height."
- "Hand must show exactly 5 separate fingers including thumb. Currently has fused/missing digits."
- "The character must be a mature Japanese man with gray temple hair, white coat — same as previous scenes. Currently appears as a woman."
- "Reframe to remove text — the calendar/label should not contain readable numbers/letters because AI generation is unreliable for fine text."

Devuelve EXCLUSIVAMENTE JSON con este shape:
{
  "verdict": "pass" | "regenerate" | "fatal",
  "score": 0-100,
  "issues": ["issue1", "issue2"],
  "refinementHint": "concrete prompt addition" | null,
  "reasoning": "1-2 frases explicando el veredicto"
}`;

export interface SceneValidatorOptions {
  client?: GeminiVisionClient;
  model?: string;
}

export class SceneValidator {
  private readonly client: GeminiVisionClient | null;
  private readonly model: string;

  constructor(opts: SceneValidatorOptions = {}) {
    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    this.client = opts.client ?? (apiKey ? new GeminiVisionClient({ apiKey }) : null);
    this.model = opts.model ?? 'gemini-2.5-pro';
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async validate(input: SceneValidationInput): Promise<SceneValidationResult> {
    if (!this.client) {
      throw new Error('SceneValidator: GOOGLE_AI_API_KEY no está configurada — no se puede validar.');
    }

    const userPrompt = `EVALÚA ESTA IMAGEN.

Texto narrado en esta escena:
"${input.text}"

Prompt usado para generar la imagen:
"${input.imagePrompt}"

${input.narratorProfile ? `Narrador del guion: gender=${input.narratorProfile.gender ?? '?'}, edad=${input.narratorProfile.ageRange ?? '?'}` : ''}
${input.styleBase ? `Estilo visual esperado: ${input.styleBase}` : ''}

Aplica los 3 criterios obligatorios. Devuelve JSON estricto.`;

    try {
      const result = await this.client.generateJson<SceneValidationResult>({
        imageBuffer: input.imageBuffer,
        mimeType: 'image/png',
        prompt: userPrompt,
        systemInstruction: SYSTEM_INSTRUCTION,
        model: this.model,
      });

      // Sanity check del shape devuelto
      if (!result.verdict || !['pass', 'regenerate', 'fatal'].includes(result.verdict)) {
        return {
          verdict: 'pass',
          score: 50,
          issues: ['validator-malformed-response'],
          refinementHint: null,
          reasoning: 'El validador devolvió un veredicto inesperado, se asume pass para no bloquear.',
        };
      }
      return {
        verdict: result.verdict,
        score: typeof result.score === 'number' ? result.score : 50,
        issues: Array.isArray(result.issues) ? result.issues : [],
        refinementHint: result.refinementHint ?? null,
        reasoning: result.reasoning ?? '',
      };
    } catch (e) {
      // En caso de error del validador, NO bloqueamos el pipeline — asumimos pass
      // con score bajo y dejamos registro.
      const message = e instanceof GeminiVisionApiError ? e.message : (e as Error).message;
      return {
        verdict: 'pass',
        score: 0,
        issues: [`validator-error: ${message}`],
        refinementHint: null,
        reasoning: 'Falla del validador, se asume pass para continuar el render.',
      };
    }
  }
}
