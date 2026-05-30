// Validación independiente del conteo de escenas.
// Toma frames denso (40 uniformes sobre 85 extraídos = 1 cada ~4s) y le pide a
// Claude Sonnet que cuente con criterio estricto. Compara contra Gemini (49).

const { readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const framesDir = resolve(__dirname, '..', 'storage', 'probe', 'video2-scenes');
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

(async () => {
  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  console.log(`Frames disponibles: ${files.length} (1 cada 2s sobre ~170s)`);

  // 40 frames uniformes (1 cada ~4s)
  const TARGET = 40;
  const step = Math.max(1, Math.floor(files.length / TARGET));
  const selected = [];
  for (let i = 0; i < files.length; i += step) {
    selected.push({ file: files[i], timeSec: i * 2 });
    if (selected.length >= TARGET) break;
  }
  console.log(`Seleccionados: ${selected.length} frames (1 cada ~${(170/selected.length).toFixed(1)}s)`);
  console.log('');

  const content = [];
  for (const { file, timeSec } of selected) {
    const data = readFileSync(resolve(framesDir, file)).toString('base64');
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data },
    });
    content.push({ type: 'text', text: `↑ t≈${timeSec}s` });
  }
  content.push({
    type: 'text',
    text: `\n\nHe extraído ${selected.length} frames uniformes de un anuncio vertical animado de 167s.

Tu tarea: CONTAR LAS ESCENAS DISTINTAS con criterio ESTRICTO de cine/edición:

UNA ESCENA = un plano continuo con la MISMA composición, MISMO encuadre y MISMO personaje/setting.
NUEVA ESCENA cada vez que hay:
- Corte a personaje distinto / setting distinto
- Cambio de encuadre del mismo sujeto (close-up → wide, frontal → perfil)
- Aparece o desaparece split-screen / PiP / overlay full-screen
- Transición a/desde diagrama anatómico, plano de producto, cartel
- Cualquier cut visual perceptible entre frames adyacentes

NO contar como nueva escena:
- Pan/zoom suave dentro del mismo plano
- Overlay text apareciendo sobre el mismo fondo

IMPORTANTE: si entre 2 frames adyacentes ves un CAMBIO VISUAL CLARO (distinto sujeto, composición o setting), eso es un corte → la segunda imagen es escena nueva. Si ambas son visualmente iguales (mismo encuadre, mismo personaje en misma pose), siguen siendo la misma escena.

Devolveme SOLO JSON sin markdown:
{
  "totalScenesEstimated": N,
  "rationale": "1-2 oraciones sobre cómo contaste",
  "scenesPerSec": "1 cada Xs",
  "verdictVsGemini49": "Gemini reportó 49 escenas — tu conteo da N. ¿Es razonable, sub-counted o over-counted?"
}`,
  });

  console.log('Llamando Claude Sonnet 4-5...');
  const t0 = Date.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!resp.ok) {
    console.error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 400));
    process.exit(1);
  }
  const json = await resp.json();
  const raw = json.content?.[0]?.text ?? '';
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    const fb = cleaned.indexOf('{');
    const lb = cleaned.lastIndexOf('}');
    if (fb >= 0 && lb > fb) cleaned = cleaned.slice(fb, lb + 1);
  }
  const parsed = JSON.parse(cleaned);

  console.log('');
  console.log('=== VALIDACIÓN INDEPENDIENTE (Claude Sonnet 4-5, 40 frames) ===');
  console.log('Conteo estimado:        ' + parsed.totalScenesEstimated);
  console.log('Densidad:               ' + parsed.scenesPerSec);
  console.log('Rationale:              ' + parsed.rationale);
  console.log('');
  console.log('Veredicto vs Gemini 49: ' + parsed.verdictVsGemini49);
  console.log('');
  console.log('Tiempo: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('Tokens: ' + JSON.stringify(json.usage));
  process.exit(0);
})().catch((e) => {
  console.error('Falló:', e.message);
  process.exit(1);
});
