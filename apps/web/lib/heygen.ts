// heygen.ts — Proveedor de "cabeza que habla" con LIPSYNC real (HeyGen API v2).
//
// Para el formato "Estilo CapCut" (médico/experto que habla a cámara con lipsync), los
// modelos generales (Kling/Veo) no sirven: deforman la cara o no permiten recortar.
// HeyGen genera un talking-head desde un avatar stock, una foto (talking_photo) o un
// avatar IV, con lipsync a un texto (TTS de HeyGen) o a un audio propio.
//
// Auth: header X-Api-Key (HEYGEN_API_KEY del .env). Estados: pending→processing→completed|failed.
// NOTA DE COSTO: cada generación gasta créditos (~$1/min). Generar SOLO clips cortos hasta validar.

const HEYGEN_BASE = 'https://api.heygen.com';

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
