// scripts/test-anthropic-key.cjs
// Test que (a) la API key funciona y (b) detecta qué modelos Claude están
// disponibles. Lee del .env (no expone la key en CLI args/logs).
//
// Output: confirma key + lista qué modelos respondieron (Haiku 4.5, Sonnet 4.6, etc.)

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const KEY = process.env['ANTHROPIC_API_KEY'];
if (!KEY) {
  console.error('✗ ANTHROPIC_API_KEY no presente en .env');
  process.exit(1);
}
if (!KEY.startsWith('sk-ant-')) {
  console.error('✗ ANTHROPIC_API_KEY no tiene formato esperado (sk-ant-...)');
  process.exit(1);
}
console.log(`✓ Key presente: ${KEY.slice(0, 14)}...${KEY.slice(-4)} (no se logea entera)`);
console.log('');

// Modelos a probar — del más nuevo al más viejo conocidos.
// Si Anthropic ya renombro/deprecated, vemos cuál responde.
const MODELS_TO_TRY = [
  'claude-haiku-4-5',
  'claude-haiku-4',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
];

async function testModel(model) {
  const body = JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Respond with exactly: PONG' }],
  });
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text;
      try {
        const json = JSON.parse(text);
        detail = json.error?.message ?? text;
      } catch {}
      return { model, ok: false, status: resp.status, detail: detail.slice(0, 200) };
    }
    const json = JSON.parse(text);
    const content = json.content?.[0]?.text ?? '(no content)';
    return { model, ok: true, response: content.slice(0, 50), usage: json.usage };
  } catch (e) {
    return { model, ok: false, status: 0, detail: e.message };
  }
}

(async () => {
  console.log('Probando modelos disponibles...');
  console.log('');
  for (const m of MODELS_TO_TRY) {
    const r = await testModel(m);
    if (r.ok) {
      console.log(`  ✓ ${m} → "${r.response}" (in=${r.usage?.input_tokens}, out=${r.usage?.output_tokens})`);
    } else {
      console.log(`  ✗ ${m} → HTTP ${r.status}: ${r.detail.slice(0, 120)}`);
    }
  }
  console.log('');
  console.log('Listo. Los modelos con ✓ son los que podemos usar en M2.');
})();
