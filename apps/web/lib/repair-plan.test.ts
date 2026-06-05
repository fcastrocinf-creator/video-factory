// Tests del executor del brazo (Fase 2 parte 2). Parte PURA: buildRepairParse +
// repairActionIsExecutable. Sin IA, sin DB. Correr:
//   pnpm tsx --test apps/web/lib/repair-executor.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GateBlocker } from './kb/findings';
import type { RepairTarget } from './kb/quality-gate';
import { buildRepairParse, repairActionIsExecutable } from './repair-plan';

function mkRepair(over: Partial<RepairTarget> & { action: RepairTarget['action'] }): RepairTarget {
  const blocker: GateBlocker = {
    dimension: 'realismo',
    severidad: 'high',
    estado: 'abierto',
    titulo: 'cara alien',
    fixPropuesto: 'piel real con poros, expresión natural',
    confianza: 0.9,
    sceneIndex: 3,
    startSec: 5,
    endSec: 9,
    ...over.blocker,
  };
  return {
    blocker,
    target: over.target ?? 'image',
    sceneIndex: over.sceneIndex ?? 3,
    action: over.action,
  };
}

test('regenerate-image → plan determinista dirigido a su escena', () => {
  const parse = buildRepairParse(
    mkRepair({ action: { kind: 'regenerate-image', sceneIndex: 3, correctedImagePrompt: 'piel real' } }),
  );
  assert.ok(parse);
  assert.deepEqual(parse!.sceneIndices, [3]);
  assert.equal(parse!.intent, 'regenerate');
  assert.equal(parse!.preserveComposition, true);
  assert.equal(parse!.newDirection, 'piel real');
});

test('reanimate → usa el prompt de movimiento como dirección', () => {
  const parse = buildRepairParse(
    mkRepair({
      target: 'motion',
      action: { kind: 'reanimate', sceneIndex: 2, correctedMotionPrompt: 'que el experto gesticule' },
    }),
  );
  assert.ok(parse);
  assert.deepEqual(parse!.sceneIndices, [2]);
  assert.equal(parse!.newDirection, 'que el experto gesticule');
});

test('regenerate-image sin prompt corregido → cae al fixPropuesto del hallazgo', () => {
  const parse = buildRepairParse(
    mkRepair({ action: { kind: 'regenerate-image', sceneIndex: 3, correctedImagePrompt: '' } }),
  );
  assert.ok(parse);
  assert.equal(parse!.newDirection, 'piel real con poros, expresión natural');
});

test('newDirection se trunca a 150 caracteres', () => {
  const long = 'x'.repeat(300);
  const parse = buildRepairParse(
    mkRepair({ action: { kind: 'regenerate-image', sceneIndex: 1, correctedImagePrompt: long } }),
  );
  assert.ok(parse);
  assert.equal(parse!.newDirection.length, 150);
});

test('surface-to-editor y escalate NO son ejecutables → null', () => {
  assert.equal(repairActionIsExecutable({ kind: 'surface-to-editor' }), false);
  assert.equal(repairActionIsExecutable({ kind: 'escalate' }), false);
  assert.equal(buildRepairParse(mkRepair({ target: 'composite', action: { kind: 'surface-to-editor' } })), null);
  assert.equal(buildRepairParse(mkRepair({ target: 'systemic', action: { kind: 'escalate' } })), null);
});

test('regenerate-image/reanimate/regenerate-scene SÍ son ejecutables', () => {
  assert.equal(repairActionIsExecutable({ kind: 'regenerate-image', sceneIndex: 0, correctedImagePrompt: 'x' }), true);
  assert.equal(repairActionIsExecutable({ kind: 'reanimate', sceneIndex: 0, correctedMotionPrompt: 'x' }), true);
  assert.equal(repairActionIsExecutable({ kind: 'regenerate-scene', sceneIndex: 0 }), true);
});
