// video-understander.ts — M7 Pieza A
//
// "Claude entiende un video": dada la ruta a un .mp4, extrae N keyframes con
// ffmpeg y los manda a Claude multimodal. Claude responde con análisis
// estructurado del ad: estilo, hook narrativo, paleta, personaje, scenes,
// y un preset sugerido inicial para que el pipeline pueda generar uno similar.
//
// Output diseñado para alimentar M7 Pieza B (learning-loop) que itera
// conversacionalmente hasta lograr 95% similitud contra el original.
//
// Reusa frame-extractor.ts (ya existente con ffmpeg bundled).

import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { extractKeyframes, type ExtractedKeyframe } from './frame-extractor';

// (ANTHROPIC_URL / VERSION ya no se usan localmente — viven en @video-factory/core
// vía `judgeWithClaude`. Compat: si algún caller externo importaba constantes
// desde aquí, no las exportábamos así que no rompemos nada.)

// ============================================================
// Schemas
// ============================================================

export const VideoSceneAnalysisSchema = z.object({
  sourceTimeSec: z.number(),
  visualDescription: z.string().min(10).max(800),
  // Si la escena muestra un personaje, descripción breve. Claude puede devolver
  // null o "" si no hay personaje → aceptamos ambos.
  characterIfPresent: z.string().max(400).nullable().optional(),
  // Acción / momento narrativo
  narrativeBeat: z.enum([
    'hook',
    'problem',
    'mechanism',
    'demo',
    'product-reveal',
    'social-proof',
    'cta',
    'other',
  ]),
  // Composición visual (close-up, wide, split-screen, etc.)
  shotType: z.string().max(120),
  // Mood / emoción dominante
  mood: z.string().max(120),
});
export type VideoSceneAnalysis = z.infer<typeof VideoSceneAnalysisSchema>;

export const VideoUnderstandingSchema = z.object({
  // Nombre legible del estilo (ej. "Pixar 3D Sepia", "UGC selfie")
  styleId: z.string().min(3).max(80),
  styleDescription: z.string().min(20).max(800),
  // Tipo de hook narrativo predominante
  hookType: z.enum([
    'bold-claim',
    'question',
    'negative',
    'curiosity-gap',
    'pattern-interrupt',
    'story-open',
    'stat-shock',
    'other',
  ]),
  hookDescription: z.string().min(10).max(400),
  // Paleta de colores predominante (hex codes)
  palette: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(2).max(8),
  // Personaje principal si existe (no aplica a B-ROLL puro sin gente)
  character: z
    .object({
      gender: z.enum(['male', 'female', 'neutral', 'group', 'none']),
      ageRange: z.string().max(40),
      description: z.string().min(20).max(800),
      stateProgression: z.array(z.string().min(3).max(200)).optional(), // si hay arco (struggling→trying→restored). min 3 para labels cortas.
    })
    .nullable(),
  // Producto: cómo aparece, cómo se usa
  productPresentation: z.object({
    productVisualDescription: z.string().max(800),
    usageForm: z.string().max(200).nullable().optional(), // "sublingual", "topical", "spray", etc.
    appearsInScenes: z.array(z.number().int()).max(30),
  }),
  // Análisis scene-by-scene
  scenes: z.array(VideoSceneAnalysisSchema).min(1).max(30),
  // RUTA DE APRENDIZAJE (codificada): densidad/complejidad composicional del estilo.
  // CRÍTICO para igualar el look — un estilo denso (muchos personajes/elementos por
  // cuadro) se pierde si solo se captura medium+paleta. Se inyecta en el promptTemplate
  // para que la generación NAZCA con la densidad correcta, no minimalista.
  compositionDensity: z
    .enum(['minimalist', 'moderate', 'dense', 'very-dense'])
    .default('moderate'),
  // Componentes visuales recurrentes que DEFINEN la riqueza del estilo (ej.
  // "múltiples personajes-germen antropomórficos", "entorno interior del cuerpo con
  // vasos sanguíneos", "efectos de fuego/energía"). Se inyectan en el prompt.
  keyVisualComponents: z.array(z.string().min(2).max(160)).max(12).default([]),
  // Sugerencia de preset preliminar para que el pipeline lo use como punto de partida
  suggestedPreset: z.object({
    promptTemplate: z.string().min(50).max(3000),
    negativePrompt: z.string().min(20).max(1000),
    aspectRatio: z.literal('9:16'),
    format: z.enum([
      'b-roll-static',
      'b-roll-animated',
      'ugc-broll',
      'ugc-testimony',
      'vsl',
      'voiceover-animated',
    ]),
    estrategia: z.enum(['plano_fijo', 'multi_escena']),
    visualEngine: z.enum(['imagen4', 'veo-lite', 'veo-fast', 'veo-standard', 'higgsfield']),
    scenesPerMinute: z.number().int().min(5).max(40),
    defaultDurationSeconds: z.number().int().min(10).max(180),
  }),
  // Resumen ejecutivo (1-3 oraciones) para que un humano entienda rápido
  executiveSummary: z.string().min(20).max(1000),
});
export type VideoUnderstanding = z.infer<typeof VideoUnderstandingSchema>;

// ============================================================
// Prompt para Claude
// ============================================================

const SYSTEM_PROMPT = `Eres un director creativo + analista de publicidad digital con 15 años especializado en ads verticales 9:16 (TikTok / Reels) para marcas D2C.

Tu tarea: ANALIZAR un ad existente mirando keyframes extraídos del video. Vas a recibir N imágenes en orden cronológico (cada una con su segundo de origen). Tu output es un análisis ESTRUCTURADO que un pipeline de IA va a usar para REPRODUCIR un ad similar (mismo estilo, mismo formato, distinto producto).

REGLA DE DETECCIÓN DE ESCENAS (CRÍTICA):
Una "escena" en tu output equivale APROXIMADAMENTE a UN keyframe distinto. Tienes que devolver entre N y N+5 escenas donde N es el número de keyframes que recibes. CADA keyframe representa un momento visual distinto del ad — cuando los keyframes muestran composiciones distintas, son escenas distintas. NO agrupes 2-3 keyframes visualmente diferentes en una sola escena solo porque comparten un beat narrativo. Sub-counting es el error más común — cuando dudes, dividí en MÁS escenas.

Devuelves EXCLUSIVAMENTE JSON sin markdown fences, exactamente con este schema:

{
  "styleId": "string corto identificable, ej 'pixar-3d-sepia' o 'ugc-selfie-realista'",
  "styleDescription": "2-3 oraciones describiendo el estilo visual",
  "hookType": "bold-claim" | "question" | "negative" | "curiosity-gap" | "pattern-interrupt" | "story-open" | "stat-shock" | "other",
  "hookDescription": "qué hace el hook en los primeros 3 segundos",
  "palette": ["#aabbcc", ...] (2-8 colores hex predominantes),
  "character": null si no hay personaje protagonista, sino {
    "gender": "male"|"female"|"neutral"|"group"|"none",
    "ageRange": "ej 30-45",
    "description": "cómo se ve",
    "stateProgression": ["struggling", "trying", "restored"] (solo si hay arco)
  },
  "productPresentation": {
    "productVisualDescription": "cómo aparece el producto visualmente",
    "usageForm": "sublingual"|"oral"|"topical"|"spray"|"injection"|"other",
    "appearsInScenes": [N, M, ...] indices de scenes donde se ve el producto
  },
  "scenes": [
    { "sourceTimeSec": N.N, "visualDescription": "qué se ve", "characterIfPresent": "opcional", "narrativeBeat": "hook"|"problem"|"mechanism"|"demo"|"product-reveal"|"social-proof"|"cta"|"other", "shotType": "close-up"|"wide"|"split-screen"|...", "mood": "tense"|"hopeful"|... }
  ],
  "compositionDensity": "minimalist" | "moderate" | "dense" | "very-dense",
  "keyVisualComponents": ["elementos/personajes recurrentes que hacen RICO el estilo, ej 'multiple anthropomorphic germ characters', 'body-interior environment with blood vessels', 'fire/energy effects'"],
  "suggestedPreset": {
    "promptTemplate": "string que un image generator usará por escena — describe el estilo visual GENERAL aplicable a cualquier scene",
    "negativePrompt": "elementos a evitar",
    "aspectRatio": "9:16",
    "format": "b-roll-static"|"b-roll-animated"|"ugc-broll"|"ugc-testimony"|"vsl"|"voiceover-animated",
    "estrategia": "plano_fijo"|"multi_escena",
    "visualEngine": "imagen4"|"veo-lite"|"veo-fast"|"veo-standard"|"higgsfield",
    "scenesPerMinute": número 5-40,
    "defaultDurationSeconds": número 10-180
  },
  "executiveSummary": "1-3 oraciones: qué tipo de ad es, cuál es su fuerza"
}

CRITERIOS:
- styleId debe ser único y descriptivo (kebab-case)
- palette: extrae los colores DOMINANTES, no todos
- character: SOLO si hay UN protagonista. Si son varios actores no narrativos → null
- scenes: 1 entry POR cada keyframe que recibes, en orden
- narrativeBeat: distinguí hook (primeros 3s) vs problem vs solution
- suggestedPreset.promptTemplate: debe capturar el LOOK general, no detalles per-escena (las escenas tienen su propio prompt en scenes[].visualDescription)
- visualEngine: imagen4 si estático, veo-lite si tiene animación notable, etc.
- estrategia: multi_escena si hay >3 shots distintos; plano_fijo si es 1 shot fijo
- compositionDensity + keyVisualComponents: CRÍTICO para igualar el estilo. Mira cuántos elementos/personajes hay POR cuadro: un solo sujeto en fondo liso → "minimalist"; un personaje principal + varios personajes/elementos secundarios + entorno detallado + efectos → "dense" o "very-dense". Listá en keyVisualComponents los componentes recurrentes que hacen el estilo visualmente rico (personajes secundarios, tipo de entorno, efectos). Si el estilo es denso, el promptTemplate DEBE pedir explícitamente esa densidad (ej. "DENSE, multi-component scene with multiple ... in a rich ... environment").

Sé concreto y específico. NO inventes — básate solo en lo que ves en las imágenes.`;

// ============================================================
// Cliente Claude multimodal
// ============================================================

// M7 Pieza C v2: usamos el primitivo unificado de @video-factory/core. Antes este
// archivo tenía su propio fetch + parser JSON + safeParse duplicado; ahora pasa
// todo por `judgeWithClaude` que centraliza JSON robusto + validación Zod.
import {
  judgeWithClaude,
  buildImageMessageContent,
  type ClaudeMessageContent,
} from '@video-factory/core';

// ============================================================
// API pública
// ============================================================

export interface UnderstandVideoOptions {
  /** Path a un .mp4 (debe existir en disco) */
  videoPath: string;
  /** Directorio donde escribir los keyframes (default: <video>.keyframes/) */
  workDir?: string;
  /** Cuántos keyframes extraer. Default: inferido por duración */
  keyframeCount?: number;
  /** Modelo Claude. Default 'claude-haiku-4-5'. Para análisis profundo: 'claude-sonnet-4-6'. */
  model?: string;
  /** ANTHROPIC_API_KEY override. Default: lee de process.env */
  apiKey?: string;
}

/**
 * Entiende un video: extrae keyframes → manda a Claude multimodal →
 * devuelve análisis estructurado del ad.
 *
 * Costo: ~$0.02-0.06 por video (1 llamada Claude con 5-9 imágenes).
 * Latencia: ~10-25s (extracción ffmpeg + 1 llamada Claude).
 */
export async function understandVideo(
  opts: UnderstandVideoOptions,
): Promise<{
  understanding: VideoUnderstanding;
  keyframes: ExtractedKeyframe[];
  modelUsed: string;
  elapsedSec: number;
}> {
  const t0 = Date.now();
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.startsWith('ROTATE_')) {
    throw new Error('ANTHROPIC_API_KEY no configurada para video-understander');
  }
  const model = opts.model ?? 'claude-haiku-4-5';

  // 1) Extraer keyframes
  const workDir = opts.workDir ?? `${opts.videoPath}.keyframes`;
  await mkdir(workDir, { recursive: true });
  const keyframes = await extractKeyframes({
    videoPath: opts.videoPath,
    outputDir: workDir,
    count: opts.keyframeCount,
    widthPx: 720,
  });
  if (keyframes.length === 0) {
    throw new Error('No se extrajo ningún keyframe del video');
  }

  // 2) Cargar keyframes como content multimodal: cada keyframe se mete como
  // imagen + label con su sourceTimeSec para que Claude pueda referenciar
  // tiempos en el output.
  const content: ClaudeMessageContent[] = [];
  for (const kf of keyframes) {
    const buf = await readFile(kf.filePath);
    content.push(
      ...buildImageMessageContent(
        buf,
        `\n[Keyframe ${kf.index} — t=${kf.sourceTimeSec.toFixed(1)}s de ${keyframes.length} total]`,
        'image/png',
      ),
    );
  }
  // Cierre con instrucción final + hint del conteo esperado de escenas
  const expectedScenesMin = keyframes.length;
  const expectedScenesMax = keyframes.length + 5;
  content.push({
    type: 'text',
    text:
      `\n\nDEBES devolver entre ${expectedScenesMin} y ${expectedScenesMax} escenas — UNA por keyframe distinto recibido. ` +
      `Si dos keyframes consecutivos muestran composiciones diferentes (cambio de personaje, encuadre, setting, ` +
      `composición), son escenas distintas: NO agrupes. Analiza los ${keyframes.length} keyframes en orden y devuelve el JSON estructurado.`,
  });

  // 3) Llamar Claude multimodal vía primitivo unificado (M7 Pieza C v2)
  const result = await judgeWithClaude({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    userContent: content,
    schema: VideoUnderstandingSchema,
    maxTokens: 16384,
    temperature: 0,
    timeoutMs: 120_000,
  });
  if (result.isErr()) {
    throw new Error(
      `video-understander falló (${result.error.type}): ${result.error.message}` +
        (result.error.detail ? `\nDetail: ${result.error.detail.slice(0, 300)}` : ''),
    );
  }

  // Sanity check: si Claude devolvió bastante menos escenas que keyframes, es
  // sub-counting probable. Logueamos warning visible.
  const understanding = result.value;
  if (understanding.scenes.length < keyframes.length - 2) {
    // eslint-disable-next-line no-console
    console.warn(
      `[video-understander] WARNING sub-counting probable: ${understanding.scenes.length} escenas vs ${keyframes.length} keyframes. ` +
        `Esperaba ~${expectedScenesMin}-${expectedScenesMax}. El preset auto-aprendido va a perder fidelidad.`,
    );
  }

  const elapsedSec = (Date.now() - t0) / 1000;
  return {
    understanding,
    keyframes,
    modelUsed: model,
    elapsedSec,
  };
}
