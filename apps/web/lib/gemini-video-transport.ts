// gemini-video-transport.ts — TRANSPORTE Gemini video+audio GENERALIZADO (FASE 2).
//
// Extracción del transporte dual de ad-analyzer.ts, generalizado a N partes de
// video (1..2 en la práctica: analyzeAd pasa 1; el juez render+original pasa 1-2)
// con systemInstruction/userText parametrizables. Devuelve el TEXTO crudo (NO
// parsea: el caller decide el schema).
//
// Reusa TAL CUAL la lógica probada de analyzeAd:
//   - Decide inline (≤14 MB AGREGADO) vs File API por tamaño SUMADO de las partes.
//   - Cascada inline:  Vertex (primary) → AI Studio (fallback si prepay agotado).
//   - Cascada file:    AI Studio File API (primary) → Vertex+GCS (fallback).
//   - Modelo gemini-2.5-pro, temperature 0, responseMimeType application/json.
//   - Cleanup best-effort de cada file/objeto subido.
//
// Mismas env que ad-analyzer: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS,
// GOOGLE_AI_API_KEY, GCP_LOCATION, GCS_BUCKET_NAME. NO duplica credenciales.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';
import { findFfmpegPath } from './ffmpeg-locator';

const VERTEX_LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';
const VERTEX_MODEL = 'gemini-2.5-pro';
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const AI_STUDIO_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

// Mismos umbrales que ad-analyzer, pero evaluados sobre la SUMA de las partes.
// Render+original casi siempre > 14 MB ⇒ entra por File API.
const INLINE_LIMIT_MB = 14;
const MAX_VIDEO_MB = 200;

/** Error del transporte. Re-exportado como GeminiTransportError (alias estable). */
export class AdAnalyzerError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number = 500, responseBody: string = '') {
    super(message);
    this.name = 'GeminiTransportError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
export { AdAnalyzerError as GeminiTransportError };

export interface GeminiVideoPart {
  videoPath: string;
  /** Default 'video/mp4'. */
  mimeType?: string;
  /** Etiqueta legible (ej 'RENDER', 'ORIGINAL') — para logs; no se envía a Gemini. */
  label?: string;
}

export interface GeminiGenerateOptions {
  /** 1..2 partes de video (orden significativo: el caller decide qué es qué). */
  videos: GeminiVideoPart[];
  systemInstruction: string;
  userText: string;
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { code?: number; message?: string };
}

interface LoadedVideo {
  buffer: Buffer;
  mimeType: string;
  label: string;
  mb: number;
}

// ─── Token Vertex (cacheado) ────────────────────────────────────────────────────

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
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
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

// ─── ffprobe: duración exacta (ancla anti-alucinación) ──────────────────────────

/** Detecta la duración exacta del video con ffprobe local. null si falla. */
export async function probeVideoDurationSec(videoPath: string): Promise<number | null> {
  const ffmpegBin = findFfmpegPath();
  const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  return new Promise((resolveFn) => {
    let stdout = '';
    const proc = spawn(
      ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.on('close', () => {
      const n = parseFloat(stdout.trim());
      resolveFn(Number.isFinite(n) && n > 0 ? n : null);
    });
    proc.on('error', () => resolveFn(null));
  });
}

// ─── Construcción de partes (N videos + texto) ──────────────────────────────────

function buildGenerationConfig(opts: GeminiGenerateOptions): Record<string, unknown> {
  return {
    responseMimeType: 'application/json',
    temperature: opts.generationConfig?.temperature ?? 0,
    maxOutputTokens: opts.generationConfig?.maxOutputTokens ?? 65536,
  };
}

/**
 * Marcador de texto que se antepone a CADA video para que Gemini sepa qué es qué.
 * El orden posicional por sí solo es frágil: si el modelo invierte la lectura,
 * juzgaría el original como si fuera el render. Anteponer "VIDEO N (LABEL):" ancla
 * la identidad de cada parte. La label (RENDER/ORIGINAL) la decide el caller.
 */
function videoMarker(index: number, label: string): string {
  return `VIDEO ${index + 1} (${label}):`;
}

/** Partes inline: por cada video → [text marcador, inlineData(base64)]; + 1 text final. */
function buildInlineParts(videos: LoadedVideo[], userText: string): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  videos.forEach((v, i) => {
    parts.push({ text: videoMarker(i, v.label) });
    parts.push({ inlineData: { mimeType: v.mimeType, data: v.buffer.toString('base64') } });
  });
  parts.push({ text: userText });
  return parts;
}

/** Partes file: por cada video → [text marcador, fileData(uri)]; + 1 text final. */
function buildFileParts(
  files: Array<{ mimeType: string; fileUri: string; label: string }>,
  userText: string,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  files.forEach((f, i) => {
    parts.push({ text: videoMarker(i, f.label) });
    parts.push({ fileData: { mimeType: f.mimeType, fileUri: f.fileUri } });
  });
  parts.push({ text: userText });
  return parts;
}

function extractText(data: GenerateContentResponse, tag: string): string {
  // Gemini 2.5 Pro puede PARTIR el JSON en varias parts o anteponer una parte
  // "thinking": leer solo parts[0] lanzaría "sin texto" aunque el JSON sí llegó en
  // parts[1+]. Concatenamos el texto de TODAS las partes.
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('') || undefined;
  if (!text) {
    throw new AdAnalyzerError(
      `${tag} sin texto en la respuesta (finishReason=${data.candidates?.[0]?.finishReason ?? '?'})`,
      200,
      JSON.stringify(data).slice(0, 500),
    );
  }
  return text;
}

// ─── Llamadas inline (Vertex primary, AI Studio fallback) ───────────────────────

async function callVertexInline(videos: LoadedVideo[], opts: GeminiGenerateOptions): Promise<string> {
  const projectId = process.env['GCP_PROJECT_ID'];
  if (!projectId) throw new AdAnalyzerError('GCP_PROJECT_ID no configurado para Vertex AI Gemini');
  const token = await getVertexToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: buildInlineParts(videos, opts.userText) }],
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    generationConfig: buildGenerationConfig(opts),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text();
    throw new AdAnalyzerError(
      `Vertex Gemini ${resp.status} ${resp.statusText}: ${respBody.slice(0, 500)}`,
      resp.status,
      respBody,
    );
  }
  return extractText((await resp.json()) as GenerateContentResponse, 'Vertex Gemini');
}

async function callAiStudioInline(videos: LoadedVideo[], opts: GeminiGenerateOptions): Promise<string> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) throw new AdAnalyzerError('GOOGLE_AI_API_KEY no configurado para AI Studio Gemini');
  const url = `${AI_STUDIO_BASE}/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: buildInlineParts(videos, opts.userText) }],
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    generationConfig: buildGenerationConfig(opts),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const respBody = await resp.text();
    throw new AdAnalyzerError(
      `AI Studio Gemini ${resp.status} ${resp.statusText}: ${respBody.slice(0, 500)}`,
      resp.status,
      respBody,
    );
  }
  return extractText((await resp.json()) as GenerateContentResponse, 'AI Studio Gemini');
}

// ─── File API de AI Studio (upload resumable + poll ACTIVE) ─────────────────────

interface FileApiResponse {
  file: { name: string; uri: string; state: 'PROCESSING' | 'ACTIVE' | 'FAILED'; mimeType: string };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  o: { maxAttempts?: number; baseMs?: number; tag?: string } = {},
): Promise<Response> {
  const maxAttempts = o.maxAttempts ?? 4;
  const baseMs = o.baseMs ?? 1500;
  const tag = o.tag ?? 'fetch';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      // eslint-disable-next-line no-console
      console.warn(
        `[gemini-transport] ${tag} reintentando en ${(delay / 1000).toFixed(1)}s (intento ${attempt + 1}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const resp = await fetch(url, init);
      if (resp.status >= 500 && resp.status < 600) {
        const body = await resp.text();
        lastError = new AdAnalyzerError(`${tag} ${resp.status}: ${body.slice(0, 300)}`, resp.status, body);
        continue;
      }
      return resp;
    } catch (e) {
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
      body: JSON.stringify({ file: { display_name: 'gemini-video-part' } }),
    },
    { tag: 'File API init' },
  );
  if (!initResp.ok) {
    const body = await initResp.text();
    throw new AdAnalyzerError(`File API init ${initResp.status}: ${body.slice(0, 500)}`, initResp.status, body);
  }
  const uploadUrl = initResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new AdAnalyzerError('File API no devolvió X-Goog-Upload-URL header');

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
      body: new Uint8Array(videoBuffer),
    },
    { tag: 'File API upload', baseMs: 2000 },
  );
  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new AdAnalyzerError(`File API upload ${uploadResp.status}: ${body.slice(0, 500)}`, uploadResp.status, body);
  }
  const uploadData = (await uploadResp.json()) as FileApiResponse;

  const fileName = uploadData.file.name;
  let state = uploadData.file.state;
  const startMs = Date.now();
  const TIMEOUT_MS = 180_000;
  while (state === 'PROCESSING') {
    if (Date.now() - startMs > TIMEOUT_MS) {
      throw new AdAnalyzerError(`File API processing timeout (${TIMEOUT_MS / 1000}s) para ${fileName}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
    const stateResp = await fetch(`${AI_STUDIO_BASE}/${fileName}?key=${apiKey}`);
    if (!stateResp.ok) {
      const body = await stateResp.text();
      throw new AdAnalyzerError(`File API state check ${stateResp.status}: ${body.slice(0, 200)}`);
    }
    const stateData = (await stateResp.json()) as FileApiResponse['file'];
    state = stateData.state;
  }
  if (state !== 'ACTIVE') throw new AdAnalyzerError(`File API state inesperado: ${state} para ${fileName}`);
  return { fileUri: uploadData.file.uri, fileName };
}

async function deleteFileBestEffort(fileName: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${AI_STUDIO_BASE}/${fileName}?key=${apiKey}`, { method: 'DELETE' });
  } catch {
    // ignored — los files expiran a las 48h igual
  }
}

async function callAiStudioWithFiles(
  files: Array<{ mimeType: string; fileUri: string; label: string }>,
  opts: GeminiGenerateOptions,
  apiKey: string,
): Promise<string> {
  const url = `${AI_STUDIO_BASE}/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [{ parts: buildFileParts(files, opts.userText) }],
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    generationConfig: buildGenerationConfig(opts),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
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
  return extractText((await resp.json()) as GenerateContentResponse, 'AI Studio Gemini (fileApi)');
}

// ─── Vertex + GCS (fallback para File API) ──────────────────────────────────────

const GCS_BUCKET_NAME =
  process.env['GCS_BUCKET_NAME'] ??
  (process.env['GCP_PROJECT_ID'] ? `${process.env['GCP_PROJECT_ID']}-video-factory-rips` : null);

const MIME_TO_GCS_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

async function ensureGcsBucket(bucketName: string, projectId: string, token: string): Promise<void> {
  const checkResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (checkResp.ok) return;
  if (checkResp.status !== 404) {
    const body = await checkResp.text();
    throw new AdAnalyzerError(`GCS check bucket ${checkResp.status}: ${body.slice(0, 300)}`, checkResp.status, body);
  }
  const createResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bucketName,
        location: VERTEX_LOCATION.toUpperCase(),
        storageClass: 'STANDARD',
        lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] },
      }),
    },
  );
  if (!createResp.ok) {
    const body = await createResp.text();
    throw new AdAnalyzerError(`GCS create bucket ${createResp.status}: ${body.slice(0, 500)}`, createResp.status, body);
  }
}

async function uploadToGcs(
  videoBuffer: Buffer,
  mimeType: string,
  projectId: string,
): Promise<{ gsUri: string; bucketName: string; objectName: string }> {
  if (!GCS_BUCKET_NAME) throw new AdAnalyzerError('GCS_BUCKET_NAME inferible sin GCP_PROJECT_ID');
  const bucketName = GCS_BUCKET_NAME;
  const token = await getVertexToken();
  await ensureGcsBucket(bucketName, projectId, token);
  const ext = MIME_TO_GCS_EXT[mimeType] ?? 'bin';
  const objectName = `rips/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const uploadResp = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
      body: new Uint8Array(videoBuffer),
    },
  );
  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new AdAnalyzerError(`GCS upload ${uploadResp.status}: ${body.slice(0, 500)}`, uploadResp.status, body);
  }
  return { gsUri: `gs://${bucketName}/${objectName}`, bucketName, objectName };
}

async function deleteFromGcsBestEffort(bucketName: string, objectName: string): Promise<void> {
  try {
    const token = await getVertexToken();
    await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    // ignored — el lifecycle de 7 días los purga igual
  }
}

async function callVertexWithGcs(
  files: Array<{ mimeType: string; fileUri: string; label: string }>,
  opts: GeminiGenerateOptions,
): Promise<string> {
  const projectId = process.env['GCP_PROJECT_ID'];
  if (!projectId) throw new AdAnalyzerError('GCP_PROJECT_ID no configurado para Vertex+GCS');
  const token = await getVertexToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: buildFileParts(files, opts.userText) }],
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    generationConfig: buildGenerationConfig(opts),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  return extractText((await resp.json()) as GenerateContentResponse, 'Vertex Gemini (gcs)');
}

function isPrepayDepleted(err: unknown): boolean {
  if (!(err instanceof AdAnalyzerError)) return false;
  const haystack = `${err.message}\n${err.responseBody}`;
  return /prepayment|RESOURCE_EXHAUSTED|credits are depleted/i.test(haystack);
}

// ─── API pública: generateContentFromVideos ─────────────────────────────────────

/**
 * Llama a Gemini con N partes de video (imagen+audio) + systemInstruction/userText.
 * Decide inline vs File API por el tamaño AGREGADO. Devuelve el TEXTO crudo.
 *
 * Cascadas (idénticas a analyzeAd):
 *   inline (≤14 MB total): Vertex → AI Studio (fallback prepay).
 *   file  (>14 MB total):  AI Studio File API → Vertex+GCS (fallback). Cleanup por parte.
 */
export async function generateContentFromVideos(opts: GeminiGenerateOptions): Promise<string> {
  if (!opts.videos || opts.videos.length === 0) {
    throw new AdAnalyzerError('generateContentFromVideos requiere al menos 1 video');
  }

  // Cargar todas las partes y medir el tamaño agregado.
  const loaded: LoadedVideo[] = [];
  let totalMb = 0;
  for (const v of opts.videos) {
    const buffer = await readFile(v.videoPath);
    const mb = buffer.byteLength / (1024 * 1024);
    totalMb += mb;
    loaded.push({ buffer, mimeType: v.mimeType ?? 'video/mp4', label: v.label ?? v.videoPath, mb });
  }
  if (totalMb > MAX_VIDEO_MB) {
    throw new AdAnalyzerError(
      `Videos demasiado grandes (${totalMb.toFixed(1)} MB agregados). Máximo ${MAX_VIDEO_MB} MB.`,
    );
  }

  // PATH INLINE: suma ≤ 14 MB. Vertex primary, AI Studio fallback (prepay).
  if (totalMb <= INLINE_LIMIT_MB) {
    try {
      return await callVertexInline(loaded, opts);
    } catch (e) {
      if (isPrepayDepleted(e)) {
        // eslint-disable-next-line no-console
        console.warn('[gemini-transport] Vertex prepay depleted, fallback AI Studio');
        return await callAiStudioInline(loaded, opts);
      }
      throw e;
    }
  }

  // PATH FILE: suma > 14 MB. AI Studio File API primary, Vertex+GCS fallback.
  const aiStudioKey = process.env['GOOGLE_AI_API_KEY'];
  const projectId = process.env['GCP_PROJECT_ID'];

  if (aiStudioKey) {
    const uploaded: Array<{ fileName: string }> = [];
    try {
      // eslint-disable-next-line no-console
      console.info(`[gemini-transport] ${loaded.length} video(s) ${totalMb.toFixed(1)} MB → AI Studio File API`);
      const files: Array<{ mimeType: string; fileUri: string; label: string }> = [];
      for (const v of loaded) {
        const { fileUri, fileName } = await uploadToFileApi(v.buffer, v.mimeType, aiStudioKey);
        files.push({ mimeType: v.mimeType, fileUri, label: v.label });
        uploaded.push({ fileName });
      }
      return await callAiStudioWithFiles(files, opts, aiStudioKey);
    } catch (aiStudioErr) {
      const shouldFallback =
        isPrepayDepleted(aiStudioErr) ||
        (aiStudioErr instanceof AdAnalyzerError &&
          (aiStudioErr.statusCode === 429 ||
            aiStudioErr.statusCode === 403 ||
            (aiStudioErr.statusCode >= 500 && aiStudioErr.statusCode < 600)));
      if (!shouldFallback || !projectId) throw aiStudioErr;
      // eslint-disable-next-line no-console
      console.warn(
        `[gemini-transport] AI Studio File API falló (${(aiStudioErr as Error).message.slice(0, 200)}), fallback Vertex+GCS`,
      );
      return await viaVertexGcs(loaded, opts, projectId);
    } finally {
      for (const u of uploaded) void deleteFileBestEffort(u.fileName, aiStudioKey);
    }
  } else if (projectId) {
    // eslint-disable-next-line no-console
    console.info(`[gemini-transport] ${loaded.length} video(s) ${totalMb.toFixed(1)} MB → Vertex+GCS (sin GOOGLE_AI_API_KEY)`);
    return await viaVertexGcs(loaded, opts, projectId);
  }
  throw new AdAnalyzerError(
    `Para videos > ${INLINE_LIMIT_MB} MB (agregados) se necesita GOOGLE_AI_API_KEY (AI Studio File API) o GCP_PROJECT_ID (Vertex+GCS).`,
  );
}

/** Sube las partes a GCS, llama Vertex con los gs:// y limpia los objetos. */
async function viaVertexGcs(
  loaded: LoadedVideo[],
  opts: GeminiGenerateOptions,
  projectId: string,
): Promise<string> {
  const objects: Array<{ bucketName: string; objectName: string }> = [];
  try {
    const files: Array<{ mimeType: string; fileUri: string; label: string }> = [];
    for (const v of loaded) {
      const { gsUri, bucketName, objectName } = await uploadToGcs(v.buffer, v.mimeType, projectId);
      files.push({ mimeType: v.mimeType, fileUri: gsUri, label: v.label });
      objects.push({ bucketName, objectName });
    }
    return await callVertexWithGcs(files, opts);
  } finally {
    for (const o of objects) void deleteFromGcsBestEffort(o.bucketName, o.objectName);
  }
}
