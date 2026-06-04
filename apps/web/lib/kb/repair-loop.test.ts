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
