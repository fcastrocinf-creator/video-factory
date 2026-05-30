// scripts/probe-gemini-image.ts
//
// Smoke test del GeminiImageProvider (Paso 2 del plan): genera UNA imagen con
// el provider directo, sin pipeline, para verificar:
//   - Endpoint correcto.
//   - Body shape correcto (imageConfig.aspectRatio para 2.5 family).
//   - Aspect ratio 9:16 respetado.
//   - Response parseable (inlineData / inline_data).
//   - Buffer PNG válido.
//
// Costo: ~$0.04 USD. Latencia: ~5-10s.
// Output: storage/probe/gemini-{timestamp}.png para inspección visual.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GeminiImageProvider } from '@video-factory/block-image-gen-imagen';

// Minimal dotenv loader — los scripts CLI no auto-loadean .env como Next.js.
function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
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

async function main(): Promise<void> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    console.error('FAIL: GOOGLE_AI_API_KEY no está en el env (revisar .env)');
    process.exit(1);
  }

  console.log('=== Probe: GeminiImageProvider (Nano Banana) ===');
  console.log('Modelo: gemini-2.5-flash-image (default, GA estable)');
  console.log('Aspect ratio: 9:16');
  console.log('');

  const provider = new GeminiImageProvider({ apiKey });
  const prompt =
    'A serene Japanese tea garden in autumn afternoon light, vertical composition, no text or watermark, photo-realistic style';
  console.log(`Prompt: "${prompt.slice(0, 80)}..."`);

  const t0 = Date.now();
  let buffer: Buffer;
  try {
    buffer = await provider.generate({ prompt, aspectRatio: '9:16' });
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`✗ FAILED in ${elapsed}s:`);
    console.error((e as Error).message);
    process.exit(1);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`✓ Generation OK in ${elapsed}s — ${buffer.length} bytes`);

  // Verify PNG signature
  const isPNG =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  console.log(`  PNG signature: ${isPNG ? '✓ valid' : '✗ INVALID'}`);
  if (!isPNG) {
    console.error(
      '  → Buffer is not a PNG. First 16 bytes:',
      buffer.subarray(0, 16).toString('hex'),
    );
    process.exit(1);
  }

  // Read width/height from PNG IHDR chunk (bytes 16-23, big-endian uint32 each)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  console.log(`  Dimensions: ${width}x${height}`);
  if (width === 0 || height === 0) {
    console.error('  ✗ Invalid PNG dimensions');
    process.exit(1);
  }
  const ratio = width / height;
  const expected = 9 / 16;
  const ratioDelta = Math.abs(ratio - expected);
  console.log(
    `  Aspect ratio: ${ratio.toFixed(4)} (expected ${expected.toFixed(4)} for 9:16, delta ${ratioDelta.toFixed(4)})`,
  );
  if (ratioDelta > 0.05) {
    console.warn(
      '  ⚠ Aspect ratio difference > 5% — el field `imageConfig.aspectRatio` puede NO estar siendo respetado',
    );
    console.warn(
      '    Posible fix: probar con `responseFormat.image.aspectRatio` en buildRequestBody.',
    );
  } else {
    console.log('  ✓ Aspect ratio dentro de tolerancia');
  }

  // Save the image for visual inspection
  const outDir = resolve(process.cwd(), 'storage', 'probe');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `gemini-${Date.now()}.png`);
  writeFileSync(outPath, buffer);
  console.log(`  Saved: ${outPath}`);
  console.log('');
  console.log('=== TEST PASSED ===');
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
