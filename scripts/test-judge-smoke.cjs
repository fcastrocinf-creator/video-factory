// scripts/test-judge-smoke.cjs
// Smoke test del preview-judge: prueba con UNA imagen real (el jardín japonés
// del smoke de Gemini que ya generamos) y muestra el JudgeReport completo.
//
// Validates: API funciona, JSON parsea, schema válido, scores razonables.
// Cero impacto al pipeline, ~$0.01-0.02.

const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

// Cargar .env minimal
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

(async () => {
  // Importar el judge — tsx para resolver TS workspace deps
  const { judgeImage } = await import(
    '../packages/blocks/preview-judge/src/index.ts'
  );

  // Buscar la imagen smoke más reciente
  const probeDir = resolve(__dirname, '..', 'storage', 'probe');
  const files = require('node:fs')
    .readdirSync(probeDir)
    .filter((f) => f.startsWith('gemini-') && f.endsWith('.png'))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error('✗ No hay imagen smoke en storage/probe/');
    process.exit(1);
  }
  const imagePath = resolve(probeDir, files[0]);
  console.log(`Image: ${imagePath}`);

  const imageBuffer = readFileSync(imagePath);
  console.log(`Size: ${(imageBuffer.length / 1024).toFixed(0)} KB`);
  console.log('');

  console.log('Calling Claude Haiku 4.5 to judge image...');
  const t0 = Date.now();
  const result = await judgeImage(
    {
      imageBuffer,
      imageMimeType: 'image/png',
      prompt:
        'A serene Japanese tea garden in autumn afternoon light, vertical composition, no text or watermark, photo-realistic style',
      expectedStyle: 'photo-realistic',
    },
    { model: 'claude-haiku-4-5' },
  );
  const elapsedMs = Date.now() - t0;

  if (result.isErr()) {
    console.error(`✗ FAILED in ${elapsedMs}ms`);
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
  }

  const report = result.value;
  console.log(`✓ Judge responded in ${elapsedMs}ms`);
  console.log('');
  console.log(`pass: ${report.pass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`scoreVisual:       ${report.scoreVisual}/100`);
  console.log(`scoreBrandFit:     ${report.scoreBrandFit}/100`);
  console.log(`scoreHookStrength: ${report.scoreHookStrength}/100`);
  console.log('');
  if (report.issues.length > 0) {
    console.log(`Issues (${report.issues.length}):`);
    for (const i of report.issues) {
      console.log(`  [${i.severity}] ${i.category}: ${i.description}`);
    }
    console.log('');
  }
  if (report.suggestions.length > 0) {
    console.log(`Suggestions:`);
    for (const s of report.suggestions) {
      console.log(`  → ${s}`);
    }
    console.log('');
  }
  console.log(`Rationale: ${report.rationale}`);
})().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
