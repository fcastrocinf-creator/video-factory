// TTS de UNA línea con ElevenLabs (reutilizable). Voz masculina o femenina ES.
// Uso: npx tsx scripts/tts-one.ts "<texto>" <male|female> <outPath.mp3>
import { readFileSync, writeFileSync } from 'node:fs';
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

async function pickVoice(gender: string): Promise<string> {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY! } });
  const j = (await r.json()) as { voices?: Array<{ voice_id: string; labels?: Record<string, string> }> };
  const vs = j.voices ?? [];
  const v = vs.find((x) => (x.labels?.['gender'] ?? '').toLowerCase().includes(gender)) ?? vs[0];
  return v!.voice_id;
}

async function main(): Promise<void> {
  const [, , text, gender = 'female', out] = process.argv;
  if (!text || !out) {
    console.error('uso: tsx scripts/tts-one.ts "<texto>" <male|female> <out.mp3>');
    process.exit(2);
    return;
  }
  if (!KEY) throw new Error('ELEVENLABS_API_KEY no configurada');
  const voiceId = await pickVoice(gender);
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 120)}`);
  writeFileSync(resolve(out), Buffer.from(await r.arrayBuffer()));
  console.log(`OK → ${out} (voz ${gender} ${voiceId})`);
}
void main();
