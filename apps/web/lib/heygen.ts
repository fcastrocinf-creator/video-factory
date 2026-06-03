// heygen.ts — Proveedor de "cabeza que habla" con LIPSYNC real (HeyGen API v2).
//
// Para el formato "Estilo CapCut" (médico/experto que habla a cámara con lipsync), los
// modelos generales (Kling/Veo) no sirven: deforman la cara o no permiten recortar.
// HeyGen genera un talking-head desde un avatar stock, una foto (talking_photo) o un
// avatar IV, con lipsync a un texto (TTS de HeyGen) o a un audio propio.
//
// Auth: header X-Api-Key (HEYGEN_API_KEY del .env). Estados: pending→processing→completed|failed.
// NOTA DE COSTO: cada generación gasta créditos (~$1/min). Generar SOLO clips cortos hasta validar.

import { readFile } from 'node:fs/promises';

const HEYGEN_BASE = 'https://api.heygen.com';
const HEYGEN_UPLOAD = 'https://upload.heygen.com';

export interface HeyGenGenerateOptions {
  /** Avatar stock (avatar_id) — usa esto O talkingPhotoId. */
  avatarId?: string;
  /** Foto que habla (talking_photo_id) — para una cara propia (ej. el médico). */
  talkingPhotoId?: string;
  avatarStyle?: string; // default 'normal'
  /** Voz: o texto (TTS de HeyGen con voiceId) o un audio propio (audioUrl). */
  text?: string;
  voiceId?: string;
  audioUrl?: string;
  width?: number; // default 720
  height?: number; // default 1280 (9:16)
  apiKey?: string;
}

function key(opts?: { apiKey?: string }): string {
  const k = opts?.apiKey ?? process.env['HEYGEN_API_KEY'];
  if (!k) throw new Error('HEYGEN_API_KEY no configurada');
  return k;
}

/** Inicia la generación. Devuelve el videoId (la generación corre async en HeyGen). */
export async function generateHeyGenVideo(opts: HeyGenGenerateOptions): Promise<string> {
  const character = opts.talkingPhotoId
    ? { type: 'talking_photo', talking_photo_id: opts.talkingPhotoId }
    : { type: 'avatar', avatar_id: opts.avatarId, avatar_style: opts.avatarStyle ?? 'normal' };
  const voice = opts.audioUrl
    ? { type: 'audio', audio_url: opts.audioUrl }
    : { type: 'text', input_text: opts.text ?? '', voice_id: opts.voiceId };
  const body = {
    video_inputs: [{ character, voice }],
    dimension: { width: opts.width ?? 720, height: opts.height ?? 1280 },
  };
  const resp = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: 'POST',
    headers: { 'X-Api-Key': key(opts), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => ({}))) as { data?: { video_id?: string }; video_id?: string; message?: string; error?: unknown };
  if (!resp.ok) {
    throw new Error(`HeyGen generate ${resp.status}: ${JSON.stringify(json)}`);
  }
  const id = json.data?.video_id ?? json.video_id;
  if (!id) throw new Error(`HeyGen sin video_id: ${JSON.stringify(json)}`);
  return id;
}

export interface HeyGenStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  videoUrl?: string;
  error?: unknown;
}

export async function getHeyGenVideoStatus(videoId: string, opts?: { apiKey?: string }): Promise<HeyGenStatus> {
  const resp = await fetch(`${HEYGEN_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
    headers: { 'X-Api-Key': key(opts) },
  });
  const json = (await resp.json().catch(() => ({}))) as { data?: { status?: string; video_url?: string; error?: unknown } };
  return { status: json.data?.status ?? 'unknown', videoUrl: json.data?.video_url, error: json.data?.error };
}

/** Genera y espera (poll con backoff) hasta completed/failed. Devuelve la URL del video. */
export async function generateHeyGenVideoAndWait(
  opts: HeyGenGenerateOptions & { maxWaitSec?: number; onPoll?: (s: HeyGenStatus, i: number) => void },
): Promise<{ videoId: string; videoUrl: string }> {
  const videoId = await generateHeyGenVideo(opts);
  const maxWait = opts.maxWaitSec ?? 360;
  const start = Date.now();
  let i = 0;
  while ((Date.now() - start) / 1000 < maxWait) {
    await new Promise((r) => setTimeout(r, 8000));
    const st = await getHeyGenVideoStatus(videoId, opts);
    opts.onPoll?.(st, i++);
    if (st.status === 'completed' && st.videoUrl) return { videoId, videoUrl: st.videoUrl };
    if (st.status === 'failed') throw new Error(`HeyGen falló: ${JSON.stringify(st.error)}`);
  }
  throw new Error(`HeyGen timeout tras ${maxWait}s (video_id ${videoId})`);
}

/**
 * Sube una FOTO propia a HeyGen → devuelve talking_photo_id (para animar una cara
 * propia, ej. el médico generado). Endpoint de upload con bytes crudos.
 */
export async function uploadTalkingPhoto(imagePath: string, opts?: { apiKey?: string }): Promise<string> {
  const bytes = await readFile(imagePath);
  const lower = imagePath.toLowerCase();
  const contentType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const resp = await fetch(`${HEYGEN_UPLOAD}/v1/talking_photo`, {
    method: 'POST',
    headers: { 'X-Api-Key': key(opts), 'Content-Type': contentType },
    body: bytes,
  });
  const json = (await resp.json().catch(() => ({}))) as {
    data?: { talking_photo_id?: string; id?: string };
    message?: string;
  };
  if (!resp.ok) throw new Error(`HeyGen upload ${resp.status}: ${JSON.stringify(json)}`);
  const id = json.data?.talking_photo_id ?? json.data?.id;
  if (!id) throw new Error(`HeyGen upload sin talking_photo_id: ${JSON.stringify(json)}`);
  return id;
}

export interface HeyGenVoice {
  voiceId: string;
  language: string;
  gender: string;
  name: string;
}

/** Lista las voces disponibles (para elegir, ej. una voz ES masculina). */
export async function listHeyGenVoices(opts?: { apiKey?: string }): Promise<HeyGenVoice[]> {
  const resp = await fetch(`${HEYGEN_BASE}/v2/voices`, { headers: { 'X-Api-Key': key(opts) } });
  const json = (await resp.json().catch(() => ({}))) as {
    data?: { voices?: Array<{ voice_id: string; language?: string; gender?: string; name?: string }> };
  };
  if (!resp.ok) throw new Error(`HeyGen voices ${resp.status}: ${JSON.stringify(json)}`);
  return (json.data?.voices ?? []).map((v) => ({
    voiceId: v.voice_id,
    language: v.language ?? '',
    gender: v.gender ?? '',
    name: v.name ?? '',
  }));
}
