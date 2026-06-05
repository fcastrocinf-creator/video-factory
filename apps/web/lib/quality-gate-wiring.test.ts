// GUARDIÁN del wiring de la COMPUERTA DE CALIDAD.
//
// La compuerta (Gemini ve+oye) DEBE ser OBLIGATORIA en el pipeline: correr SIEMPRE,
// con await, y el estado final del run DEBE depender de su veredicto (fail-loud).
// Históricamente "no se usaba" porque era opt-in (flag) + fire-and-forget silencioso.
// Estos tests LEEN el código fuente del pipeline y del juez: si alguien revierte el
// candado (vuelve la compuerta opt-in / fire-and-forget / quita la dependencia del
// estado / borra la auditoría forense), estos tests ROMPEN → la validación NO se puede
// "desconectar" en silencio. Es la garantía de "siempre se ejecuta".
//
// Correr: pnpm tsx --test apps/web/lib/quality-gate-wiring.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Resuelve la raíz del repo (el test se corre desde ahí; con fallbacks por si acaso).
function repoFile(rel: string): string {
  for (const base of [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '..', '..')]) {
    const p = resolve(base, rel);
    if (existsSync(p)) return p;
  }
  return resolve(process.cwd(), rel);
}

const pipeline = readFileSync(repoFile('apps/web/lib/pipeline.ts'), 'utf8');
const judge = readFileSync(repoFile('apps/web/lib/render-quality-judge.ts'), 'utf8');

test('GUARDIÁN: la compuerta corre OBLIGATORIA en el pipeline (NO opt-in)', () => {
  assert.ok(
    !pipeline.includes('VF_GATE_ON_RENDER'),
    'REGRESIÓN: la compuerta volvió a ser opt-in (VF_GATE_ON_RENDER). Debe correr SIEMPRE.',
  );
  assert.match(
    pipeline,
    /await runQualityGate\(/,
    'REGRESIÓN: runQualityGate ya no se llama con await (debe ser obligatorio/bloqueante, no fire-and-forget).',
  );
  assert.match(
    pipeline,
    /useGemini:\s*true/,
    'REGRESIÓN: la compuerta ya no usa Gemini SIEMPRE (useGemini: true).',
  );
  // Candado estricto: si alguien la desconecta poniéndola en false, ROMPE.
  assert.ok(
    !/useGemini:\s*false/.test(pipeline),
    'REGRESIÓN: la compuerta se llamó con useGemini:false → no validaría con Gemini. Debe ser true (siempre ve+oye).',
  );
});

test('GUARDIÁN: el estado final depende del veredicto (fail-loud + fail-closed)', () => {
  assert.match(
    pipeline,
    /gateVeredicto/,
    'REGRESIÓN: el estado final ya no depende del veredicto de la compuerta.',
  );
  assert.match(
    pipeline,
    /gateVeredicto === 'pass'/,
    "REGRESIÓN: ya no se exige veredicto 'pass' para marcar 'completed'.",
  );
  assert.match(
    pipeline,
    /no-verificado/,
    'REGRESIÓN: se perdió el estado "no-verificado" (cuando Gemini no puede validar → fail-closed, no pasa a ciegas).',
  );
});

test('GUARDIÁN: el juez conserva la auditoría forense de micro-errores', () => {
  assert.match(
    judge,
    /AUDITOR[ÍI]A FORENSE/,
    'REGRESIÓN: el juez perdió la auditoría forense (transiciones/audio/anatomía/oclusiones).',
  );
});
