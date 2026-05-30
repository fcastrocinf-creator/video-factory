// GET /api/runs/[id]/validator-history
//
// Devuelve el historial completo del VALIDATOR CHAT IA para un run específico.
// Cada entrada es un veredicto sobre UNA escena en UN attempt determinado:
//   - imagen estática + 3 keyframes evaluados
//   - verdict 'right' o 'wrong'
//   - issues categorizados (anatomy, unhealthy-character, burned-text-hex-codes,
//     static-loop, gallery-mode, etc.)
//   - correctedImagePrompt / correctedMotionPrompt que VALIDATOR propuso
//
// El JSONL se persiste en `storage/validator-chat-ia/<runId>/history.jsonl`.
//
// La UI en /runs/[id] muestra esto como el "chat" de la entidad nombrada:
// cada validación es una "mensaje" de VALIDATOR CHAT IA al pipeline.

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { readValidatorHistory, VALIDATOR_NAME } from '@/lib/validator-chat-ia';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Verificar que el run existe (no requerimos workDir — el historial vive
  // en storage/validator-chat-ia/ independientemente)
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let history: Awaited<ReturnType<typeof readValidatorHistory>> = [];
  try {
    history = await readValidatorHistory(params.id);
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo leer el historial: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Resumen agregado para que la UI no tenga que recalcular
  const sceneStats = new Map<
    number,
    {
      attempts: number;
      lastVerdict: 'right' | 'wrong' | null;
      lastConfidence: number;
      criticalCount: number;
      majorCount: number;
      minorCount: number;
      hadAnimatedClip: boolean;
    }
  >();
  for (const entry of history) {
    const prev = sceneStats.get(entry.sceneIndex) ?? {
      attempts: 0,
      lastVerdict: null as 'right' | 'wrong' | null,
      lastConfidence: 0,
      criticalCount: 0,
      majorCount: 0,
      minorCount: 0,
      hadAnimatedClip: false,
    };
    prev.attempts += 1;
    prev.hadAnimatedClip = prev.hadAnimatedClip || entry.hadAnimatedClip;
    if (entry.verdict) {
      prev.lastVerdict = entry.verdict.verdict;
      prev.lastConfidence = entry.verdict.confidence;
      for (const iss of entry.verdict.issues) {
        if (iss.severity === 'critical') prev.criticalCount += 1;
        else if (iss.severity === 'major') prev.majorCount += 1;
        else prev.minorCount += 1;
      }
    }
    sceneStats.set(entry.sceneIndex, prev);
  }

  const summary = {
    entity: VALIDATOR_NAME,
    runId: params.id,
    totalEntries: history.length,
    scenesEvaluated: sceneStats.size,
    scenesApproved: Array.from(sceneStats.values()).filter((s) => s.lastVerdict === 'right')
      .length,
    scenesRejected: Array.from(sceneStats.values()).filter((s) => s.lastVerdict === 'wrong')
      .length,
    scenesWithApiError: Array.from(sceneStats.values()).filter((s) => s.lastVerdict === null)
      .length,
    perScene: Array.from(sceneStats.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([idx, s]) => ({
        sceneIndex: idx,
        attempts: s.attempts,
        lastVerdict: s.lastVerdict,
        lastConfidence: s.lastConfidence,
        criticalCount: s.criticalCount,
        majorCount: s.majorCount,
        minorCount: s.minorCount,
        hadAnimatedClip: s.hadAnimatedClip,
      })),
  };

  return NextResponse.json({
    entity: VALIDATOR_NAME,
    summary,
    history,
  });
}
