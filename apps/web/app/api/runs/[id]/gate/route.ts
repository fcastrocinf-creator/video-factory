// GET /api/runs/[id]/gate
//
// Fase 1 del círculo de mejora ("Mostrar") — devuelve el reporte del quality gate
// (veredicto + bloqueantes + recomendaciones) que el pipeline produjo para este run,
// para que la UI lo muestre en RunViewer. El gate se persiste en la KB scoped por
// runId (scope = `gate:<runId>`). Si no existe (run viejo o sin VF_GATE_ON_RENDER),
// se devuelve null — la UI lo gestiona silenciosamente.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { readQualityGateReport, type QualityGateReport } from '@/lib/kb/findings';
import { planRepairs } from '@/lib/kb/repair-loop';
import type { RepairTarget } from '@/lib/kb/quality-gate';

export const runtime = 'nodejs';

interface GateResponse {
  qualityGate: QualityGateReport | null;
  repairs: RepairTarget[];
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  // El gate se guarda en la KB con scope `gate:<runId>` (quality-gate.ts).
  // best-effort: si el reporte no existe todavía, queda null.
  let qualityGate: QualityGateReport | null = null;
  try {
    qualityGate = await readQualityGateReport(`gate:${params.id}`);
  } catch {
    qualityGate = null;
  }

  // Fase 2 ("Aplicar"): por cada bloqueante, qué reparación haría falta — SIN ejecutar
  // nada (nada se auto-aplica). El owner decide. Hoy: editar vs escalar (sin sceneIndex).
  const repairs = qualityGate ? planRepairs(qualityGate) : [];
  const response: GateResponse = { qualityGate, repairs };
  return NextResponse.json(response);
}
