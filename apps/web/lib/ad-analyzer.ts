// Ad analyzer: toma un MP4 (anuncio de referencia) y devuelve AdAnalysis.
//
// Estrategia DUAL según tamaño:
//   <= 14 MB  → INLINE base64. Path corto: Vertex primary, AI Studio fallback.
//               Total ~30-60s.
//   >  14 MB  → FILE API de Google AI Studio. Sube el video, espera ACTIVE,
//               pasa fileUri a generateContent. Soporta hasta 2 GB.
//               Total +5-20s extra por upload+procesamiento del file.
//
// Backend: Vertex AI primary (cuenta del usuario funcional), AI Studio fallback.
// Reusa la clave + GoogleAuth de GCP_PROJECT_ID/GOOGLE_APPLICATION_CREDENTIALS.
// Para File API solo Google AI Studio (Vertex requiere GCS bucket aparte).

import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import {
  AdAnalysisSchema,
  AdVisualStyleProfileSchema,
  type AdAnalysis,
} from '@video-factory/contracts';

const VERTEX_LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';
const VERTEX_MODEL = 'gemini-2.5-pro';
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const AI_STUDIO_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

// Threshold inline vs File API. Vertex limita 20 MB total payload; base64 expande
// ~33% → 14 MB raw es el sweet spot inline. >14 MB pasamos a File API.
const INLINE_LIMIT_MB = 14;
// Max absoluto que aceptamos. File API soporta 2 GB pero 200 MB cubre el 99% de
// los anuncios verticales (15-90s) sin saturar memoria del server.
const MAX_VIDEO_MB = 200;

export class AdAnalyzerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly responseBody: string = '',
  ) {
    super(message);
    this.name = 'AdAnalyzerError';
  }
}

const SYSTEM_INSTRUCTION = `You are a forensic ad analyst with expertise in short-form vertical video advertising (TikTok/Reels/Shorts). Your job: watch a vertical ad video and produce a STRUCTURED JSON analysis. Be precise, observational, and faithful to what's on screen — do not invent details.

Output language for string fields: Spanish (neutral, no regionalisms). Even if the ad's narration is in another language, your descriptions and analysis are in Spanish so downstream tools (script suggester, ad ripper) can work coherently.

EXCEPTIONS:
  - fullNarration must be the LITERAL transcript in the ORIGINAL language of the ad.
  - visualStyleProfile.lookDescription must be in ENGLISH (image generators interpret it).
  - visualStyleProfile.realCharactersDescription must be in ENGLISH for the same reason.

RULES:
1. Detect the ad's language from the narration (ISO 639-1: "en", "es", "pt", "fr", etc.).
2. Identify scenes by visual change. A "scene" is a continuous shot with the same composition. Most ads have 8-25 scenes.
3. For each scene, write a SPECIFIC visualDescription: characters' age/gender/clothing/expression, location, objects visible, action happening, color palette.
4. Identify the product if visible: name (if shown), packaging description (color/shape/label), main claim spoken about it.
5. Editorial line = the persuasion mechanic. Describe: hook type, narrative arc, emotional appeal, tone, target audience inferred.
6. Hook type — pick from the enum.
7. CTA — if there's an explicit call to action at the end, transcribe it. Otherwise null.
8. Summary — 1-2 sentences executive summary.

9. **visualStyleProfile** — CRITICAL. This is what makes the rip FAITHFUL vs generic. Observe the actual frames and decide:
   - mediaType: ONE of the enum. If the ad is a TikTok-style mix of UGC + stock footage + medical illustrations + product close-ups, that's 'mixed-hybrid'. If it's purely amateur smartphone, 'ugc-real'. If it's purely watercolor-comic, 'illustration-2d'. Don't default to illustration if the original is photo-real.
   - lookDescription: 30-80 words in ENGLISH, describing the photographic / illustrative LOOK that any image generator should match. Be specific: "phone-shot vertical UGC, handheld selfie, natural indoor lighting, real woman 35-50 talking, no filter, casual bathroom setting" vs "hand-illustrated watercolor sepia comic, painterly brush strokes, warm amber palette, no photo-realism".
   - dominantPalette: 3-6 hex codes of the most dominant colors. Estimate from the frames.
   - textOverlayStyle: if the ad has text overlays (captions, hooks, claims) describe them. backgroundStyle 'solid-box' is the typical TikTok green/yellow background; 'plain' is white text with shadow; 'gradient' is fancy gradient backgrounds. primaryColorHex of the dominant overlay color. If NO overlays, set the whole field to null.
   - realCharactersDescription: if the ad shows REAL humans (not illustrated), describe them in ENGLISH (gender, age, vestuary, environment). If 100% illustrated or no humans, null.
   - aestheticTags: 3-6 free tags. Examples: ["TikTok urgent pacing", "infomercial high-contrast", "split-screen before-after", "anatomical diagram overlay", "talking head selfie"].

Return EXCLUSIVELY this JSON shape:

{
  "language": "<ISO 639-1>",
  "totalDurationSeconds": <number>,
  "fullNarration": "<literal transcript in original language>",
  "narratorProfile": {
    "narratorPresent": <bool>,
    "gender": "male" | "female" | "neutral",
    "ageRange": "<string e.g. 30-40>",
    "characterCard": "<35-60 word visual description of the narrator if visible, else empty>"
  },
  "scenes": [
    {
      "index": <int 0-based>,
      "startSec": <number>,
      "endSec": <number>,
      "visualDescription": "<Spanish, specific>",
      "narrationFragment": "<literal text spoken during this scene, in original language>"
    }
  ],
  "product": {
    "name": "<string or null>",
    "visualDescription": "<Spanish description of what the product looks like, or null>",
    "mainClaim": "<Spanish summary of the main benefit/claim, or null>",
    "isCompetitor": false
  },
  "editorialLine": "<Spanish, 60-120 words, structured explanation of the persuasion mechanic>",
  "hookType": "shock" | "curiosidad" | "autoridad" | "pain-agitation" | "testimonio" | "pregunta-directa" | "beneficio-directo" | "humor" | "misterio" | "otro",
  "cta": "<Spanish translation of CTA or original, null if absent>",
  "summary": "<Spanish, 1-2 sentences>",
  "visualStyleProfile": {
    "mediaType": "ugc-real" | "studio-photo" | "stock-medical" | "mixed-realistic" | "illustration-2d" | "illustration-3d" | "motion-graphics" | "mixed-hybrid",
    "lookDescription": "<30-80 words ENGLISH>",
    "dominantPalette": ["#RRGGBB", "..."],
    "textOverlayStyle": {
      "backgroundStyle": "solid-box" | "gradient" | "outline-only" | "plain" | "shadow" | null,
      "primaryColorHex": "#RRGGBB" | null,
      "textCase": "UPPERCASE" | "Title Case" | "lowercase" | "mixed",
      "position": "top" | "center" | "bottom" | "mixed",
      "fontStyle": "<short string, e.g. 'sans-serif bold heavy'>"
    } | null,
    "realCharactersDescription": "<ENGLISH description or null>",
    "aestheticTags": ["tag1", "tag2", "..."]
  }
}`;

interface VertexAuthCache {
  token: string;
  expiresAtMs: number;
}

let cachedVertexToken: VertexAuthCache | null = null;

async function getVertexToken(): Promise<string> {
  const now = Date.now();
  if (cachedVertexToken && cachedVertexToken.expiresAtMs > now + 60_000) {
    return cachedVertexToken.token;
  }
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp.token) {
    throw new AdAnalyzerError(
      'No se pudo obtener access token de Vertex AI (revisar GOOGLE_APPLICATION_CREDENTIALS)',
    );
  }
  cachedVertexToken = { token: tokenResp.token, expiresAtMs: now + 50 * 60 * 1000 };
  return tokenResp.token;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { code?: number; message?: string };
}

function buildBody(videoBase64: string, mimeType: string, includeRole: boolean): Record<string, unknown> {
  const userContent = {
    parts: [
      { inlineData: { mimeType, data: videoBase64 } },
      {
        text: 'Analyze this ad and return the structured JSON exactly as specified in your system instruction. No extra prose.',
      },
    ],
  };
  return {
    contents: [includeRole ? { role: 'user', ...userContent } : userContent],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
}

async function callVertex(videoBase64: string, mimeType: string): Promise<string> {
  const projectId = process.env['GCP_PROJECT_ID'];
  if (!projectId) {
    throw new AdAnalyzerError('GCP_PROJECT_ID no configurado para Vertex AI Gemini');
  }
  const token = await getVertexToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildBody(videoBase64, mimeType, true)),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new AdAnalyzerError(
      `Vertex Gemini ${resp.status} ${resp.statusText}: ${body.slice(0, 500)}`,
      resp.status,
      body,
    );
  }
  const data = (await resp.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AdAnalyzerError(
      `Vertex Gemini sin texto en la respuesta (finishReason=${data.candidates?.[0]?.finishReason ?? '?'})`,
      200,
      JSON.stringify(data).slice(0, 500),
    );
  }
  return text;
}

async function callAiStudio(videoBase64: string, mimeType: string): Promise<string> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new AdAnalyzerError('GOOGLE_AI_API_KEY no configurado para AI Studio Gemini');
  const url = `${AI_STUDIO_BASE}/models/${VERTEX_MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildBody(videoBase64, mimeType, false)),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new AdAnalyzerError(
      `AI Studio Gemini ${resp.status} ${resp.statusText}: ${body.slice(0, 500)}`,
      resp.status,
      body,
    );
  }
  const data = (await resp.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AdAnalyzerError('AI Studio Gemini sin texto en la respuesta', 200, JSON.stringify(data).slice(0, 500));
  }
  return text;
}

interface FileApiResponse {
  file: {
    name: string;
    uri: string;
    state: 'PROCESSING' | 'ACTIVE' | 'FAILED';
    mimeType: string;
    sizeBytes?: string;
  };
}

// === Helpers GCS + Vertex (PRIMARY para videos grandes) ============
//
// Vertex AI Gemini soporta `fileData.fileUri = "gs://bucket/path"` apuntando a
// un objeto en Google Cloud Storage del mismo proyecto. Esto es la alternativa
// preferida al File API de AI Studio porque:
//   - Vertex usa billing por proyecto (no prepay caps)
//   - El bucket se reusa entre rips (no se sube el video a un nuevo file cada vez)
//   - Permisos automáticos vía service account
//
// Setup mínimo: solo requiere GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS
// (ya configurados). El bucket se crea automáticamente la primera vez.

const GCS_BUCKET_NAME =
  process.env['GCS_BUCKET_NAME'] ??
  (process.env['GCP_PROJECT_ID']
    ? `${process.env['GCP_PROJECT_ID']}-video-factory-rips`
    : null);

const MIME_TO_GCS_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

async function ensureGcsBucket(
  bucketName: string,
  projectId: string,
  token: string,
): Promise<void> {
  const checkResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (checkResp.ok) return; // existe
  if (checkResp.status !== 404) {
    const body = await checkResp.text();
    throw new AdAnalyzerError(
      `GCS check bucket ${checkResp.status}: ${body.slice(0, 300)}`,
      checkResp.status,
      body,
    );
  }
  // Crear bucket en la misma región que Vertex para evitar errores de location mismatch
  const createResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: bucketName,
        location: VERTEX_LOCATION.toUpperCase(),
        storageClass: 'STANDARD',
        // Lifecycle: borra objetos > 7 días para no acumular storage
        lifecycle: {
          rule: [
            {
              action: { type: 'Delete' },
              condition: { age: 7 },
            },
          ],
        },
      }),
    },
  );
  if (!createResp.ok) {
    const body = await createResp.text();
    throw new AdAnalyzerError(
      `GCS create bucket ${createResp.status}: ${body.slice(0, 500)}`,
      createResp.status,
      body,
    );
  }
}

async function uploadToGcs(
  videoBuffer: Buffer,
  mimeType: string,
  projectId: string,
): Promise<{ gsUri: string; bucketName: string; objectName: string }> {
  if (!GCS_BUCKET_NAME) {
    throw new AdAnalyzerError('GCS_BUCKET_NAME inferible sin GCP_PROJECT_ID');
  }
  const bucketName = GCS_BUCKET_NAME;
  const token = await getVertexToken();
  await ensureGcsBucket(bucketName, projectId, token);

  const ext = MIME_TO_GCS_EXT[mimeType] ?? 'bin';
  const objectName = `rips/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  const uploadResp = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType,
      },
      body: new Uint8Array(videoBuffer),
    },
  );
  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new AdAnalyzerError(
      `GCS upload ${uploadResp.status}: ${body.slice(0, 500)}`,
      uploadResp.status,
      body,
    );
  }
  return {
    gsUri: `gs://${bucketName}/${objectName}`,
    bucketName,
    objectName,
  };
}

async function deleteFromGcsBestEffort(
  bucketName: string,
  objectName: string,
): Promise<void> {
  try {
    const token = await getVertexToken();
    await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
  } catch {
    // ignored — el lifecycle rule de 7 días los purga igual
  }
}

async function callVertexWithGcs(gsUri: string, mimeType: string): Promise<string> {
  const projectId = process.env['GCP_PROJECT_ID'];
  if (!projectId) {
    throw new AdAnalyzerError('GCP_PROJECT_ID no configurado para Vertex+GCS');
  }
  const token = await getVertexToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { mimeType, fileUri: gsUri } },
          {
            text: 'Analyze this ad and return the structured JSON exactly as specified in your system instruction. No extra prose.',
          },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text();
    throw new AdAnalyzerError(
      `Vertex Gemini (gcs) ${resp.status} ${resp.statusText}: ${respBody.slice(0, 500)}`,
      resp.status,
      respBody,
    );
  }
  const data = (await resp.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AdAnalyzerError(
      `Vertex Gemini (gcs) sin texto. finishReason=${data.candidates?.[0]?.finishReason ?? '?'}`,
      200,
      JSON.stringify(data).slice(0, 500),
    );
  }
  return text;
}

/**
 * Sube un video al File API de Google AI Studio usando upload resumable.
 *
 * Pasos:
 *   1. POST inicial con metadata → response trae header X-Goog-Upload-URL
 *   2. POST a esa URL con los bytes → response trae { file: { name, uri, state } }
 *   3. Polling de state hasta ACTIVE (típico 5-15s para videos <100MB)
 *
 * Devuelve el `fileUri` listo para usar en `fileData.fileUri` de generateContent.
 * El file se conserva 48h y luego expira automáticamente.
 */
/**
 * Wrapper de fetch con retry exponencial en errores transitorios (5xx, network).
 * Reintenta hasta `maxAttempts` con delay = baseMs * 2^attempt + jitter.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number; baseMs?: number; tag?: string } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseMs = opts.baseMs ?? 1500;
  const tag = opts.tag ?? 'fetch';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      // eslint-disable-next-line no-console
      console.warn(
        `[ad-analyzer] ${tag} reintentando en ${(delay / 1000).toFixed(1)}s (intento ${attempt + 1}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const resp = await fetch(url, init);
      // 5xx → retry. Otros statuses (incluyendo 4xx) → devolver tal cual al caller.
      if (resp.status >= 500 && resp.status < 600) {
        const body = await resp.text();
        lastError = new AdAnalyzerError(
          `${tag} ${resp.status}: ${body.slice(0, 300)}`,
          resp.status,
          body,
        );
        continue;
      }
      return resp;
    } catch (e) {
      // Network error (fetch tira). Reintentamos.
      lastError = e;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new AdAnalyzerError(`${tag}: agotados ${maxAttempts} intentos sin éxito`);
}

async function uploadToFileApi(
  videoBuffer: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<{ fileUri: string; fileName: string }> {
  // Paso 1: init resumable upload (con retry en 5xx)
  const initResp = await fetchWithRetry(
    `${AI_STUDIO_UPLOAD_BASE}/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': videoBuffer.byteLength.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'ad-analysis-source' } }),
    },
    { tag: 'File API init' },
  );
  if (!initResp.ok) {
    const body = await initResp.text();
    throw new AdAnalyzerError(
      `File API init ${initResp.status}: ${body.slice(0, 500)}`,
      initResp.status,
      body,
    );
  }
  const uploadUrl = initResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new AdAnalyzerError('File API no devolvió X-Goog-Upload-URL header');
  }

  // Paso 2: subir los bytes (con retry en 5xx — el body grande igual se manda
  // por fetch, no podemos streamear sin más, pero el buffer se reusa OK)
  const uploadResp = await fetchWithRetry(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Length': videoBuffer.byteLength.toString(),
        'Content-Type': mimeType,
      },
      // Buffer es Uint8Array compatible — fetch acepta como BodyInit en Node 18+
      body: new Uint8Array(videoBuffer),
    },
    { tag: 'File API upload', baseMs: 2000 },
  );
  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new AdAnalyzerError(
      `File API upload ${uploadResp.status}: ${body.slice(0, 500)}`,
      uploadResp.status,
      body,
    );
  }
  const uploadData = (await uploadResp.json()) as FileApiResponse;

  // Paso 3: esperar a que el state sea ACTIVE (Gemini procesa el video antes
  // de poder usarlo en generateContent). Timeout 180s — más que suficiente
  // para videos <200MB.
  const fileName = uploadData.file.name; // formato "files/abc123"
  let state = uploadData.file.state;
  const startMs = Date.now();
  const TIMEOUT_MS = 180_000;
  while (state === 'PROCESSING') {
    if (Date.now() - startMs > TIMEOUT_MS) {
      throw new AdAnalyzerError(
        `File API processing timeout (${TIMEOUT_MS / 1000}s) para ${fileName}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
    const stateResp = await fetch(`${AI_STUDIO_BASE}/${fileName}?key=${apiKey}`);
    if (!stateResp.ok) {
      const body = await stateResp.text();
      throw new AdAnalyzerError(
        `File API state check ${stateResp.status}: ${body.slice(0, 200)}`,
      );
    }
    const stateData = (await stateResp.json()) as FileApiResponse['file'];
    state = stateData.state;
  }
  if (state !== 'ACTIVE') {
    throw new AdAnalyzerError(`File API state inesperado: ${state} para ${fileName}`);
  }

  return { fileUri: uploadData.file.uri, fileName };
}

/**
 * Best-effort delete de un file del File API después de usarlo. No tira si falla
 * (los files expiran a las 48h igual).
 */
async function deleteFileBestEffort(fileName: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${AI_STUDIO_BASE}/${fileName}?key=${apiKey}`, { method: 'DELETE' });
  } catch {
    // ignored
  }
}

/**
 * Llama Gemini con un fileUri (en vez de inline base64). Usa AI Studio porque
 * Vertex requiere GCS bucket aparte (out of scope MVP).
 */
async function callAiStudioWithFile(
  fileUri: string,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const url = `${AI_STUDIO_BASE}/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          { fileData: { mimeType, fileUri } },
          {
            text: 'Analyze this ad and return the structured JSON exactly as specified in your system instruction. No extra prose.',
          },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text();
    throw new AdAnalyzerError(
      `AI Studio Gemini (fileApi) ${resp.status} ${resp.statusText}: ${respBody.slice(0, 500)}`,
      resp.status,
      respBody,
    );
  }
  const data = (await resp.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AdAnalyzerError(
      `AI Studio Gemini (fileApi) sin texto. finishReason=${data.candidates?.[0]?.finishReason ?? '?'}`,
      200,
      JSON.stringify(data).slice(0, 500),
    );
  }
  return text;
}

function isPrepayDepleted(err: unknown): boolean {
  if (!(err instanceof AdAnalyzerError)) return false;
  const haystack = `${err.message}\n${err.responseBody}`;
  return /prepayment|RESOURCE_EXHAUSTED|credits are depleted/i.test(haystack);
}

export interface AnalyzeAdOptions {
  videoPath: string;
  mimeType?: string; // default video/mp4
}

/**
 * Analiza un video de anuncio y devuelve AdAnalysis.
 *
 * Flujo dual según tamaño:
 *   • <= 14 MB → INLINE base64. Vertex Gemini 2.5 Pro primario, AI Studio
 *                fallback si Vertex prepay agotado. Path corto, ~30-60s.
 *   • >  14 MB → FILE API de Google AI Studio. Sube el video al endpoint
 *                /upload/v1beta/files, espera state=ACTIVE, pasa fileUri a
 *                generateContent. Soporta hasta 200 MB (cap propio). +5-20s
 *                extra por upload.
 *
 * Limites del modelo gemini-2.5-pro:
 *   - Hasta ~2 horas de video, pero costs/latencias suben rápido. Recomendado
 *     < 90s para anuncios verticales.
 */
export async function analyzeAd(opts: AnalyzeAdOptions): Promise<AdAnalysis> {
  const videoBuffer = await readFile(opts.videoPath);
  const mb = videoBuffer.byteLength / (1024 * 1024);
  if (mb > MAX_VIDEO_MB) {
    throw new AdAnalyzerError(
      `Video demasiado grande (${mb.toFixed(1)} MB). Máximo ${MAX_VIDEO_MB} MB. Reduce calidad o duración.`,
    );
  }
  const mimeType = opts.mimeType ?? 'video/mp4';

  let rawJson: string;
  if (mb <= INLINE_LIMIT_MB) {
    // PATH RÁPIDO: inline base64 vía Vertex (primary) + AI Studio (fallback prepay)
    const videoBase64 = videoBuffer.toString('base64');
    try {
      rawJson = await callVertex(videoBase64, mimeType);
    } catch (e) {
      if (isPrepayDepleted(e)) {
        // eslint-disable-next-line no-console
        console.warn('[ad-analyzer] Vertex prepay depleted, fallback AI Studio');
        rawJson = await callAiStudio(videoBase64, mimeType);
      } else {
        throw e;
      }
    }
  } else {
    // PATH FILE: para videos > 14 MB.
    //
    // PRIMARY: AI Studio File API (path simple, sin requisitos de GCS).
    //   Funciona con solo GOOGLE_AI_API_KEY. Sujeto a prepay caps de AI Studio.
    //
    // FALLBACK: Vertex AI Gemini + GCS (si AI Studio devuelve prepay-depleted
    //   u otro error de quota). Auto-crea bucket en el proyecto GCP del usuario,
    //   billing por proyecto sin prepay caps. Requiere GCP_PROJECT_ID +
    //   GOOGLE_APPLICATION_CREDENTIALS con permisos de Storage.
    const aiStudioKey = process.env['GOOGLE_AI_API_KEY'];
    const projectId = process.env['GCP_PROJECT_ID'];

    if (aiStudioKey) {
      try {
        // eslint-disable-next-line no-console
        console.info(`[ad-analyzer] Video ${mb.toFixed(1)} MB → AI Studio File API path`);
        const { fileUri, fileName } = await uploadToFileApi(
          videoBuffer,
          mimeType,
          aiStudioKey,
        );
        try {
          rawJson = await callAiStudioWithFile(fileUri, mimeType, aiStudioKey);
        } finally {
          void deleteFileBestEffort(fileName, aiStudioKey);
        }
      } catch (aiStudioErr) {
        // Hacemos fallback a Vertex+GCS si:
        //  - prepay agotado
        //  - rate limit (429) o forbidden (403)
        //  - errores transitorios del servidor (5xx) tras agotar retries del fetchWithRetry
        const shouldFallback =
          isPrepayDepleted(aiStudioErr) ||
          (aiStudioErr instanceof AdAnalyzerError &&
            (aiStudioErr.statusCode === 429 ||
              aiStudioErr.statusCode === 403 ||
              (aiStudioErr.statusCode >= 500 && aiStudioErr.statusCode < 600)));
        if (!shouldFallback || !projectId) throw aiStudioErr;
        // eslint-disable-next-line no-console
        console.warn(
          `[ad-analyzer] AI Studio File API falló (${(aiStudioErr as Error).message.slice(0, 200)}), fallback Vertex+GCS`,
        );
        const { gsUri, bucketName, objectName } = await uploadToGcs(
          videoBuffer,
          mimeType,
          projectId,
        );
        try {
          rawJson = await callVertexWithGcs(gsUri, mimeType);
        } finally {
          void deleteFromGcsBestEffort(bucketName, objectName);
        }
      }
    } else if (projectId) {
      // Sin GOOGLE_AI_API_KEY pero con Vertex: vamos directo Vertex+GCS
      // eslint-disable-next-line no-console
      console.info(`[ad-analyzer] Video ${mb.toFixed(1)} MB → Vertex+GCS path (sin GOOGLE_AI_API_KEY)`);
      const { gsUri, bucketName, objectName } = await uploadToGcs(
        videoBuffer,
        mimeType,
        projectId,
      );
      try {
        rawJson = await callVertexWithGcs(gsUri, mimeType);
      } finally {
        void deleteFromGcsBestEffort(bucketName, objectName);
      }
    } else {
      throw new AdAnalyzerError(
        `Para analizar videos > ${INLINE_LIMIT_MB} MB se necesita GOOGLE_AI_API_KEY (AI Studio File API, preferido) o GCP_PROJECT_ID (Vertex+GCS).`,
      );
    }
  }

  // Parse + validate contra el schema. Si Gemini omite algún field, el parse
  // falla y propagamos error claro al endpoint.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new AdAnalyzerError(
      `Gemini devolvió JSON inválido: ${(e as Error).message}. Body: ${rawJson.slice(0, 500)}`,
    );
  }

  // PARSING TOLERANTE de visualStyleProfile: es un campo NUEVO y Gemini puede
  // inventar valores fuera del enum (ej. "ugc" en vez de "ugc-real"). Si el
  // sub-schema falla, lo droppeamos del objeto antes del parse principal — así
  // el AdAnalysis válido sigue saliendo, y el dynamic-preset-builder usa el
  // path heurístico fallback. NO queremos que un campo nuevo opcional pueda
  // tumbar todo el análisis.
  if (typeof parsed === 'object' && parsed !== null && 'visualStyleProfile' in parsed) {
    const obj = parsed as Record<string, unknown>;
    const profileResult = AdVisualStyleProfileSchema.safeParse(obj.visualStyleProfile);
    if (!profileResult.success) {
      // eslint-disable-next-line no-console
      console.warn(
        '[ad-analyzer] visualStyleProfile inválido, lo dropeamos (fallback heurístico):',
        profileResult.error.errors.slice(0, 3),
      );
      delete obj.visualStyleProfile;
    } else {
      // Reasignamos el parsed con defaults aplicados
      obj.visualStyleProfile = profileResult.data;
    }
  }

  const validated = AdAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AdAnalyzerError(
      `AdAnalysis schema validation falló: ${validated.error.message.slice(0, 500)}`,
    );
  }
  return validated.data;
}
