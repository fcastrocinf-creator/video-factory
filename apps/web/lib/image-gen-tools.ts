// Helpers compartidos para flujos que necesitan: (a) generar imágenes con
// provider chain, (b) comparar dos imágenes con Gemini Vision para score 0-100
// + hint de refinamiento. Originalmente vivía dentro de style-trainer.ts; lo
// extraje porque rip-fidelity-aligner.ts también lo necesita.

import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import {
  FalProvider,
  GeminiImageProvider,
  GoogleImagenProvider,
  HiggsfieldImageProvider,
  OpenaiImageProvider,
  VertexImagenProvider,
  ImageProviderError,
  type ImageProvider,
} from '@video-factory/block-image-gen-imagen';

// === Provider chain ====================================================

export interface ProviderStep {
  provider: ImageProvider;
  model: string;
  label: string;
}

/**
 * Construye el chain de providers de imagen siguiendo el mismo orden que
 * pipeline.ts: OpenAI gpt-image-1 → Vertex → AI Studio → Higgsfield → fal.ai.
 *
 * Si quieres priorizar foto-realismo amateur (UGC), llama con `preferRealistic=true`
 * y el chain pondrá Flux antes que Imagen para mejor UGC look.
 */
export function buildImageProviderChain(opts: { preferRealistic?: boolean } = {}): ProviderStep[] {
  const chain: ProviderStep[] = [];
  const openaiKey = process.env['OPENAI_API_KEY'];
  const gcpProjectId = process.env['GCP_PROJECT_ID'];
  const gcpCreds = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  const googleApiKey = process.env['GOOGLE_AI_API_KEY'];
  const hKid = process.env['HIGGSFIELD_KEY_ID'];
  const hSecret = process.env['HIGGSFIELD_KEY_SECRET'];
  const falKey = process.env['FAL_API_KEY'];

  // OpenAI gpt-image-1 — primary por defecto (sin daily caps, buen realismo)
  if (openaiKey && openaiKey !== 'sk_pendiente') {
    chain.push({
      provider: new OpenaiImageProvider({ apiKey: openaiKey, quality: 'medium' }),
      model: 'gpt-image-1',
      label: 'openai:gpt-image-1',
    });
  }

  // Si el estilo es photo-realistic UGC, Flux (fal o Higgsfield) suele dar
  // mejores resultados que Imagen para "amateur smartphone look". Por eso
  // bumpeamos su prioridad cuando preferRealistic=true.
  if (opts.preferRealistic) {
    if (hKid && hSecret) {
      chain.push({
        provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
        model: 'flux-pro/kontext/max/text-to-image',
        label: 'higgsfield:flux-pro-kontext',
      });
    }
    if (falKey) {
      chain.push({
        provider: new FalProvider({ apiKey: falKey, defaultModel: 'fal-ai/flux-pro/v1.1' }),
        model: 'fal-ai/flux-pro/v1.1',
        label: 'fal:flux-pro-v1.1',
      });
    }
  }

  // Vertex Imagen
  if (gcpProjectId && gcpCreds) {
    const vertex = new VertexImagenProvider({ projectId: gcpProjectId });
    chain.push(
      { provider: vertex, model: 'imagen-4.0-fast-generate-001', label: 'vertex:fast' },
      { provider: vertex, model: 'imagen-4.0-generate-001', label: 'vertex:std' },
    );
  }
  // AI Studio Imagen
  if (googleApiKey) {
    const aistudio = new GoogleImagenProvider({ apiKey: googleApiKey });
    chain.push(
      { provider: aistudio, model: 'imagen-4.0-fast-generate-001', label: 'aistudio:fast' },
      { provider: aistudio, model: 'imagen-4.0-generate-001', label: 'aistudio:std' },
    );
  }

  // Si NO preferimos realistic, agregamos Higgsfield y fal AL FINAL (compat con
  // el comportamiento del style-trainer original).
  if (!opts.preferRealistic) {
    if (hKid && hSecret) {
      chain.push({
        provider: new HiggsfieldImageProvider({ keyId: hKid, keySecret: hSecret }),
        model: 'flux-pro/kontext/max/text-to-image',
        label: 'higgsfield:flux-pro-kontext',
      });
    }
    if (falKey) {
      chain.push({
        provider: new FalProvider({ apiKey: falKey, defaultModel: 'fal-ai/flux-pro/v1.1' }),
        model: 'fal-ai/flux-pro/v1.1',
        label: 'fal:flux-pro-v1.1',
      });
    }
  }
  return chain;
}

/**
 * Genera una imagen siguiendo el provider chain. Salta al siguiente provider si:
 *   - isDailyQuotaExhausted / isContentRejection / retryable=true (ImageProviderError)
 *   - error contiene "timeout", "ETIMEDOUT", "ECONNRESET", "fetch failed", "network"
 *     (errores genéricos transitorios que NO son ImageProviderError pero igual
 *     justifican fallback al siguiente provider del chain)
 *   - error 5xx HTTP (server overload del provider)
 *
 * Solo tira inmediatamente si TODOS los providers fueron probados (y sus errores
 * acumulados, devolvemos el último).
 */
export async function generateImageWithChain(
  prompt: string,
  chain: ProviderStep[],
): Promise<{ buffer: Buffer; providerLabel: string }> {
  let lastError: Error | null = null;
  for (const step of chain) {
    try {
      const buf = await step.provider.generate({
        prompt,
        aspectRatio: '9:16',
        model: step.model,
      });
      return { buffer: buf, providerLabel: `${step.label}/${step.model}` };
    } catch (e) {
      lastError = e as Error;
      const provErr = e instanceof ImageProviderError ? e : null;
      // Caso 1: ImageProviderError con flags conocidas → fallback
      if (
        provErr &&
        (provErr.isDailyQuotaExhausted || provErr.isContentRejection || provErr.retryable)
      ) {
        continue;
      }
      // Caso 2: error genérico transitorio (timeout, network, 5xx) → fallback
      const msg = (e as Error).message ?? '';
      const isTransient =
        /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN|fetch failed|network error|socket hang up|5\d\d/i.test(
          msg,
        );
      if (isTransient) {
        continue;
      }
      // Caso 3: error fatal no-recuperable (auth, malformed) → propagar
      throw e;
    }
  }
  throw lastError ?? new Error('Todos los providers de imagen fallaron');
}

/**
 * Genera una imagen ANCLADA a una imagen de referencia (image-to-image) usando
 * Gemini Nano Banana (gemini-2.5-flash-image), que soporta imagen+texto→imagen.
 * Fija paleta, iluminación y medium al original MUCHO mejor que generar desde
 * texto puro — que era la causa #1 del drift de paleta en el aprendizaje.
 *
 * El prompt instruye explícitamente: usa la referencia SOLO para estilo, genera
 * una escena nueva, y NO copies texto/UI/logos de la referencia (para que el
 * resultado quede limpio, listo para poner el copy en post-producción).
 *
 * Si no hay GOOGLE_AI_API_KEY o Nano Banana falla, cae de vuelta al chain
 * texto-only (`generateImageWithChain`) para no romper el flujo.
 */
export async function generateImageWithReference(
  prompt: string,
  referenceImage: Buffer,
  fallbackChain?: ProviderStep[],
): Promise<{ buffer: Buffer; providerLabel: string }> {
  const googleApiKey = process.env['GOOGLE_AI_API_KEY'];
  if (googleApiKey) {
    try {
      const nanoBanana = new GeminiImageProvider({ apiKey: googleApiKey, name: 'gemini-image-ref' });
      const buf = await nanoBanana.generate({
        prompt:
          prompt +
          '\n\nIMPORTANT: use the provided reference image ONLY to match its visual STYLE — color palette, lighting, art medium and overall mood. Generate a NEW representative scene in that exact same style (different content/subject is fine). Do NOT copy any text, captions, social-media UI or logos from the reference image.',
        aspectRatio: '9:16',
        referenceImage,
      });
      return { buffer: buf, providerLabel: 'gemini-image-ref/nano-banana' };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[generateImageWithReference] Nano Banana falló, fallback a texto-only: ${(e as Error).message.slice(0, 200)}`,
      );
    }
  }
  const chain = fallbackChain ?? buildImageProviderChain();
  return generateImageWithChain(prompt, chain);
}

// === Comparator (Gemini Vision) ========================================

export interface CompareResult {
  score: number;
  hint: string;
  details: {
    palette: number;
    composition: number;
    character: number;
    mood: number;
  };
}

const VERTEX_LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';
const VISION_MODEL = 'gemini-2.5-pro';

let cachedVertexToken: { token: string; expiresAtMs: number } | null = null;

async function getVertexToken(): Promise<string> {
  const now = Date.now();
  // Margen de 5 minutos: si el token está por expirar en menos de 5 min,
  // lo refrescamos. Reduce mucho la ventana de race entre workers concurrentes.
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

const COMPARATOR_SYSTEM = `You are a visual STYLE similarity judge for advertising-grade image generation. You receive two images and score how closely the GENERATED matches the ORIGINAL's **AESTHETIC STYLE** — NOT its literal content.

CRITICAL RULES — READ TWICE:

1. STYLE means: photographic look (UGC smartphone vs DSLR vs studio), illustration technique (watercolor vs vector vs 3D), color palette, lighting quality, lens characteristics, grain, atmosphere, mood.

2. STYLE does NOT mean: specific person identity, specific clothing, specific objects, specific background scene. These can be COMPLETELY DIFFERENT and still score 95+ if the aesthetic matches.

3. **"character"** sub-score evaluates CHARACTER TYPE (photoreal real human vs illustrated cartoon vs 3D render), AGE BAND of subjects (kid vs adult vs elder), and STYLE of depiction. It does NOT evaluate if it's the same person. Two different real women both looking UGC-amateur should score 90+ on character.

4. **"composition"** evaluates SHOT TYPE (close-up vs wide vs over-shoulder) and framing style, NOT identical framing.

EXAMPLES:
  - ORIGINAL: real woman 35yo smartphone selfie at home.
    GENERATED: different real woman 45yo smartphone selfie at home → score 90-95 (same style, different identity)
  - ORIGINAL: red anatomical illustration of human face.
    GENERATED: photo of real woman → score 20-30 (different aesthetic entirely)
  - ORIGINAL: hand-illustrated watercolor sepia.
    GENERATED: photo-realistic DSLR → score 10-20

Return EXCLUSIVELY this JSON:
{
  "score": <0-100>,
  "details": {
    "palette": <0-100>,
    "composition": <0-100>,
    "character": <0-100>,
    "mood": <0-100>
  },
  "hint": "<actionable instruction to improve STYLE match (NOT identity). Max 25 words. Examples: 'warmer amber tones', 'add film grain texture', 'use phone-shot look instead of DSLR', 'illustrated style not photo'>"
}

Score thresholds (STYLE alignment, not content):
  95+ = aesthetic indistinguishable
  85-94 = very close style, minor lighting/palette tweaks
  70-84 = same medium type (both photo, both illustration) but different style
  50-69 = related medium (e.g. both photo but one is DSLR studio one is UGC)
  <50 = wrong medium entirely (photo when expected illustration, or vice versa)`;

const CompareSchema = z.object({
  score: z.number().min(0).max(100),
  details: z.object({
    palette: z.number().min(0).max(100),
    composition: z.number().min(0).max(100),
    character: z.number().min(0).max(100),
    mood: z.number().min(0).max(100),
  }),
  hint: z.string(),
});

/**
 * Compara dos imágenes con Gemini Vision. Prueba Vertex primero (sin prepay),
 * fallback AI Studio. Devuelve score 0-100 + hint para refinement.
 */
export async function compareImagesWithVision(
  originalPath: string,
  generatedBuffer: Buffer,
): Promise<CompareResult> {
  const originalBase64 = (await readFile(originalPath)).toString('base64');
  const generatedBase64 = generatedBuffer.toString('base64');

  const bodyParts = [
    { text: 'IMAGE 1 — ORIGINAL (reference style to match):' },
    { inlineData: { mimeType: 'image/png', data: originalBase64 } },
    { text: 'IMAGE 2 — GENERATED (AI attempt):' },
    { inlineData: { mimeType: 'image/png', data: generatedBase64 } },
    { text: 'Score how well IMAGE 2 matches IMAGE 1\'s visual STYLE. Return the JSON.' },
  ];

  const projectId = process.env['GCP_PROJECT_ID'];
  const aiStudioKey = process.env['GOOGLE_AI_API_KEY'];

  // Vertex primero
  if (projectId) {
    try {
      const token = await getVertexToken();
      const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VISION_MODEL}:generateContent`;
      const body = {
        contents: [{ role: 'user', parts: bodyParts }],
        systemInstruction: { parts: [{ text: COMPARATOR_SYSTEM }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return CompareSchema.parse(JSON.parse(text));
      }
    } catch {
      // fallthrough a AI Studio
    }
  }

  if (!aiStudioKey) {
    throw new Error('Comparator: configurá GCP_PROJECT_ID o GOOGLE_AI_API_KEY');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: bodyParts }],
    systemInstruction: { parts: [{ text: COMPARATOR_SYSTEM }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': aiStudioKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Comparator ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Comparator devolvió sin texto');
  return CompareSchema.parse(JSON.parse(text));
}

// === Selector de fotograma de REFERENCIA (representativo, NO el más simple) ===
// Ruta de aprendizaje: la referencia debe capturar el estilo Y su densidad típica.
// Un frame "limpio/minimalista" pierde la riqueza del estilo; elegimos el más
// REPRESENTATIVO (rico, con la composición típica del ad), evitando solo los frames
// que son puro mockup de redes / texto quemado, o atípicamente vacíos.

const REFERENCE_FRAME_SYSTEM = `You pick the BEST reference frame to learn and reproduce an ad's VISUAL STYLE from. You receive several numbered frames from one video ad. Choose the frame that is MOST REPRESENTATIVE of the ad's native art style AND its typical composition density — a rich, content-full scene that captures how the ad usually looks (its characters, environment, and amount of elements).

RULES:
- PREFER a frame that shows the subject(s) + environment in the ad's full visual richness. If the ad's scenes are busy/dense (multiple characters, detailed environments, effects), pick a BUSY/DENSE frame — do NOT pick an unusually empty or minimal frame.
- AVOID frames that are mostly social-media mockup chrome (Instagram/TikTok UI, like/comment buttons, profile headers), or dominated by big burned-in caption text, or atypically sparse.
- Goal: a frame a generator could use to reproduce THIS ad's look at FULL fidelity, including its density.

Return EXCLUSIVELY this JSON: {"bestIndex": <0-based integer>, "reason": "<max 14 words>"}`;

const ReferenceFrameSchema = z.object({
  bestIndex: z.number().int().min(0),
  reason: z.string().optional(),
});

/**
 * De un set de keyframes, elige el más REPRESENTATIVO del estilo (rico, con la
 * densidad típica del ad) para usarlo como referencia de generación. ANTES elegía
 * el más "limpio/simple" — pero eso PIERDE la densidad (un estilo cargado se
 * aprendía minimalista). Ahora favorece el frame que mejor captura el look completo,
 * evitando solo los puramente mockup/texto o atípicamente vacíos.
 *
 * Usa Gemini Vision. Si no hay key, hay 0-1 frames, o algo falla, devuelve el
 * índice del medio (fallback seguro — suele ser una escena de contenido).
 */
export async function pickReferenceFrameIndex(framePaths: string[]): Promise<number> {
  const midpoint = Math.floor(framePaths.length / 2);
  if (framePaths.length <= 1) return 0;
  const googleApiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!googleApiKey) return midpoint;
  try {
    const parts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < framePaths.length; i++) {
      parts.push({ text: `Frame ${i}:` });
      const b64 = (await readFile(framePaths[i]!)).toString('base64');
      parts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
    }
    parts.push({ text: 'Pick the most REPRESENTATIVE frame (richest, captures the style and its density; avoid pure text/UI/mockup frames and unusually empty ones). Return the JSON.' });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': googleApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        systemInstruction: { parts: [{ text: REFERENCE_FRAME_SYSTEM }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
    if (!resp.ok) return midpoint;
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return midpoint;
    const parsed = ReferenceFrameSchema.parse(JSON.parse(text));
    return parsed.bestIndex >= 0 && parsed.bestIndex < framePaths.length
      ? parsed.bestIndex
      : midpoint;
  } catch {
    return midpoint;
  }
}
