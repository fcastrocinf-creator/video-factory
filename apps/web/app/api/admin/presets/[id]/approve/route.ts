// POST /api/admin/presets/[id]/approve → mueve el preset de pending/ a PRESETS_DIR.
//
// FEEDBACK LOOP (M7 #3, 25-may-2026): además de mover el preset, registramos
// un juicio 'approved' en `storage/preset-memory/judgments.jsonl`. Esto alimenta
// el "cerebro" — el sistema acumula datos reales de qué presets el owner valida,
// y futuros flows pueden recomendar con weight basado en juicios pasados.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { approvePendingPreset } from '@/lib/admin-presets-store';
import { recordPresetJudgment } from '@video-factory/core';
import { logSystemEvent } from '@/lib/system-log';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const approved = await approvePendingPreset(params.id);
    // Registrar juicio (best-effort) + log al system event log
    // Weight 1.5: aprobación humana tiene mayor peso que un run-success automático
    void recordPresetJudgment({
      presetId: params.id,
      kind: 'approved',
      weight: 1.5,
      context: {
        displayName: approved.displayName,
        format: approved.format?.id,
        style: approved.style?.id,
        visualEngine: approved.visualEngine,
        approvedFromPending: true,
      },
      notes: `Owner aprobó preset "${approved.displayName}" desde /admin`,
    });
    void logSystemEvent({
      kind: 'preset-approved',
      data: {
        presetId: params.id,
        displayName: approved.displayName,
        format: approved.format?.id,
        style: approved.style?.id,
        triggerSource: 'admin-approve',
      },
      summary: `Owner aprobó preset "${approved.displayName}" en /admin`,
    });
    return NextResponse.json({ preset: approved });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /no encontrado/i.test(msg) ? 404 : /ya existe/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
