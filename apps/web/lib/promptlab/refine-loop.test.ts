import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVisualRefineLoop, type RefineLoopCallbacks } from './refine-loop';
import type { JudgeVerdict } from './types';

function verdict(partial: Partial<JudgeVerdict>): JudgeVerdict {
  return {
    score: 0,
    byDimension: {},
    approved: false,
    notVerified: false,
    hint: '',
    failedCriteria: [],
    evidence: [],
    ...partial,
  };
}

const genOk = async () => ({ buffer: Buffer.from('img') });
const refineEcho = async (p: string) => p + ' +';

test('aprueba en el primer intento si el juez aprueba', async () => {
  const cb: RefineLoopCallbacks = {
    generate: genOk,
    judge: async () => verdict({ score: 95, approved: true }),
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p' });
  assert.equal(r.approved, true);
  assert.equal(r.stopReason, 'aprobado');
  assert.equal(r.iterations.length, 1);
  assert.equal(r.notVerified, false);
});

test('refina hasta aprobar (scores crecientes)', async () => {
  const scores = [50, 70, 90];
  let i = 0;
  const cb: RefineLoopCallbacks = {
    generate: genOk,
    judge: async () => {
      const s = scores[i++] ?? 90;
      return verdict({ score: s, approved: s >= 88 });
    },
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p', maxAttempts: 5 });
  assert.equal(r.approved, true);
  assert.equal(r.bestScore, 90);
  assert.equal(r.iterations.length, 3);
});

test('agota presupuesto y devuelve el MEJOR intento si nunca aprueba', async () => {
  const scores = [40, 60, 55, 58];
  let i = 0;
  const cb: RefineLoopCallbacks = {
    generate: genOk,
    judge: async () => verdict({ score: scores[i++] ?? 50, approved: false }),
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p', maxAttempts: 4, minDelta: 1 });
  assert.equal(r.approved, false);
  assert.equal(r.bestScore, 60); // el mejor visto, no el último
  assert.equal(r.notVerified, false); // sí se evaluó, solo no alcanzó
});

test('FAIL-CLOSED: si el juez nunca pudo evaluar, no aprueba y marca no-verificado', async () => {
  const cb: RefineLoopCallbacks = {
    generate: genOk,
    judge: async () => verdict({ score: 0, notVerified: true }),
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p', maxAttempts: 3 });
  assert.equal(r.approved, false);
  assert.equal(r.notVerified, true);
  assert.equal(r.stopReason, 'no-verificado');
});

test('para por ESTANCAMIENTO si el score no mejora', async () => {
  const cb: RefineLoopCallbacks = {
    generate: genOk,
    judge: async () => verdict({ score: 50, approved: false }),
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p', maxAttempts: 8, minDelta: 3 });
  assert.equal(r.approved, false);
  assert.equal(r.stopReason, 'estancado');
  assert.ok(r.iterations.length < 8); // paró antes de agotar
});

test('no aborta si un intento lanza: sigue y conserva el mejor', async () => {
  let i = 0;
  const cb: RefineLoopCallbacks = {
    generate: async () => {
      i++;
      if (i === 2) throw new Error('quota');
      return { buffer: Buffer.from('img') };
    },
    judge: async () => verdict({ score: 60, approved: false }),
    refine: refineEcho,
  };
  const r = await runVisualRefineLoop(cb, { basePrompt: 'p', maxAttempts: 3, minDelta: 1 });
  assert.equal(r.iterations.length, 3); // el fallido también se registra
  assert.equal(r.bestScore, 60);
});
