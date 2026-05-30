// scripts/test-cascade-bug1-regex.ts
//
// Test del Bug 1 fix (vertex-provider.ts): el regex de detección de
// quota-exhausted debe matchear el body real del 429 de Vertex AI y NO
// debe matchear errores 500 / 429 transient sin quota.
//
// Esto es una verificación rápida del PATTERN; no exercita el provider entero
// (eso requiere GoogleAuth setup + fetch mocking). Si el regex pasa, confiamos
// en que el flag `isDailyQuotaExhausted=true` se va a setear correctamente
// cuando llegue ese body de Vertex en producción → la cascada del block va a
// saltar al próximo provider (Bug 2 ya cubre la red de seguridad).
//
// Cero costo, cero API calls, ~100ms total.

// El regex EXACTO que usa vertex-provider.ts (ver el fix del Paso 1).
const QUOTA_REGEX =
  /quota.*exceeded|RESOURCE_EXHAUSTED|online_prediction_requests_per_base_model/i;

interface TestCase {
  label: string;
  body: string;
  expected: boolean;
}

const cases: TestCase[] = [
  {
    label: 'Vertex 429 real body (per-base-model quota — el caso que tumbó el rip)',
    body: JSON.stringify({
      error: {
        code: 429,
        message:
          'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model with base model: imagen-4.0-fast-generate. Please submit a quota increase request.',
        status: 'RESOURCE_EXHAUSTED',
      },
    }),
    expected: true,
  },
  {
    label: 'Vertex RESOURCE_EXHAUSTED genérico (otras cuotas)',
    body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
    expected: true,
  },
  {
    label: 'Quota exceeded lowercase',
    body: '{"error":{"message":"quota exceeded"}}',
    expected: true,
  },
  {
    label: 'Quota Exceeded mixed case',
    body: '{"error":{"message":"Quota Exceeded for this region"}}',
    expected: true,
  },
  {
    label: 'Vertex 429 sin quota — rate-limit transient (debe NO matchear)',
    body: '{"error":{"message":"Too many requests, try again later"}}',
    expected: false,
  },
  {
    label: '500 internal server error (debe NO matchear, es transient)',
    body: '{"error":{"code":500,"message":"Internal server error"}}',
    expected: false,
  },
  {
    label: 'Auth error 401 (debe NO matchear)',
    body: '{"error":{"code":401,"message":"Unauthorized"}}',
    expected: false,
  },
  {
    label: 'Content rejection 400 (debe NO matchear — eso lo maneja isContentRejection)',
    body: '{"error":{"code":400,"message":"Safety filter blocked this prompt"}}',
    expected: false,
  },
];

console.log('=== Test: Bug 1 fix — Vertex 429 quota-detection regex ===');
console.log(`Pattern: ${QUOTA_REGEX.source}`);
console.log('');

let failed = 0;
for (const tc of cases) {
  const actual = QUOTA_REGEX.test(tc.body);
  const ok = actual === tc.expected;
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${tc.label}`);
  if (!ok) {
    console.log(`    body: ${tc.body.slice(0, 120)}${tc.body.length > 120 ? '…' : ''}`);
    console.log(`    expected: ${tc.expected}, actual: ${actual}`);
    failed++;
  }
}

console.log('');
if (failed > 0) {
  console.error(`✗ FAILED: ${failed}/${cases.length} cases failed`);
  process.exit(1);
}
console.log(`✓ All ${cases.length} cases passed`);
console.log('');
console.log('Bug 1 fix confirmed: el regex detecta correctamente los 429s de cuota');
console.log('Y NO se confunde con 500/401/400/transient.');
