// Transcribe un audio con timestamps aproximados de palabra usando Gemini 2.5 Pro
// (el audio va inline en base64). Sirve para sincronizar anotaciones a la palabra.
// Uso: npx tsx scripts/transcribe-gemini.ts <audio.mp3>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';

function loadEnvKey(name: string): string {
  const envText = readFileSync(resolve(ROOT, '.env'), 'utf8');
  const m = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, 'm'));
  return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : '';
}

async function main(): Promise<void> {
  const apiKey = loadEnvKey('GOOGLE_AI_API_KEY');
  if (!apiKey) { console.error('Falta GOOGLE_AI_API_KEY en .env'); process.exit(1); }

  const audioPath = process.argv[2] ?? resolve(ROOT, 'storage/proto-key/medico-zonas.mp3');
  const b64 = readFileSync(audioPath).toString('base64');

  const prompt = [
    'Este audio en español es un médico hablando. Hazlo con la máxima precisión temporal posible.',
    '1) Transcríbelo palabra por palabra.',
    '2) Para CADA palabra indica el segundo de INICIO desde 0.00s (inicio del audio).',
    '3) En especial, indica el segundo de inicio de "ojeras" y de "papada" si aparecen.',
    'Responde SOLO JSON válido: {"texto":"...","palabras":[{"p":"palabra","t":0.0}],"ojeras_t":0.0,"papada_t":0.0}',
  ].join('\n');

  const body = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/mpeg', data: b64 } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(sin respuesta)';
  console.log(`AUDIO: ${audioPath}`);
  console.log(text);
}
void main();
