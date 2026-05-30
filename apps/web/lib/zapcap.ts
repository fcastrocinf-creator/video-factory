// Cliente de ZapCap — subtítulos automáticos estilo CapCut.
//
// Flujo: subir video (POST /videos) -> crear tarea con un template + estilo
// (POST /videos/{id}/task) -> poll del estado (GET /videos/{id}/task/{taskId})
// hasta que termina -> descargar el MP4 con subtítulos quemados.
//
// La API key vive en .env (ZAPCAP_API_KEY) — NUNCA en el repo.
// Docs: https://platform.zapcap.ai/docs

import { readFile, writeFile } from 'node:fs/promises';

const ZAPCAP_BASE = 'https://api.zapcap.ai';

// Templates reales (obtenidos de GET /templates). El owner puede elegir.
export const ZAPCAP_TEMPLATES: Array<{ id: string; name: string }> = [
  { id: 'decf5309-2094-4257-a646-cabe1f1ba89a', name: 'Hormozi 3 (animado, viral)' },
  { id: 'e7e758de-4eb4-460f-aeca-b2801ac7f8cc', name: 'Ella (animado, resaltado)' },
  { id: '982ad276-a76f-4d80-a4e2-b8fae0038464', name: 'Luke (limpio, resaltado)' },
  { id: '07ffd4b8-4e1a-4ee3-8921-d58802953bcd', name: 'Celine' },
  { id: '7b946549-ae16-4085-9dd3-c20c82504daa', name: 'Maya' },
];
export const DEFAULT_TEMPLATE_ID = 'decf5309-2094-4257-a646-cabe1f1ba89a'; // Hormozi 3

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

function getApiKey(): string {
  const k = process.env['ZAPCAP_API_KEY'];
  if (!k || k.startsWith('tu-api-key')) {
    throw new Error('ZAPCAP_API_KEY no configurada en .env');
  }
  return k;
}

export function isZapcapConfigured(): boolean {
  const k = process.env['ZAPCAP_API_KEY'];
  return Boolean(k && !k.startsWith('tu-api-key'));
}

async function uploadVideo(filePath: string, logger?: Logger): Promise<string> {
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'video/mp4' }), 'video.mp4');
  const r = await fetch(`${ZAPCAP_BASE}/videos`, {
    method: 'POST',
    headers: { 'x-api-key': getApiKey() },
    body: form,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ZapCap upload ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { id?: string; videoId?: string };
  const id = j.id ?? j.videoId;
  if (!id) throw new Error(`ZapCap upload sin id: ${text.slice(0, 200)}`);
  logger?.info({ zapcapVideoId: id }, 'zapcap:uploaded');
  return id;
}

async function createTask(
  videoId: string,
  templateId: string,
  fontUppercase: boolean,
  logger?: Logger,
): Promise<string> {
  const r = await fetch(`${ZAPCAP_BASE}/videos/${videoId}/task`, {
    method: 'POST',
    headers: { 'x-api-key': getApiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId,
      autoApprove: true,
      language: 'es',
      renderOptions: {
        subsOptions: { emoji: false, animation: true, emphasizeKeywords: true, punctuation: true },
        styleOptions: { fontUppercase, fontSize: 46 },
      },
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ZapCap task ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { taskId?: string; id?: string };
  const taskId = j.taskId ?? j.id;
  if (!taskId) throw new Error(`ZapCap task sin taskId: ${text.slice(0, 200)}`);
  logger?.info({ zapcapTaskId: taskId, templateId, fontUppercase }, 'zapcap:task_created');
  return taskId;
}

async function pollTask(videoId: string, taskId: string, logger?: Logger): Promise<string> {
  // Render de un video corto ~30-120s. Poll cada 4s, hasta ~6 min.
  for (let i = 0; i < 90; i++) {
    const r = await fetch(`${ZAPCAP_BASE}/videos/${videoId}/task/${taskId}`, {
      headers: { 'x-api-key': getApiKey() },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ZapCap status ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { status?: string; downloadUrl?: string; url?: string };
    const status = (j.status ?? '').toLowerCase();
    const url = j.downloadUrl ?? j.url;
    if ((status === 'completed' || status === 'done') && url) return url;
    if (status === 'failed' || status === 'error') {
      throw new Error(`ZapCap render falló: ${text.slice(0, 200)}`);
    }
    logger?.info({ videoId, taskId, status, attempt: i }, 'zapcap:polling');
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error('ZapCap: timeout esperando el render (>6min)');
}

/**
 * Sube `videoPath` a ZapCap, le pone subtítulos con `templateId`/`fontUppercase`,
 * y descarga el MP4 resultante en `outPath`. Devuelve la ruta del archivo.
 */
export async function addCaptions(opts: {
  videoPath: string;
  outPath: string;
  templateId?: string;
  fontUppercase?: boolean;
  logger?: Logger;
}): Promise<{ outPath: string }> {
  const videoId = await uploadVideo(opts.videoPath, opts.logger);
  const taskId = await createTask(
    videoId,
    opts.templateId ?? DEFAULT_TEMPLATE_ID,
    opts.fontUppercase ?? false,
    opts.logger,
  );
  const url = await pollTask(videoId, taskId, opts.logger);
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`ZapCap download ${dl.status}`);
  const out = Buffer.from(await dl.arrayBuffer());
  await writeFile(opts.outPath, out);
  opts.logger?.info({ outPath: opts.outPath, bytes: out.length }, 'zapcap:done');
  return { outPath: opts.outPath };
}
