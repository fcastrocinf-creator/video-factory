// Fase 1 del "idéntico 20s": genera las VOCES exactas con ElevenLabs.
// médico (voz masculina ES) + Rosa (voz femenina ES). Líneas literales del original.
// Uso: npx tsx scripts/tts-supercalm.ts
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
const OUT = resolve(ROOT, 'storage/proto-sc20');

const LINES = [
  { id: 'medico-hook', gender: 'male', text: 'Sientes la cara hinchada, con una papada marcada y con mucha retención. Entonces tienes que ver este caso que a mí me sorprendió mucho. Escucha atenta.' },
  { id: 'rosa-dia1', gender: 'female', text: 'Hola doctor, este es mi primer día antes de usar Nello. Le mandaré el otro video en siete días más.' },
  { id: 'medico-explain', gender: 'male', text: 'Así es como recibí a Rosa en la consulta. Les quiero explicar la situación. Aquí podemos observar dos cosas impactantes: sus ojeras y su papada marcada, tal cual como te muestro.' },
];

async function pickVoices(): Promise<{ male: string; female: string }> {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY! } });
  const j = (await r.json()) as { voices?: Array<{ voice_id: string; name?: string; labels?: Record<string, string> }> };
  const vs = j.voices ?? [];
  const byGender = (g: string) => vs.find((v) => (v.labels?.['gender'] ?? '').toLowerCase().includes(g));
  const male = byGender('male')?.voice_id ?? vs[0]?.voice_id;
  const female = byGender('female')?.voice_id ?? vs[1]?.voice_id ?? vs[0]?.voice_id;
  console.log(`voces: male=${male} (${byGender('male')?.name}) · female=${female} (${byGender('female')?.name}) · total ${vs.length}`);
  return { male: male!, female: female! };
}

async function tts(voiceId: string, text: string, outPath: string): Promise<void> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 120)}`);
  writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('ELEVENLABS_API_KEY no configurada');
  mkdirSync(OUT, { recursive: true });
  const { male, female } = await pickVoices();
  for (const l of LINES) {
    const voice = l.gender === 'male' ? male : female;
    const out = resolve(OUT, `${l.id}.mp3`);
    await tts(voice, l.text, out);
    console.log(`OK ${l.id}.mp3 (${l.gender})`);
  }
  console.log(`Listo → ${OUT}`);
}
void main();
