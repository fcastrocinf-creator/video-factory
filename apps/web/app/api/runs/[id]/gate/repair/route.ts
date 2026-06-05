// POST /api/runs/[id]/gate/repair
//
// Fase 2 del círculo de mejora ("Aplicar") — el BRAZO, CON OK del owner. Recibe el
// índice del bloqueante a reparar, RE-DERIVA la reparación desde el reporte del gate
// PERSISTIDO (fuente de verdad; no confía en datos del cliente) y la EJECUTA: forkea
// el run y regenera SOLO la escena que falla. Nada se auto-aplica: lo dispara el clic.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { readQualityGateReport } from '@/lib/kb/findings';
import { planRepairs } from '@/lib/kb/repair-loop';
import { executeGateRepair } from '@/lib/repair-executor';
import { logSystemEvent } from '@/lib/system-log';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const runId = params.id;
  const rows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!rows[0]) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let body: { blockerIndex?: number } = {};
  try {
    body = (await req.json()) as { blockerIndex?: number };
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const idx = body.blockerIndex;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: 'blockerIndex inválido' }, { status: 400 });
  }

  // RE-DERIVAR la reparación desde el reporte persistido (mismo planRepairs que ve la
  // UI). No se confía en el cliente: solo manda el índice del bloqueante.
  const gate = await readQualityGateReport(`gate:${runId}`);
  if (!gate) {
    return NextResponse.json({ error: 'No hay reporte de gate para este run' }, { status: 404 });
  }
  const repairs = planRepairs(gate);
  const repair = repairs[idx];
  if (!repair) {
    return NextResponse.json({ error: `No existe el bloqueante #${idx}` }, { status: 404 });
  }

  const outcome = await executeGateRepair({ originalRunId: runId, repair });
  if (!outcome.ok) {
    // 409: la acción no es ejecutable (editor/escalar) o el run no es reparable.
    return NextResponse.json({ ok: false, error: outcome.reason }, { status: 409 });
  }

  void logSystemEvent({
    kind: 'scene-regenerated',
    data: {
      runId,
      newRunId: outcome.newRunId,
      sceneIndex: repair.sceneIndex,
      dimension: repair.blocker.dimension,
      actionKind: repair.action.kind,
      via: 'gate-repair',
    },
    summary: `Owner aprobó reparar la escena ${repair.sceneIndex} del run ${runId.slice(
      0,
      8,
    )} (${repair.blocker.dimension}) → fork ${outcome.newRunId?.slice(0, 8)}`,
  });

  return NextResponse.json({
    ok: true,
    newRunId: outcome.newRunId,
    sceneIndex: repair.sceneIndex,
    message: `Reparación encolada. Abre el run nuevo para ver el progreso.`,
  });
}
