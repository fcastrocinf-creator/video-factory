// Composite layout detector — analiza un keyframe del video original con Gemini
// Vision y determina si es un split-screen / collage que debería renderizarse
// como composite (varios paneles independientes) en vez de una sola imagen.
//
// Output: layout type + lista de paneles con descripción de qué contiene cada uno
// y opcionalmente texto overlay propio (para que Remotion lo renderice vectorial).

import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import {
  CompositeLayoutSchema,
  type CompositeLayout,
} from '@video-factory/contracts';
import {
  queryRelevantCompositionCorrections,
  formatCompositionLessons,
} from '@video-factory/core';

// Usamos gemini-2.5-flash en vez de pro: detectar layout es una tarea simple
// (clasificar entre 6 layouts predefinidos viendo 1 imagen) que no necesita
// el razonamiento profundo del pro. Flash tiene 10K req/día free vs 1K del pro,
// lo cual evita que el detector caiga al fallback 'single' por rate limiting
// cuando un run procesa 50+ escenas. El reviewer (gemini-2.5-pro) sigue siendo
// pro porque ahí sí queremos juicio crítico.
const VISION_MODEL = 'gemini-2.5-flash';
const VERTEX_LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';

// Log helper: cuando el detector cae al fallback 'single' por error, lo
// loguemos VISIBLE en stderr para no enmascarar bugs futuros del pipeline.
// Sin esto, todas las escenas se renderizaban como single y nadie se enteraba.
function logDetectorFallback(reason: string, detail?: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[composite-layout-detector] FALLBACK to 'single' — reason: ${reason}${detail ? ` | detail: ${detail.slice(0, 200)}` : ''}`,
  );
}

// Retry con backoff exponencial — mismo motivo que en scene-reviewer.ts
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  let lastErr: unknown = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(url, init);
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        if (i < maxRetries) {
          await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i) + Math.random() * 500));
          continue;
        }
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, i) + Math.random() * 500));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error('fetchWithRetry exhausted');
}

let cachedVertexToken: { token: string; expiresAtMs: number } | null = null;
async function getVertexToken(): Promise<string> {
  const now = Date.now();
  if (cachedVertexToken && cachedVertexToken.expiresAtMs > now + 5 * 60_000) {
    return cachedVertexToken.token;
  }
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp.token) throw new Error('Vertex token unavailable');
  cachedVertexToken = { token: tokenResp.token, expiresAtMs: now + 50 * 60 * 1000 };
  return tokenResp.token;
}

const DETECTOR_SYSTEM = `You are a layout analyst for vertical 9:16 advertising video frames. Given ONE frame, decide if the frame is a SINGLE shot or a COMPOSITE (split-screen, collage, grid, before/after, picture-in-picture).

Your decisions matter because the downstream pipeline will generate ONE image per panel separately (much higher quality than trying to recreate a collage in a single AI generation) and Remotion will composite them with pixel-perfect vector text overlays.

CRITICAL — only return 'single' when the frame is genuinely ONE coherent shot. If you see ANY visible split/border between panels, multiple distinct sub-scenes, before/after framing, "picture-in-picture" mini frame, treat it as composite.

LAYOUT TYPES (pick ONE that best matches the frame):
  - "single": one coherent shot, no panels
  - "grid-2x2": 4 equal panels in a 2x2 arrangement
  - "grid-2x2-with-bottom": 4 equal panels (2x2 top) + 1 wider panel below (5 total)
  - "grid-3x2": 6 panels in a 3-rows × 2-columns grid (common for "6 women before/after" testimonial grids)
  - "before-after": 2 vertical panels (left = before, right = after) OR top/bottom with clear "before/after" framing
  - "side-by-side": 2 panels stacked top/bottom (NOT before-after, just sequential)
  - "pip": one main image + small inset (picture-in-picture)

For EACH panel detected, describe:
  - position ID. Use EXACTLY these per layout:
    * grid-2x2 → top-left, top-right, bottom-left, bottom-right
    * grid-2x2-with-bottom → top-left, top-right, bottom-left, bottom-right, bottom-wide
    * grid-3x2 → top-left, top-right, middle-left, middle-right, bottom-left, bottom-right
    * before-after → left, right
    * side-by-side → top, bottom
    * pip → main, pip
    * single → main
  - what's IN the panel: characters (gender, age, expression, setting) OR objects OR diagrams (be specific — 30-50 words). This becomes the imagePrompt for that panel's generation.
  - any TEXT overlay visible on that panel (literal text, may be in any language). If text is gibberish or broken from the original, infer the INTENT (e.g. "AGOTADO", "DAY 14", "BEFORE", "VITALY") and use that. If no text visible, set to null.
  - EXACT GEOMETRY (rect): the precise bounding box of the panel WITHIN the frame, as percentages 0-100. Fields: x (left edge), y (top edge), w (width), h (height). MEASURE PRECISELY from the actual frame — real ad panels are often NOT a perfectly even grid: a picture-in-picture inset might be {x:62,y:68,w:34,h:28}; a "before/after" split might be {x:0,y:0,w:50,h:100} and {x:50,y:0,w:50,h:100}; a wide bottom strip might be {x:0,y:75,w:100,h:25}. Capture the REAL geometry you see, not an idealized template. For layout='single' the rect is {x:0,y:0,w:100,h:100}.

Output STRICT JSON:
{
  "layout": "single" | "grid-2x2" | "grid-2x2-with-bottom" | "grid-3x2" | "before-after" | "side-by-side" | "pip",
  "panels": [
    {
      "position": "top-left" | "top-right" | "middle-left" | "middle-right" | "bottom-left" | "bottom-right" | "bottom-wide" | "left" | "right" | "top" | "bottom" | "main" | "pip",
      "description": "<what's in the panel, 30-50 words, in ENGLISH for image generator>",
      "textOverlay": "<literal text visible on panel, in target language, or null>",
      "rect": { "x": <0-100>, "y": <0-100>, "w": <0-100>, "h": <0-100> }
    }
  ],
  "reasoning": "<1 sentence why you chose this layout>"
}

If layout='single', panels must contain exactly ONE entry with position='main' and rect {x:0,y:0,w:100,h:100}.`;

// Geometría exacta de un panel dentro del frame, en porcentajes 0-100.
// x/y = esquina superior izquierda; w/h = ancho/alto. Capturada por Gemini
// Vision sobre el keyframe del original. Se mapea a CompositeElement.rect.
const PanelRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type PanelRect = z.infer<typeof PanelRectSchema>;

const DetectorResultSchema = z.object({
  layout: CompositeLayoutSchema,
  panels: z
    .array(
      z.object({
        position: z.string(),
        description: z.string(),
        textOverlay: z.string().nullable().default(null),
        // Geometría exacta del panel. Opcional/nullable: si el modelo no la
        // devuelve, el aligner cae a las coordenadas del layout rígido.
        rect: PanelRectSchema.nullable().default(null),
      }),
    )
    .min(1),
  reasoning: z.string().default(''),
});
export type DetectorResult = z.infer<typeof DetectorResultSchema>;

/**
 * Contexto opcional de la escena. Habilita el LOOP DE APRENDIZAJE: el detector
 * consulta las correcciones manuales previas relevantes a este contexto y las
 * inyecta como ejemplos few-shot, sesgando su estimación de geometría hacia lo
 * que el usuario realmente prefiere.
 */
export interface DetectContext {
  narration?: string;
  brand?: string;
  preset?: string;
}

/**
 * Analiza un keyframe del video original. Si es composite, devuelve el layout
 * + paneles con geometría exacta. Si es single, devuelve layout='single'.
 *
 * Falla "soft" — si el detector cae, devolvemos layout='single' (comportamiento
 * histórico) para no romper el flow del aligner.
 */
export async function detectCompositeLayout(
  keyframePath: string,
  context?: DetectContext,
): Promise<DetectorResult> {
  let imageBase64: string;
  try {
    imageBase64 = (await readFile(keyframePath)).toString('base64');
  } catch (e) {
    logDetectorFallback('keyframe unreadable', (e as Error)?.message);
    return {
      layout: 'single',
      panels: [{ position: 'main', description: 'unknown', textOverlay: null, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      reasoning: 'keyframe unreadable, defaulting to single',
    };
  }

  // LOOP DE APRENDIZAJE: cargamos las correcciones manuales previas relevantes
  // y las inyectamos al prompt. Best-effort — si falla, el detector sigue igual.
  let lessonsBlock = '';
  try {
    const lessons = await queryRelevantCompositionCorrections({
      narration: context?.narration,
      brand: context?.brand,
      preset: context?.preset,
      topK: 6,
    });
    lessonsBlock = formatCompositionLessons(lessons);
  } catch {
    /* best-effort */
  }

  const parts = [
    { text: `Analyze this frame layout:${lessonsBlock}` },
    { inlineData: { mimeType: 'image/png', data: imageBase64 } },
    { text: 'Return the JSON as specified.' },
  ];
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: DETECTOR_SYSTEM }] },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const projectId = process.env['GCP_PROJECT_ID'];
  const aiStudioKey = process.env['GOOGLE_AI_API_KEY'];

  // Vertex primero
  let vertexError: string | null = null;
  if (projectId) {
    try {
      const token = await getVertexToken();
      const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VISION_MODEL}:generateContent`;
      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          try {
            return DetectorResultSchema.parse(JSON.parse(text));
          } catch (e) {
            vertexError = `vertex parse: ${(e as Error)?.message ?? 'unknown'}`;
          }
        } else {
          vertexError = 'vertex empty response';
        }
      } else {
        vertexError = `vertex HTTP ${resp.status}`;
      }
    } catch (e) {
      vertexError = `vertex throw: ${(e as Error)?.message ?? 'unknown'}`;
    }
  } else {
    vertexError = 'no GCP_PROJECT_ID';
  }

  if (!aiStudioKey) {
    logDetectorFallback('no AI Studio key', vertexError ?? undefined);
    return {
      layout: 'single',
      panels: [{ position: 'main', description: 'detector unavailable', textOverlay: null, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      reasoning: 'no Vertex nor AI Studio',
    };
  }
  const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
  const aiBody = {
    contents: [{ parts }],
    systemInstruction: body.systemInstruction,
    generationConfig: body.generationConfig,
  };
  const resp = await fetchWithRetry(aiUrl, {
    method: 'POST',
    headers: { 'x-goog-api-key': aiStudioKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(aiBody),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    logDetectorFallback(`AI Studio HTTP ${resp.status}`, `vertex=${vertexError} | aistudio=${errBody.slice(0, 200)}`);
    return {
      layout: 'single',
      panels: [{ position: 'main', description: 'detector error', textOverlay: null, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      reasoning: `AI Studio ${resp.status}`,
    };
  }
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    logDetectorFallback('AI Studio empty response');
    return {
      layout: 'single',
      panels: [{ position: 'main', description: 'empty response', textOverlay: null, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      reasoning: 'AI Studio empty',
    };
  }
  try {
    return DetectorResultSchema.parse(JSON.parse(text));
  } catch (e) {
    logDetectorFallback('malformed JSON', `${(e as Error)?.message ?? ''} | text=${text.slice(0, 200)}`);
    return {
      layout: 'single',
      panels: [{ position: 'main', description: 'malformed JSON', textOverlay: null, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      reasoning: 'malformed',
    };
  }
}
