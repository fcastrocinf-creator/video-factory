// Tests de planRepairs (Fase 2 — el "cerebro" del RepairLoop). Sin IA, deterministas.
// Correr: pnpm tsx --test apps/web/lib/kb/repair-loop.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GateBlocker, QualityGateReport } from './findings';
import { planRepairs, routeByDimension } from './repair-loop';

function mkBlocker(dimension: string): GateBlocker {
  return {
    dimension,
    severidad: 'high',
    estado: 'abierto',
    titulo: `problema en ${dimension}`,
    fixPropuesto: 'arreglar',
    confianza: 0.9,
  };
}

function mkReport(dimensions: string[]): QualityGateReport {
  return {
    bloqueantes: dimensions.map(mkBlocker),
    recomendaciones: [],
  } as unknown as QualityGateReport;
}

test('dimensiones de edición → surface-to-editor (composite/motion)', () => {
  for (const d of ['composicion-recorte', 'captions-anotacion', 'producto-legibilidad']) {
    const r = routeByDimension(d);
    assert.equal(r.action.kind, 'surface-to-editor', `${d} debería ir al editor`);
    assert.equal(r.target, 'composite');
  }
  const anim = routeByDimension('animacion-movimiento');
  assert.equal(anim.action.kind, 'surface-to-editor');
  assert.equal(anim.target, 'motion');
});

test('dimensiones sistémicas → escalate', () => {
  for (const d of ['voces-diarizacion', 'fidelidad', 'render-av']) {
    const r = routeByDimension(d);
    assert.equal(r.action.kind, 'escalate', `${d} debería escalar`);
    assert.equal(r.target, 'systemic');
  }
});

test('planRepairs mapea 1 reparación por bloqueante, preservando el blocker', () => {
  const report = mkReport(['composicion-recorte', 'voces-diarizacion']);
  const repairs = planRepairs(report);
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0]!.action.kind, 'surface-to-editor');
  assert.equal(repairs[0]!.blocker.dimension, 'composicion-recorte');
  assert.equal(repairs[1]!.action.kind, 'escalate');
  assert.equal(repairs[1]!.sceneIndex, null); // hoy no hay targeting de escena
});

test('reporte sin bloqueantes → sin reparaciones', () => {
  assert.deepEqual(planRepairs(mkReport([])), []);
});

// ─── Targeting por escena (Fase 2 "el brazo") ───────────────────────────────

test('animación CON escena → reanimate dirigido a esa escena', () => {
  const r = routeByDimension('animacion-movimiento', 2, 'que el experto gesticule');
  assert.equal(r.action.kind, 'reanimate');
  assert.equal(r.target, 'motion');
  if (r.action.kind === 'reanimate') {
    assert.equal(r.action.sceneIndex, 2);
    assert.equal(r.action.correctedMotionPrompt, 'que el experto gesticule');
  }
});

test('defecto visual (realismo) CON escena → regenerate-image dirigido', () => {
  const r = routeByDimension('realismo', 3, 'cara natural, piel real con poros');
  assert.equal(r.action.kind, 'regenerate-image');
  assert.equal(r.target, 'image');
  if (r.action.kind === 'regenerate-image') {
    assert.equal(r.action.sceneIndex, 3);
    assert.equal(r.action.correctedImagePrompt, 'cara natural, piel real con poros');
  }
});

test('lipsync CON escena → escalate (no se arregla regenerando imagen)', () => {
  const r = routeByDimension('render-av', 1, 'el lipsync se desfasa, labios fuera de sincronía');
  assert.equal(r.action.kind, 'escalate');
  assert.equal(r.target, 'systemic');
});

test('edición (recorte) CON escena → sigue al editor (no se regenera)', () => {
  const r = routeByDimension('composicion-recorte', 4, 'recorte con halo verde');
  assert.equal(r.action.kind, 'surface-to-editor');
  assert.equal(r.target, 'composite');
});

test('planRepairs preserva el sceneIndex del bloqueante en la reparación', () => {
  const blocker: GateBlocker = {
    dimension: 'realismo',
    severidad: 'critical',
    estado: 'abierto',
    titulo: 'cara alien en el plano de Rosa',
    fixPropuesto: 'regenerar con soul_2, piel real',
    confianza: 0.95,
    sceneIndex: 5,
    startSec: 12.4,
    endSec: 16,
  };
  const report = { bloqueantes: [blocker], recomendaciones: [] } as unknown as QualityGateReport;
  const repairs = planRepairs(report);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.sceneIndex, 5);
  assert.equal(repairs[0]!.action.kind, 'regenerate-image');
});
