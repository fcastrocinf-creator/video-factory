import { GeminiVisionApiError } from './gemini-vision-client.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface SequenceSceneInput {
  index: number;
  text: string;
  imagePrompt: string;
  imageBuffer: Buffer;
}

export interface SequenceValidationOptions {
  scenes: SequenceSceneInput[];
  narratorProfile?: { gender?: 'male' | 'female' | 'neutral'; ageRange?: string; characterCard?: string };
  styleBase?: string;
}

export interface PerSceneSequenceIssue {
  sceneIndex: number;
  issue: string;
  refinementHint: string;
}

export interface SequenceValidationResult {
  // Score global de cohesión de la secuencia (0-100).
  overallScore: number;
  // Comentario textual sobre la secuencia en su conjunto.
  overallReasoning: string;
  // Escenas que deberían re-generarse por incoherencias con el resto de la
  // secuencia (ej. personaje cambió, salto visual brusco, etc.).
  scenesToRegenerate: PerSceneSequenceIssue[];
}

const SEQUENCE_SYSTEM_INSTRUCTION = `Eres el director creativo final de un ad publicitario premium. Acabas de recibir TODOS los frames clave de un video ilustrado en orden cronológico. Tu trabajo es revisar la SECUENCIA COMPLETA como un todo y detectar problemas que no son visibles cuando se mira una escena aislada.

CRITERIOS A EVALUAR:

1. CONTINUIDAD DE PERSONAJES
   Si un mismo personaje (narrador, paciente, etc.) aparece en múltiples escenas, debe verse idéntico: mismo género, edad, etnia, peinado, vestimenta. Si la mujer de escena 0 tiene pelo castaño con canas y la mujer de escena 25 tiene pelo rubio liso, eso es FAIL.

2. CONTINUIDAD DE PALETA Y ESTILO
   El estilo visual debe mantenerse coherente. Si la escena 0 es acuarela cálida sepia y la escena 12 es estilo cómic con tinta negra fuerte, hay ruptura de estilo.

3. FLUJO NARRATIVO LÓGICO
   Las escenas deben fluir narrativamente. Saltos abruptos (ej. mostrar producto antes de presentar el problema) o escenas redundantes (3 close-ups consecutivos de la misma cara) son problemáticos.

4. PROPORCIONES Y ANATOMÍA (revisión adicional a la per-escena)
   En el contexto de la secuencia, ¿alguna escena tiene proporciones especialmente fuera de lugar comparada con las demás?

5. ESCALA Y AMBIENTACIÓN
   Si el video establece un ambiente (ej. consultorio en Kyoto) y de pronto una escena está en otro contexto (ej. cocina mexicana), eso rompe la suspensión de la incredulidad.

6. TRANSICIONES VISUALES
   Pares de escenas adyacentes deberían tener algo en común visualmente (color, tema, encuadre) para crear flujo, o estar diseñadas como contraste deliberado. Cortes bruscos sin propósito narrativo son malos.

REGLA DE INVENTARIO:
Sólo flaggea para regenerar las escenas con problemas REALES y específicos. NO flaggees por preferencia estilística. Sé estricto pero justificá cada flag.

Devuelve EXCLUSIVAMENTE JSON con este shape:
{
  "overallScore": 0-100,
  "overallReasoning": "1-3 frases sobre cómo se ve la secuencia completa",
  "scenesToRegenerate": [
    {
      "sceneIndex": 5,
      "issue": "character_continuity_break",
      "refinementHint": "Concrete instruction to add to the original prompt to fix the issue"
    }
  ]
}
Si la secuencia está bien, devuelve scenesToRegenerate: [].`;

export interface SequenceValidatorOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
}

/**
 * Reduce el tamaño de un buffer PNG para que la llamada multimodal de Gemini
 * acepte 27+ imágenes sin reventar el límite de tokens/tamaño. Tomamos el PNG
 * tal cual (Imagen ya devuelve 1024x1820 aprox, que ya es bastante eficiente).
 * Si en el futuro necesitamos reducir más, agregar aquí un resize via sharp.
 */
function prepareImagePart(buffer: Buffer): { inlineData: { mimeType: string; data: string } } {
  return {
    inlineData: {
      mimeType: 'image/png',
      data: buffer.toString('base64'),
    },
  };
}

export class SceneSequenceValidator {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SequenceValidatorOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['GOOGLE_AI_API_KEY'] ?? null;
    this.baseUrl = GEMINI_BASE_URL;
    this.model = opts.model ?? 'gemini-2.5-pro';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  async review(opts: SequenceValidationOptions): Promise<SequenceValidationResult> {
    if (!this.apiKey) {
      throw new Error('SceneSequenceValidator: GOOGLE_AI_API_KEY no está configurada.');
    }

    // Construimos un prompt único con todas las imágenes intercaladas con metadatos.
    const parts: Array<Record<string, unknown>> = [];

    parts.push({
      text:
        `REVISIÓN DE SECUENCIA COMPLETA — ${opts.scenes.length} escenas en orden cronológico.\n` +
        (opts.narratorProfile
          ? `\nNARRADOR ESPERADO (debe verse igual en cada escena que lo muestre):\n` +
            `- gender: ${opts.narratorProfile.gender ?? '?'}\n` +
            `- ageRange: ${opts.narratorProfile.ageRange ?? '?'}\n` +
            `- characterCard: "${opts.narratorProfile.characterCard ?? ''}"\n`
          : '') +
        (opts.styleBase ? `\nESTILO BASE ESPERADO:\n${opts.styleBase}\n` : '') +
        `\nA continuación te paso las ${opts.scenes.length} escenas en orden:\n`,
    });

    for (const scene of opts.scenes) {
      parts.push({ text: `\n--- ESCENA ${scene.index} ---\nTexto narrado: "${scene.text}"\n` });
      parts.push(prepareImagePart(scene.imageBuffer));
    }

    parts.push({
      text:
        `\nDevuelve la revisión completa de la secuencia en JSON estricto siguiendo el shape indicado. ` +
        `Sólo marca para regenerar las escenas que TENGAN issues reales y resolvibles via prompt refinement. ` +
        `Si la secuencia se ve bien en conjunto, devuelve scenesToRegenerate: [].`,
    });

    const body = {
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' },
      systemInstruction: { parts: [{ text: SEQUENCE_SYSTEM_INSTRUCTION }] },
    };

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new GeminiVisionApiError(
        `Sequence validator Gemini ${resp.status}: ${errBody.slice(0, 500)}`,
        resp.status,
        errBody,
      );
    }

    const data = (await resp.json()) as GeminiResponseBody;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new GeminiVisionApiError(
        `Sequence validator sin candidates[0].content.parts[0].text (finishReason=${data.candidates?.[0]?.finishReason ?? '?'})`,
        200,
        JSON.stringify(data).slice(0, 500),
      );
    }

    try {
      const parsed = JSON.parse(text) as SequenceValidationResult;
      return {
        overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 50,
        overallReasoning: parsed.overallReasoning ?? '',
        scenesToRegenerate: Array.isArray(parsed.scenesToRegenerate)
          ? parsed.scenesToRegenerate
              .filter((s) => typeof s.sceneIndex === 'number' && s.refinementHint)
              .map((s) => ({
                sceneIndex: s.sceneIndex,
                issue: s.issue ?? 'unspecified',
                refinementHint: s.refinementHint,
              }))
          : [],
      };
    } catch {
      throw new GeminiVisionApiError(`Sequence validator devolvió no-JSON: ${text.slice(0, 200)}`, 200, text);
    }
  }
}
