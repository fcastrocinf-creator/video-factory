// Multi-voz: sintetiza el guión del ad del médico con 2 voces (ElevenLabs) y concatena.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Cargar ELEVENLABS_API_KEY del .env raíz.
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
    }
  }
} catch {}

import { ElevenLabsClient } from '../packages/blocks/tts-elevenlabs/src/client';
import { getVideoDurationSec } from '../apps/web/lib/frame-extractor';

const FF =
  'C:\\Users\\cmktc\\proyectos\\video-factory\\node_modules\\.pnpm\\@remotion+compositor-win32-x64-msvc@4.0.462\\node_modules\\@remotion\\compositor-win32-x64-msvc\\ffmpeg.exe';
const base = resolve(process.cwd(), 'storage', 'proto-composite');

// Voces de Vitaly (vitaly.brand.json). 2 distintas para los 2 hablantes.
const VOICE_WOMAN = 'hpp4J3VqNfWAUOO0d1Us'; // defaultVoice (usuaria/tester)
const VOICE_DOCTOR = 'JBFqnCBsd6RMkjVDRZzb'; // voiceLibrary[0] (autoridad)

const SCRIPT = [
  { sp: 'woman', voice: VOICE_WOMAN, text: 'Tenía la cara súper hinchada y una papada que no se me iba con nada.' },
  { sp: 'doctor', voice: VOICE_DOCTOR, text: 'Es retención de líquido. Las gotas de drenaje linfático de Vitaly la desinflaman en pocos días.' },
  { sp: 'woman', voice: VOICE_WOMAN, text: 'Las usé una semana y mira la diferencia. Increíble.' },
];

async function main(): Promise<void> {
  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) {
    console.log('sin ELEVENLABS_API_KEY');
    return;
  }
  const client = new ElevenLabsClient({ apiKey });
  const files: string[] = [];
  const durations: number[] = [];
  for (let i = 0; i < SCRIPT.length; i++) {
    const buf = await client.synthesize({
      voiceId: SCRIPT[i]!.voice,
      modelId: 'eleven_multilingual_v2',
      text: SCRIPT[i]!.text,
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
    });
    const f = join(base, `line_${i}.mp3`);
    writeFileSync(f, buf);
    files.push(f);
    const d = (await getVideoDurationSec(f)) ?? 0;
    durations.push(d);
    console.log(`linea ${i} [${SCRIPT[i]!.sp}]: ${(buf.length / 1024).toFixed(0)}KB dur=${d}s`);
  }
  // Concatenar (demuxer concat).
  const listFile = join(base, 'concat.txt');
  writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const out = join(base, 'doctor-audio.mp3');
  const r = spawnSync(FF, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], { encoding: 'utf8' });
  if (r.status !== 0) console.log('concat -c copy fallo:', (r.stderr ?? '').slice(-220));
  const total = (await getVideoDurationSec(out)) ?? 0;
  console.log('\nSEGMENTOS (s):', durations.map((d, i) => `${SCRIPT[i]!.sp}=${d}`).join('  '));
  console.log('TOTAL:', total, 's  →', out);
}
void main();
