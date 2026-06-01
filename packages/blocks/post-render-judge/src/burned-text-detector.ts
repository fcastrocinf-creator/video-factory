// burned-text-detector.ts — detector de "burned-in text glitchy" en imágenes
// generadas por IA.
//
// Problema cubierto: gpt-image-1, Imagen, Flux y demás image generators a
// menudo insertan TEXTO en la imagen aunque les pidas explícitamente que no
// lo hagan. El texto sale típicamente:
//   - Gibberish / palabras inventadas ("DDCDBA", "TRINES KREATO 88888")
//   - Números incorrectos ("9/16" — aspect ratio leak)
//   - Frases en idioma incorrecto (inglés cuando ad es en español)
//   - Carteles/banderas con texto ilegible
//
// La estrategia del scene-planner es renderear texto vectorial perfecto en
// post-producción y pedir explícitamente al image gen "NO text". Cuando el
// modelo IGNORA esa instrucción, el resultado se ve poco profesional.
//
// Este detector usa Claude Vision para identificar el problema. Devuelve
// score + texto detectado + severity. El caller (judge-final.ts) emite issue
// con suggestion="regenerate-scene with reinforced no-text prompt" → M6
// editor-loop lo ejecuta automáticamente.

import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';
import { judgeWithClaude, buildImageMessageContent } from '@video-factory/core';

export const BurnedTextDetectionSchema = z.object({
  hasBurnedInText: z.boolean(),
  severity: z.enum(['none', 'low', 'medium', 'high']),
  detectedTextSamples: z.array(z.string()).max(10),
  isGlitchy: z.boolean(),
  isWrongLanguage: z.boolean(),
  reasoning: z.string().min(10).max(500),
  confidence: z.number().min(0).max(100),
});
export type BurnedTextDetection = z.infer<typeof BurnedTextDetectionSchema>;

const SYSTEM_PROMPT = `Eres un editor de video QA especializado en detectar artefactos de generación con IA.

Tu tarea: mirar UNA imagen y decidir si tiene TEXTO BURNED-IN (texto incrustado dentro de la imagen como pixeles, NO como overlay separado). Te interesan ESPECIALMENTE artefactos típicos de image generators (gpt-image-1, Imagen, Flux):

CONSIDERAR PROBLEMÁTICO:
- Texto gibberish o sin sentido ("DDCDBA", "TRINES KREATO 88888", "ZQQQ#R")
- Números aleatorios o incorrectos en pantalla ("9/16", "##123")
- Carteles, banners, etiquetas con texto ilegible o glitchy
- Texto en inglés cuando el ad es claramente en español (o cualquier mismatch de idioma)
- Texto duplicado o repetido
- Letras deformadas, fuera de la línea, espaciado raro

NO CONSIDERAR PROBLEMÁTICO:
- Texto claramente intencional y bien renderizado que aporta información (nombre de producto, claim claro)
- Carteles legibles que forman parte de la composición narrativa
- Diagramas anatómicos con labels coherentes
- Si NO hay texto: no es problemático

Devuelve EXCLUSIVAMENTE JSON sin markdown:

{
  "hasBurnedInText": boolean,
  "severity": "none" | "low" | "medium" | "high",
  "detectedTextSamples": ["texto1", "texto2"] (literal de lo que ves, max 10 fragmentos),
  "isGlitchy": boolean (true si el texto es gibberish/sin sentido/deformado),
  "isWrongLanguage": boolean (true si está en otro idioma que el esperado),
  "reasoning": "1-3 oraciones explicando por qué es o no problemático",
  "confidence": 0-100
}

CRITERIOS DE SEVERITY:
- "none" → no hay texto burned-in problemático
- "low" → texto pequeño, semi-oculto, no afecta lectura del ad
- "medium" → texto visible que distrae pero no rompe completamente
- "high" → texto prominente, glitchy o en idioma incorrecto, INACEPTABLE para entregar al cliente`;

export interface DetectBurnedTextOptions {
  imageBuffer: Buffer;
  imageMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Idioma esperado del ad (para detectar wrong-language). Default 'es' */
  expectedLanguage?: string;
  /** Model Claude. Default haiku 4.5 (más barato/rápido). */
  model?: string;
  apiKey?: string;
}

/**
 * Detecta burned-in text glitchy en una imagen generada por IA.
 *
 * Costo: ~$0.002 por imagen con Haiku 4.5.
 * Latencia: ~2-4s.
 */
export async function detectBurnedInText(
  opts: DetectBurnedTextOptions,
): Promise<Result<BurnedTextDetection, { type: string; message: string; detail?: string }>> {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const model = opts.model ?? 'claude-haiku-4-5';
  const lang = opts.expectedLanguage ?? 'es';

  const userMsg = `Idioma esperado del ad: ${lang}. Analiza la imagen y devuelve el JSON.`;
  const content = buildImageMessageContent(
    opts.imageBuffer,
    userMsg,
    opts.imageMimeType ?? 'image/png',
  );

  const result = await judgeWithClaude({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    userContent: content,
    schema: BurnedTextDetectionSchema,
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 30_000,
  });
  if (result.isErr()) {
    return err({
      type: result.error.type,
      message: result.error.message,
      detail: result.error.detail,
    });
  }
  return ok(result.value);
}
