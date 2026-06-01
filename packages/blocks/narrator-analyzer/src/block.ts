import { err, ok, type Result } from 'neverthrow';
import { BlockError, type Block, type BlockContext } from '@video-factory/core';
import {
  ParsedScriptSchema,
  type NarratorProfile,
  type ParsedScript,
} from '@video-factory/contracts';
import { GeminiClient } from '@video-factory/block-scene-planner';

const DEFAULT_MODEL = 'gemini-2.5-pro';

const SYSTEM_INSTRUCTION = `Eres un analista de guiones publicitarios. Tu trabajo es leer un guion y extraer el perfil del NARRADOR (la persona que habla en primera persona o se identifica explícitamente en el guion).

Devuelve EXCLUSIVAMENTE JSON con este shape exacto:
{
  "narratorPresent": true | false,
  "gender": "male" | "female" | "neutral",
  "ageRange": "20-30" | "30-40" | "40-55" | "55-70" | etc,
  "characterCard": "<35-60 palabras describiendo VISUALMENTE al narrador para que un ilustrador lo dibuje siempre igual: edad aproximada, género, etnia/origen, peinado y color de pelo, vestimenta característica, ambiente típico donde aparece, expresión/actitud. SI narratorPresent=false, devuelve string vacío.>"
}

REGLAS:
- narratorPresent=true SOLO si el guion identifica explícitamente al hablante ("Soy el Dr. X", "Mi nombre es Y", "Como experta en Z", o referencias de género claras como "yo, como mujer/hombre de X").
- narratorPresent=false si es voiceover impersonal sin gender claro.
- gender DEBE inferirse de pistas: nombre propio ("Hiroshi"→male, "María"→female), título ("doctor"→ambiguo pero culturalmente más male en LATAM, "doctora"→female), pronombres ("yo como mujer..."), profesión específica.
- characterCard es la pieza clave: debe ser visualmente describible. Ej: "Mature Japanese man around 55, shaved head with white sideburns, wearing traditional ochre robes, calm and authoritative expression, in a serene Kyoto temple garden with bonsai trees and rice paper screens".`;

export interface NarratorAnalyzerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Bloque que infiere NarratorProfile desde un ParsedScript usando Gemini 2.5 Pro.
 *
 * Devuelve un ParsedScript ENRIQUECIDO con `narratorProfile` poblado. Si la
 * llamada a Gemini falla, devuelve el ParsedScript con un narratorProfile
 * neutro (narratorPresent=false) en lugar de bloquear el pipeline — la voz
 * default de la marca se usa en ese caso.
 *
 * Corre RIGHT AFTER script-processor para que TTS y scene-planner puedan
 * leer el narratorProfile sin re-analizar.
 */
export class NarratorAnalyzerBlock implements Block<ParsedScript, ParsedScript> {
  readonly name = 'narrator-analyzer';
  readonly version = '1.0.0';
  readonly description =
    'Analiza el guion con Gemini 2.5 Pro para inferir el perfil del narrador (gender, edad, character card visual). Enriquece el ParsedScript con narratorProfile.';

  constructor(private readonly options: NarratorAnalyzerOptions = {}) {}

  validateInput(input: unknown): Result<ParsedScript, Error> {
    const parsed = ParsedScriptSchema.safeParse(input);
    if (!parsed.success) {
      return err(new Error(`ParsedScript inválido: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  }

  async run(input: ParsedScript, ctx: BlockContext): Promise<Result<ParsedScript, BlockError>> {
    // Si ya viene con narratorProfile (porque la UI/llamador lo seteó como override),
    // no re-analizamos — respetamos el override.
    if (input.narratorProfile && input.narratorProfile.narratorPresent !== undefined) {
      ctx.logger.info(
        { runId: ctx.runId, block: this.name, source: 'already-set' },
        'narrator-analyzer:skipped',
      );
      return ok(input);
    }

    const apiKey = this.options.apiKey ?? process.env['GOOGLE_AI_API_KEY'];
    if (!apiKey) {
      ctx.logger.warn(
        { runId: ctx.runId, block: this.name },
        'narrator-analyzer:no_api_key_returning_neutral',
      );
      return ok({
        ...input,
        narratorProfile: {
          narratorPresent: false,
          gender: 'neutral',
          ageRange: '40-55',
          characterCard: '',
        },
      });
    }

    const rawScript = input.segments.map((s) => s.text).join('\n');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const model = this.options.model ?? DEFAULT_MODEL;
    // GeminiClient ahora maneja automáticamente el fallback a Vertex AI cuando
    // AI Studio devuelve "prepayment depleted" (si GCP_PROJECT_ID está seteado).
    const client = new GeminiClient({ apiKey, fetchImpl });

    try {
      const parsed = await client.generateJson<{
        narratorPresent: boolean;
        gender: 'male' | 'female' | 'neutral';
        ageRange: string;
        characterCard: string;
      }>({
        prompt: `GUION A ANALIZAR:\n${rawScript}\n\nExtrae el NarratorProfile en JSON estricto.`,
        systemInstruction: SYSTEM_INSTRUCTION,
        model,
      });

      const narratorProfile: NarratorProfile = {
        narratorPresent: Boolean(parsed.narratorPresent),
        gender: ['male', 'female', 'neutral'].includes(parsed.gender) ? parsed.gender : 'neutral',
        ageRange: typeof parsed.ageRange === 'string' && parsed.ageRange.length > 0 ? parsed.ageRange : '40-55',
        characterCard: typeof parsed.characterCard === 'string' ? parsed.characterCard : '',
      };

      ctx.logger.info(
        { runId: ctx.runId, block: this.name, narratorProfile },
        'narrator-analyzer:analyzed',
      );

      return ok({ ...input, narratorProfile });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.logger.warn(
        { runId: ctx.runId, block: this.name, err: message },
        'narrator-analyzer:failed_returning_neutral',
      );
      return ok({
        ...input,
        narratorProfile: {
          narratorPresent: false,
          gender: 'neutral',
          ageRange: '40-55',
          characterCard: '',
        },
      });
    }
  }
}

export const narratorAnalyzer = new NarratorAnalyzerBlock();
