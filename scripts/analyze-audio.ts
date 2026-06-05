// Analiza DEFECTOS de audio con Gemini 2.5 Pro (oye el audio inline en base64).
// Para auditar la pista de voz de un render (clicks/empalmes, volumen, timbre, etc.).
// Uso: npx tsx scripts/analyze-audio.ts <audio.mp3>
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
  if (!apiKey) { console.error('Falta GOOGLE_AI_API_KEY'); process.exit(1); }
  const audioPath = process.argv[2] ?? resolve(ROOT, 'storage/proto-key/combined-key.mp3');
  const b64 = readFileSync(audioPath).toString('base64');

  const prompt = [
    'Eres un INGENIERO DE AUDIO forense. Este audio es la pista de voz de un anuncio:',
    'un MÉDICO habla. Está hecho de DOS clips concatenados (aprox. 0-8s y 8-16s) más posible silencio al final.',
    'Escúchalo con MÁXIMA atención y lista TODOS los defectos de audio, cada uno con su SEGUNDO aproximado:',
    '- clicks/pops/chasquidos o cortes abruptos en el EMPALME (~8s) o en cualquier punto;',
    '- cambios de VOLUMEN entre segmentos;',
    '- cambios de TIMBRE/voz: ¿suena exactamente la MISMA persona en todo el audio, o cambia entre el primer y segundo tramo?;',
    '- ruido de fondo: ¿es consistente o cambia (otro ambiente) en el empalme?;',
    '- respiraciones audibles, chasquidos de boca, sibilancias;',
    '- entonación/naturalidad: ¿suena humano y fluido o robótico/raro en algún punto?;',
    '- silencios o tiempos muertos;',
    '- palabras mal pronunciadas o poco claras.',
    'Sé concreto y honesto; si algo está bien, dilo. Responde en español neutro, lista con viñetas por segundo.',
  ].join('\n');

  const body = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/mpeg', data: b64 } }] }],
    generationConfig: { temperature: 0.2 },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '(sin respuesta)';
  console.log(`AUDIO: ${audioPath}\n`);
  console.log(text);
}
void main();
