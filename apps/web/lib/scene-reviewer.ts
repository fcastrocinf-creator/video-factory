// Scene Reviewer Agent — capa semántica de revisión por escena.
//
// Diferencia con los validators existentes:
//   - SceneValidatorV3 (anatomy)   → cuenta dedos, ojos, simetría facial
//   - compareImagesWithVision      → score de "similitud de estilo" vs keyframe
//   - SCENE REVIEWER (este)        → revisa COHERENCIA SEMÁNTICA + LANGUAGE + DUPLICACIÓN
//                                     como un agente humano que ve la escena y juzga
//                                     "¿esto está bien o hay que rehacerlo?"
//
// Chequeos críticos:
//   1. TEXTO BURNED-IN: ¿hay texto en inglés cuando el ad es en español?
//      ¿hay glifos rotos / typos visibles?
//   2. COHERENCIA CON LA NARRACIÓN: ¿la imagen muestra LITERALMENTE lo que el
//      narrador dice en este momento?
//   3. NO DUPLICACIÓN: dado el imagePath de la escena anterior, ¿esta nueva
//      escena se ve demasiado similar (mismo plano, mismo personaje, sin variación)?
//   4. PRODUCTO: cuando el script menciona el producto, ¿se ve correctamente?
//   5. STYLE BURNED-IN TEXT: si el aligner instruyó "clean background no text"
//      pero el generador incrustó texto igual → reject.

import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

// gemini-2.5-flash en vez de pro: el reviewer es invocado 1× por intento de
// cada escena (50 escenas × ~2 intentos = ~100 llamadas por rip). El quota
// de pro en AI Studio (1000 req/día) se agota rápido con varios rips/día
// y el reviewer cae silencioso al fallback 'pass', dejando pasar todas las
// imágenes inclusive con gibberish text. Flash tiene 10K req/día free y es
// MÁS QUE SUFICIENTE para juicio binario "pass/regenerate" con descripción.
const VISION_MODEL = 'gemini-2.5-flash';
const VERTEX_LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';

function logReviewerFallback(reason: string, detail?: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[scene-reviewer] FALLBACK to verdict='pass' — reason: ${reason}${detail ? ` | detail: ${detail.slice(0, 200)}` : ''}`,
  );
}

// Retry con backoff exponencial para rate-limit (429) o network errors transitorios.
// Es crítico para el reviewer porque caemos en 429 con AI Studio cuando spam de
// requests (50 escenas × ~3 attempts × 2 modelos = ~300 requests por rip).
// Vertex tiene rate-limit más alto, así que retry primero contra Vertex.
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
      // Retry solo en 429 (rate limit) y 5xx (server error). 4xx no-rate son finales.
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        if (i < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 500;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
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

const REVIEWER_SYSTEM = `You are a SENIOR CREATIVE DIRECTOR reviewing AI-generated advertising scenes before they ship. You receive:
  1. The GENERATED IMAGE (a single ad scene, vertical 9:16)
  2. CONTEXT: target language, scene narration text, expected style, position in the video, whether textOverlays will be added in post-production
  3. (optional) PREVIOUS SCENE IMAGE to detect duplication

Your job: decide if this scene is FIT TO PRODUCTION or needs to be REGENERATED, and explain why with actionable advice.

CRITICAL CHECKS (in priority order):

0. **UNEXPECTED COMPOSITE / GRID**: If context says "expected single shot" but the image is actually a split-screen / grid / collage / multiple panels → REJECT. The image generator hallucinated a composite that doesn't match the intended layout. Set verdict='regenerate' and refinementHint must be: "Generate a SINGLE coherent shot, no grid, no split-screen, no multiple panels — just one focused frame."

1. **BURNED-IN TEXT LANGUAGE**: If the ad's target language is Spanish (or NOT English) but the image has English text burned into it (e.g. "TRY THIS", "FINE LINES", "AGOTADO"-like overlays in wrong language), this is REJECT. The image was meant to have CLEAN background — text overlays are added later in post-production as vector text. Penalize ANY burned-in text the generator added when it wasn't supposed to.

2. **BROKEN GLYPHS / TYPOS**: Any visible text in the image that contains gibberish, missing letters, weird characters, broken kerning, or duplicated words → REJECT. Generators famously fail at text rendering; we expect CLEAN images and overlay text in post.

3. **NARRATION-IMAGE COHERENCE**: Does the image LITERALLY depict what the narrator says in this scene? If narration says "puffy face with dark circles", the image must show a puffy face with dark circles — NOT a happy smiling face. If clearly disconnected → REGENERATE.

4. **NO REPETITION OF PREVIOUS SCENE**: If a previous scene image is provided and this new image is too similar (same character, same framing, same composition), flag as 'regenerate' so the planner adds variation.

5. **PRODUCT VISIBILITY**: If the narration explicitly mentions the product name, the product (dropper bottle, label, etc.) should be visible. If not visible when it should be → REGENERATE.

6. **STYLE FIDELITY**: Image should match the declared style category (UGC photo-real, illustration, mixed-hybrid, etc.). If the declared style is "phone-shot UGC selfie" but the image looks like a professional DSLR studio shot, flag as regenerate.

7. **ANATOMICAL SANITY**: Extra fingers, fused limbs, asymmetric eyes, multiple shadows — REJECT. (Even though SceneValidatorV3 catches this separately, double-check here.)

Output STRICT JSON:
{
  "verdict": "pass" | "regenerate" | "fatal",
  "criticalIssues": ["short bullet 1", "short bullet 2", ...],
  "refinementHint": "<one specific actionable sentence telling the generator how to fix the scene next attempt. max 30 words.>",
  "burnedInText": {
    "present": <bool>,
    "text": "<literal text seen if present, else empty>",
    "languageDetected": "<ISO 639-1 or 'mixed' or 'gibberish'>"
  },
  "matchesNarration": <bool>,
  "duplicatesPreviousScene": <bool>,
  "productVisible": <bool | null>
}

Verdict rules:
  - "pass": scene is fit to production
  - "regenerate": fixable issues, try again with the refinementHint
  - "fatal": image is so broken it shouldn't be retried (e.g. provider returned garbage). Use sparingly.`;

export const ReviewResultSchema = z.object({
  verdict: z.enum(['pass', 'regenerate', 'fatal']),
  criticalIssues: z.array(z.string()).default([]),
  refinementHint: z.string(),
  burnedInText: z
    .object({
      present: z.boolean(),
      text: z.string().default(''),
      languageDetected: z.string().default(''),
    })
    .optional(),
  matchesNarration: z.boolean().optional(),
  duplicatesPreviousScene: z.boolean().optional(),
  productVisible: z.boolean().nullable().optional(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface SceneReviewerInput {
  /** Image of the scene to review (the most recent generation) */
  imageBuffer: Buffer;
  /** What the narrator says during this scene (literal text) */
  narrationText: string;
  /** ISO 639-1 of the target audience language. Most important for burned-in text check. */
  targetLanguage: string;
  /** Style category declared by the preset (UGC, illustration, etc.) */
  declaredStyle?: string;
  /** Did the planner mark this scene with textOverlays (meaning generator should produce CLEAN image)? */
  shouldHaveCleanBackground?: boolean;
  /** Path to the previous scene's image (for duplication check). Optional. */
  previousSceneImagePath?: string | null;
  /** Brand/product name that should appear if narration mentions it. Optional. */
  productName?: string | null;
  /**
   * Si true, esperamos UN SOLO plano (single shot). Si la imagen es split-screen /
   * grid / collage / múltiples paneles, el reviewer debe rechazar con verdict=
   * 'regenerate' porque el aligner pre-determinó que la escena NO es composite.
   * Si la escena es composite, el aligner ya está generando cada panel por separado
   * y NO usa este reviewer para el frame entero.
   */
  expectedSingleShot?: boolean;
}

/**
 * Revisa una escena con Gemini Vision usando el system prompt de "creative director".
 * Devuelve verdict + criticalIssues + refinementHint.
 *
 * Falla silenciosa si Vertex/AI Studio están caídos: retorna verdict='pass' con
 * issue 'reviewer unavailable' — el caller decide si bloquea o sigue.
 */
export async function reviewScene(input: SceneReviewerInput): Promise<ReviewResult> {
  const generatedBase64 = input.imageBuffer.toString('base64');
  const parts: Array<Record<string, unknown>> = [
    { text: `GENERATED IMAGE (review this):` },
    { inlineData: { mimeType: 'image/png', data: generatedBase64 } },
    {
      text: `CONTEXT:
- Target audience language: ${input.targetLanguage}
- Scene narration text (what the narrator says during this frame): "${input.narrationText.slice(0, 400)}"
- Declared style: ${input.declaredStyle ?? '(not specified)'}
- This scene ${input.shouldHaveCleanBackground ? 'SHOULD have CLEAN background (text overlays come from post-production)' : 'may include text if natural'}
- Product to look for: ${input.productName ?? '(none specified)'}
- Layout expectation: ${input.expectedSingleShot ? 'SINGLE SHOT EXPECTED — if the image is a grid, split-screen, collage, or multi-panel composite, REJECT with verdict=regenerate. The detector pre-classified this scene as single, so any composite is a generator hallucination.' : 'composite layouts allowed if natural'}

Now follow the system instructions and emit the JSON verdict.`,
    },
  ];

  // Si tenemos imagen anterior, la agregamos para el check de duplicación
  if (input.previousSceneImagePath) {
    try {
      const prev = await readFile(input.previousSceneImagePath);
      parts.unshift(
        { text: 'PREVIOUS SCENE IMAGE (for duplication check — flag if the new one is too similar):' },
        { inlineData: { mimeType: 'image/png', data: prev.toString('base64') } },
      );
    } catch {
      // Si no podemos leer la previa, seguimos sin ella
    }
  }

  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: REVIEWER_SYSTEM }] },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // Aumentado de default (~1024) a 2048 para evitar truncate del JSON
      // cuando el reviewer detecta muchos issues (3+ critical issues + hint).
      // El truncate causa parse error y silent fallback a 'pass'.
      maxOutputTokens: 2048,
    },
  };

  const projectId = process.env['GCP_PROJECT_ID'];
  const aiStudioKey = process.env['GOOGLE_AI_API_KEY'];

  // Probamos Vertex primero
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
            return ReviewResultSchema.parse(JSON.parse(text));
          } catch (e) {
            vertexError = `vertex parse: ${(e as Error)?.message ?? ''}`;
          }
        } else {
          vertexError = 'vertex empty';
        }
      } else {
        vertexError = `vertex HTTP ${resp.status}`;
      }
    } catch (e) {
      vertexError = `vertex throw: ${(e as Error)?.message ?? ''}`;
    }
  } else {
    vertexError = 'no GCP_PROJECT_ID';
  }

  if (!aiStudioKey) {
    logReviewerFallback('no AI Studio key', vertexError ?? undefined);
    return {
      verdict: 'pass',
      criticalIssues: ['reviewer unavailable: no Vertex nor AI Studio configured'],
      refinementHint: '',
    };
  }
  const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
  const aiBody = {
    contents: [{ parts: body.contents[0]!.parts }],
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
    logReviewerFallback(`AI Studio HTTP ${resp.status}`, `vertex=${vertexError} | aistudio=${errBody.slice(0, 150)}`);
    return {
      verdict: 'pass',
      criticalIssues: [`reviewer AI Studio ${resp.status}`],
      refinementHint: '',
    };
  }
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    logReviewerFallback('AI Studio empty');
    return { verdict: 'pass', criticalIssues: ['reviewer returned empty'], refinementHint: '' };
  }
  try {
    return ReviewResultSchema.parse(JSON.parse(text));
  } catch (e) {
    logReviewerFallback('malformed JSON', `${(e as Error)?.message ?? ''} | text=${text.slice(0, 150)}`);
    return {
      verdict: 'pass',
      criticalIssues: ['reviewer returned malformed JSON'],
      refinementHint: '',
    };
  }
}
