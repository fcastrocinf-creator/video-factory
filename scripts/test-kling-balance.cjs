// scripts/test-kling-balance.cjs
// Test minimal: confirma que Kling tiene saldo después de la recarga.
// Costo: ~$0.084 (1 clip 5s std). Tiempo: 30-60s típico.

const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
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
  const { KlingClient } = await import(
    '../packages/blocks/video-gen-veo/src/kling-client.ts'
  );

  const accessKey = process.env['KLING_ACCESS_KEY'];
  const secretKey = process.env['KLING_SECRET_KEY'];
  if (!accessKey || !secretKey) {
    console.error('✗ KLING keys no presentes en .env');
    process.exit(1);
  }
  console.log(`✓ Kling keys presentes: ${accessKey.slice(0, 12)}...`);

  // Usar PNG del Test 6 (sabemos que existen)
  const testImagePath = resolve(
    __dirname,
    '..',
    'storage',
    'runs',
    '2ab89eb1-c94a-4c81-ac11-6ee5f3de9d32',
    'scene_00.png',
  );
  if (!existsSync(testImagePath)) {
    console.error(`✗ Imagen test no encontrada: ${testImagePath}`);
    process.exit(1);
  }
  const imageBuffer = readFileSync(testImagePath);
  console.log(`✓ Imagen test: scene_00.png (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
  console.log('');

  console.log('Llamando Kling-v2-6 std 5s (costo ~$0.084)...');
  const client = new KlingClient({ accessKey, secretKey });
  const t0 = Date.now();
  try {
    const videoBuffer = await client.generate({
      prompt:
        'Subtle natural movement: character breathes and blinks, gentle camera push-in, watercolor sepia style, no scene changes.',
      imageBase64: imageBuffer.toString('base64'),
      model: 'kling-v2-6',
      mode: 'std',
      duration: '5',
      onProgress: (msg) => console.log(`  status: ${msg}`),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const outPath = resolve(
      __dirname,
      '..',
      'storage',
      'probe',
      `kling-balance-test-${Date.now()}.mp4`,
    );
    writeFileSync(outPath, videoBuffer);
    console.log(`\n✓ Kling FUNCIONA — ${(videoBuffer.length / 1024).toFixed(0)} KB en ${elapsed}s`);
    console.log(`  Saved: ${outPath}`);
    console.log('\nSaldo OK. Listo para Test 7.');
    process.exit(0);
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = e.message ?? String(e);
    console.error(`\n✗ Kling FALLÓ en ${elapsed}s`);
    console.error(`  Error: ${msg.slice(0, 600)}`);
    if (/Account balance not enough|code.*1102/i.test(msg)) {
      console.error('\n⚠ Aún no hay saldo — verificar que los créditos llegaron a la cuenta correcta.');
      console.error(`  Tu key: ${accessKey.slice(0, 12)}...`);
      console.error('  En console.kling.com → API Key, la primera key debe coincidir.');
    }
    process.exit(1);
  }
})();
