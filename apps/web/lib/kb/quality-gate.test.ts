// Test de la COMPUERTA DE CALIDAD — SIN IA ni ffmpeg (deps stub + función pura).
//
// Verifica:
//   1. decideGateVerdict (función pura): casos pass / revisar / fail según la política,
//      incluyendo el conteo de 'medium', los estados no contables y countUnverified.
//   2. runQualityGate cablea a runFormatAudit vía deps (stub determinista) y deriva el
//      veredicto sin tocar la red.
//
// Runner: node:test (incluido en @types/node). Correr con:
//   pnpm tsx --test apps/web/lib/kb/quality-gate.test.ts
// (no requiere vitest; el proyecto no tiene runner configurado en apps/web).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideGateVerdict, runQualityGate, DEFAULT_GATE_POLICY, type GatePolicy } from './quality-gate';
import type { FormatAuditResult, FormatAuditDeps } from './format-audit';
import type { Hallazgo, HallazgoSeveridad, HallazgoEstado } from './findings';
import type { SpecialistOutput } from './deep-audit';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _n = 0;
function hallazgo(
  severidad: HallazgoSeveridad,
  estado: HallazgoEstado,
  especialista = 'fidelidad',
): Hallazgo {
  _n += 1;
  return {
    id: `h${_n}`,
    auditId: 'audit/test/0001',
    ts: new Date().toISOString(),
    codeVersion: 'test',
    subsistema: 'aprendizaje',
    severidad,
    estado,
    titulo: `[${especialista}] problema ${_n}`,
    descripcion: 'desc',
    evidencia: 'evid',
    fixPropuesto: 'fix',
    confianza: 0.8,
  };
}

function resultadoCon(hallazgos: Hallazgo[]): FormatAuditResult {
  return {
    auditId: 'audit/test/0001',
    scope: 'gate:test',
    label: 'test',
    ts: new Date().toISOString(),
    codeVersion: 'test',
    depth: 'rapido',
    especialistasAuditados: ['fidelidad'],
    especialistasSalteados: [],
    hallazgos,
    descartados: 0,
    sintesis: null,
    llamadas: 0,
    errores: [],
  };
}

const POLICY: GatePolicy = { ...DEFAULT_GATE_POLICY };

// ── 1) decideGateVerdict — función pura ────────────────────────────────────────

test('pass: sin hallazgos contables → pass', () => {
  const r = decideGateVerdict(resultadoCon([]), POLICY);
  assert.equal(r.veredicto, 'pass');
  assert.equal(r.bloqueantes.length, 0);
});

test('pass: solo low/medium por debajo del umbral de revisión → pass', () => {
  const r = decideGateVerdict(
    resultadoCon([hallazgo('low', 'confirmado'), hallazgo('medium', 'confirmado')]),
    POLICY,
  );
  assert.equal(r.veredicto, 'pass');
  // El medium aislado no bloquea, pero sí aparece como recomendación (surface-only).
  assert.ok(r.recomendaciones.length >= 1);
});

test('fail: un critical confirmado → fail', () => {
  const r = decideGateVerdict(resultadoCon([hallazgo('critical', 'confirmado')]), POLICY);
  assert.equal(r.veredicto, 'fail');
  assert.equal(r.bloqueantes.length, 1);
  assert.equal(r.bloqueantes[0]?.severidad, 'critical');
  // La dimensión se extrae del prefijo '[fidelidad]'.
  assert.equal(r.bloqueantes[0]?.dimension, 'fidelidad');
});

test('revisar: un high (con failOn=critical) → revisar, no fail', () => {
  const r = decideGateVerdict(resultadoCon([hallazgo('high', 'confirmado')]), POLICY);
  assert.equal(r.veredicto, 'revisar');
  assert.equal(r.bloqueantes.length, 1);
});

test('revisar: 3 medium confirmados → revisar por reviewOnMediumCount', () => {
  const r = decideGateVerdict(
    resultadoCon([
      hallazgo('medium', 'confirmado'),
      hallazgo('medium', 'confirmado'),
      hallazgo('medium', 'confirmado'),
    ]),
    POLICY,
  );
  assert.equal(r.veredicto, 'revisar');
  assert.equal(r.bloqueantes.length, 3);
});

test('pass: 2 medium confirmados (< 3) → pass', () => {
  const r = decideGateVerdict(
    resultadoCon([hallazgo('medium', 'confirmado'), hallazgo('medium', 'confirmado')]),
    POLICY,
  );
  assert.equal(r.veredicto, 'pass');
});

test('estados no contables: falso-positivo/descartado/arreglado NO cuentan', () => {
  const r = decideGateVerdict(
    resultadoCon([
      hallazgo('critical', 'falso-positivo'),
      hallazgo('critical', 'descartado'),
      hallazgo('high', 'arreglado'),
    ]),
    POLICY,
  );
  assert.equal(r.veredicto, 'pass');
  assert.equal(r.bloqueantes.length, 0);
  assert.equal(r.recomendaciones.length, 0);
});

test('countUnverified=true (default): un critical ABIERTO cuenta → fail', () => {
  const r = decideGateVerdict(resultadoCon([hallazgo('critical', 'abierto')]), POLICY);
  assert.equal(r.veredicto, 'fail');
});

test('countUnverified=false: un critical ABIERTO NO cuenta → pass', () => {
  const policy: GatePolicy = { ...DEFAULT_GATE_POLICY, countUnverified: false };
  const r = decideGateVerdict(resultadoCon([hallazgo('critical', 'abierto')]), policy);
  assert.equal(r.veredicto, 'pass');
});

test('failOn=high: un high confirmado → fail (política más estricta)', () => {
  const policy: GatePolicy = { ...DEFAULT_GATE_POLICY, failOn: 'high' };
  const r = decideGateVerdict(resultadoCon([hallazgo('high', 'confirmado')]), policy);
  assert.equal(r.veredicto, 'fail');
});

test('fail incluye los high como bloqueantes junto al critical, ordenados por severidad', () => {
  const r = decideGateVerdict(
    resultadoCon([
      hallazgo('high', 'confirmado', 'voces-diarizacion'),
      hallazgo('critical', 'confirmado', 'animacion-movimiento'),
    ]),
    POLICY,
  );
  assert.equal(r.veredicto, 'fail');
  assert.equal(r.bloqueantes.length, 2);
  // Ordenados por severidad desc → critical primero.
  assert.equal(r.bloqueantes[0]?.severidad, 'critical');
  assert.equal(r.bloqueantes[1]?.severidad, 'high');
});

// ── 2) runQualityGate — cableado a runFormatAudit vía deps (sin IA) ─────────────

test('runQualityGate: usa deps.runFormatSpecialist (stub) y deriva el veredicto', async () => {
  // El stub devuelve un critical para CUALQUIER especialista que reciba frames del
  // render. Como pasamos renderKeyframePaths, al menos un especialista corre.
  const stubSpecialist: NonNullable<FormatAuditDeps['runFormatSpecialist']> = async (): Promise<SpecialistOutput> => ({
    resumen: 'stub',
    hallazgos: [
      {
        titulo: 'recorte sucio',
        severidad: 'critical',
        descripcion: 'halo verde en el PiP',
        evidencia: 'borde translúcido',
        fixPropuesto: 'rehacer el chroma+despill',
        confianza: 0.9,
      },
    ],
  });
  // Verificador stub: confirma todo (para que el critical cuente sí o sí).
  const stubVerifier: NonNullable<FormatAuditDeps['runVerifier']> = async () => ({
    veredicto: 'confirmado',
    razon: 'se ve claro',
  });
  const stubSynthesis: NonNullable<FormatAuditDeps['runSynthesis']> = async () => null;

  const report = await runQualityGate({
    // contextText no vacío → los especialistas corren aunque no haya frames legibles
    // (en runFormatAudit, sin frames Y sin contexto se saltan).
    contextText: 'Formato de prueba con PiP recortado.',
    renderKeyframePaths: ['/no/existe/frame1.png'], // se omite al leer; el stub no mira frames reales
    label: 'test cableado',
    deps: {
      runFormatSpecialist: stubSpecialist,
      runVerifier: stubVerifier,
      runSynthesis: stubSynthesis,
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.veredicto, 'fail');
  assert.ok(report.bloqueantes.some((b) => b.severidad === 'critical'));
  assert.ok(report.auditId.startsWith('format-audit/'));
  assert.equal(report.comparedWithOriginal, false);
  // La política efectiva quedó registrada (auditable).
  assert.equal(report.policy.failOn, DEFAULT_GATE_POLICY.failOn);
});

test('runQualityGate: panel sin hallazgos → pass', async () => {
  const noopSpecialist: NonNullable<FormatAuditDeps['runFormatSpecialist']> = async (): Promise<SpecialistOutput> => ({
    resumen: 'sin defectos',
    hallazgos: [],
  });
  const report = await runQualityGate({
    renderKeyframePaths: ['/no/existe/frame1.png'],
    label: 'test pass',
    deps: { runFormatSpecialist: noopSpecialist },
  });
  assert.equal(report.veredicto, 'pass');
  assert.equal(report.bloqueantes.length, 0);
});
