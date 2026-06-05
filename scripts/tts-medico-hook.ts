// Genera la VOZ EN OFF corregida del HOOK del médico (Camino A del arreglo de audio).
// El clip nativo (medico-hook.mp4) pronunciaba mal ("cara en chaqueta"/"tensión"/
// "ejercicio"). Esta voz en off usa la línea CORRECTA del ad (misma de tts-supercalm)
// con la MISMA voz masculina ES de las otras voces en off del médico → consistencia
// y control total de pronunciación (ES neutro). Salida: storage/proto-key/medico-hook-vo.mp3
// Uso: npx tsx scripts/tts-medico-hook.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';
try {
  const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
    }
  }
} catch {}

const KEY = process.env['ELEVENLABS_API_KEY'];
const OUT = resolve(ROOT, 'storage/proto-key');

// Línea CORRECTA del hook (la misma intención del ad; el clip nativo la dijo mal).
const HOOK_LINE =
  'Sientes la cara hinchada, con una papada marcada y con mucha retención. Entonces tienes que ver este caso que a mí me sorprendió mucho. Escucha atenta.';

async function pickMaleVoice(): Promise<string> {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY! } });
  const j = (await r.json()) as { voices?: Array<{ voice_id: string; name?: string; labels?: Record<string, string> }> };
  const vs = j.voices ?? [];
  const male = vs.find((v) => (v.labels?.['gender'] ?? '').toLowerCase().includes('male'));
  const id = male?.voice_id ?? vs[0]?.voice_id;
  console.log(`voz médico: ${id} (${male?.name ?? 'fallback'})`);
  return id!;
}

async function tts(voiceId: string, text: string, outPath: string): Promise<void> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 160)}`);
  writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('ELEVENLABS_API_KEY no configurada');
  mkdirSync(OUT, { recursive: true });
  const male = await pickMaleVoice();
  const out = resolve(OUT, 'medico-hook-vo.mp3');
  await tts(male, HOOK_LINE, out);
  console.log(`OK → ${out}`);
}
void main();
