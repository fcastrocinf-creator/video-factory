// scripts/test-higgsfield-video.cjs
// Test STANDALONE del HiggsfieldVideoClient — valida endpoint REAL DoP image-to-video.
// Endpoint: POST /v1/image2video/dop con model='dop-turbo' (upload de imagen + submit).
// Costo: ~$0.30-0.50 USD por clip DoP turbo 5s. Tiempo: ~60-120s.

const { readFileSync, writeFileSync, existsSync } = require('node:fs');
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

(async () => {
  const { HiggsfieldVideoClient } = await import(
    '../packages/blocks/video-gen-veo/src/higgsfield-video-client.ts'
  );

  const keyId = process.env['HIGGSFIELD_KEY_ID'];
  const keySecret = process.env['HIGGSFIELD_KEY_SECRET'];
  if (!keyId || !keySecret) {
    console.error('✗ HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET no presentes en .env');
    process.exit(1);
  }
  console.log(`✓ Higgsfield keys presentes`);

  // Reusar PNG existente del Test 11 (scene_00)
  const sourceImg = resolve(
    __dirname,
    '..',
    'storage',
    'runs',
    '96bef2a7-6382-4b52-b7aa-5f1475587ea4',
    'scene_00.png',
  );
  if (!existsSync(sourceImg)) {
    console.error(`✗ Imagen test no encontrada: ${sourceImg}`);
    process.exit(1);
  }
  const imageBuffer = readFileSync(sourceImg);
  console.log(`✓ Imagen test: scene_00.png (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
  console.log('');

  console.log('Probando endpoint Higgsfield DoP image-to-video (5s clip 9:16)...');
  console.log('Costo estimado: ~$0.30-0.50 USD. Tiempo: 60-120s con queue.');
  console.log('');

  const client = new HiggsfieldVideoClient({ keyId, keySecret });
  const t0 = Date.now();
  try {
    const videoBuffer = await client.generate({
      prompt:
        'Subtle natural movement: character breathes and blinks, very gentle camera push-in (5-8% zoom), maintains exact same composition, no scene changes.',
      imageBase64: imageBuffer.toString('base64'),
      imageMimeType: 'image/png',
      aspectRatio: '9:16',
      durationSec: 5,
      onProgress: (status) => console.log(`  [status] ${status}`),
    });
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    const outPath = resolve(
      __dirname,
      '..',
      'storage',
      'probe',
      `higgsfield-video-test-${Date.now()}.mp4`,
    );
    writeFileSync(outPath, videoBuffer);
    console.log('');
    console.log(`✓ Higgsfield FUNCIONA — ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB en ${elapsedSec}s`);
    console.log(`  Saved: ${outPath}`);
    console.log('');
    console.log('Endpoint /v1/image2video/dop CONFIRMADO. Routing UGC→Higgsfield listo.');
    process.exit(0);
  } catch (e) {
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = e.message ?? String(e);
    console.error('');
    console.error(`✗ Higgsfield FALLÓ en ${elapsedSec}s`);
    console.error(`  Error: ${msg.slice(0, 800)}`);
    console.error('');
    if (msg.includes('404')) {
      console.error('  → El endpoint /v1/image2video/dop NO existe en la API actual.');
      console.error('  → Verificar contra https://github.com/higgsfield-ai/higgsfield-js README');
    } else if (/Not enough credits|credit|balance|insufficient/i.test(msg)) {
      console.error('  → ENDPOINT OK pero cuenta sin créditos.');
      console.error('  → Recargar en https://platform.higgsfield.ai → Billing.');
      console.error('  → El routing UGC→Higgsfield queda implementado y operativo cuando hay saldo.');
    } else if (msg.includes('401')) {
      console.error('  → Auth falla: verificar HIGGSFIELD_KEY_ID y HIGGSFIELD_KEY_SECRET en .env');
    } else if (msg.includes('422')) {
      console.error('  → Schema inválido: revisar body de submit en HiggsfieldVideoClient.generate');
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
