// Transcribe un audio con timestamps de PALABRA (OpenAI Whisper) para sincronizar
// anotaciones a la palabra exacta. Uso: npx tsx scripts/transcribe-audio.ts <audio.mp3>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';

function loadEnvKey(name: string): string {
  const envText = readFileSync(resolve(ROOT, '.env'), 'utf8');
  const m = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, 'm'));
  return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : '';
}

async function main(): Promise<void> {
  const apiKey = loadEnvKey('OPENAI_API_KEY');
  if (!apiKey) { console.error('Falta OPENAI_API_KEY en .env'); process.exit(1); }

  const audioPath = process.argv[2] ?? resolve(ROOT, 'storage/proto-key/medico-zonas.mp3');
  const buf = readFileSync(audioPath);

  const form = new FormData();
  form.append('file', new Blob([buf]), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'es');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  const json = (await res.json()) as { text: string; words?: { word: string; start: number; end: number }[] };

  console.log(`\nAUDIO: ${audioPath}`);
  console.log(`TEXTO COMPLETO: "${json.text}"`);
  console.log(`\nPALABRAS (timestamp relativo al inicio del audio):`);
  for (const w of json.words ?? []) {
    console.log(`  ${w.start.toFixed(2)}s → ${w.end.toFixed(2)}s : ${w.word}`);
  }
}
void main();
