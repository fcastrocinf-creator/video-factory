// scripts/probe-video-scenes.cjs
// Cuenta escenas reales de un video usando keyframes ya extraídos + Claude visión.
// Self-contained, no depende de los módulos TS de apps/web.

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

const framesDir = process.argv[2] || resolve(__dirname, '..', 'storage', 'probe', 'video2-scenes');
const fpsExtraction = parseFloat(process.argv[3] || '0.5'); // 1 frame cada 1/fps segundos
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

(async () => {
  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  if (files.length === 0) {
    console.error('No JPG en ' + framesDir);
    process.exit(1);
  }
  const intervalSec = 1 / fpsExtraction;
  console.log(`Frames extraídos: ${files.length} a ${fpsExtraction} fps (1 cada ${intervalSec}s)`);
  console.log(`Duración cubierta: ~${(files.length * intervalSec).toFixed(0)}s`);
  console.log('');

  // Tomamos máximo 24 frames uniformemente espaciados (limit del API + costo)
  const TARGET = 24;
  const step = Math.max(1, Math.floor(files.length / TARGET));
  const selected = [];
  for (let i = 0; i < files.length; i += step) {
    selected.push({ file: files[i], timeSec: i * intervalSec });
    if (selected.length >= TARGET) break;
  }
  console.log(`Enviando ${selected.length} frames muestreados a Claude Sonnet...`);
  console.log('');

  // Armar payload multimodal
  const content = [];
  for (const { file, timeSec } of selected) {
    const data = readFileSync(resolve(framesDir, file)).toString('base64');
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data },
    });
    content.push({ type: 'text', text: `↑ Frame en t=${timeSec.toFixed(0)}s` });
  }
  content.push({
    type: 'text',
    text: `\n\nDecime CUÁNTAS ESCENAS DISTINTAS tiene este video. Una "escena" es una unidad visual con el mismo setting/personaje/encuadre — cuando hay un corte y cambia el plano, la composición, el personaje o la ubicación, es escena nueva. NO confundas zoom-in o pequeño movimiento de cámara dentro del mismo plano con escena nueva.\n\nDevolveme SOLO un JSON sin markdown:\n{\n  "totalScenes": N,\n  "scenes": [{ "index": 0, "approxStartSec": X, "approxEndSec": Y, "summary": "..." }, ...],\n  "rationale": "1-2 oraciones sobre cómo lo contaste"\n}`,
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!resp.ok) {
    console.error('API error ' + resp.status + ': ' + (await resp.text()).slice(0, 400));
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

  console.log('=== ESCENAS DETECTADAS POR CLAUDE SONNET ===');
  console.log('totalScenes: ' + parsed.totalScenes);
  console.log('rationale:   ' + parsed.rationale);
  console.log('');
  for (const s of parsed.scenes) {
    const dur = (s.approxEndSec - s.approxStartSec).toFixed(0);
    console.log(`  ${String(s.index).padStart(2, '0')} [${s.approxStartSec.toFixed(0)}s → ${s.approxEndSec.toFixed(0)}s, ${dur}s] ${s.summary.slice(0, 110)}`);
  }
  console.log('');
  console.log('Tokens usados: ' + JSON.stringify(json.usage));
  process.exit(0);
})().catch((e) => {
  console.error('Falló:', e.message);
  process.exit(1);
});
