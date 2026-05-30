// /api/admin/auto-fix
//
// POST: dispara el procesamiento del queue de errores. Para cada error:
//   1. Claude Sonnet analiza el error + (si tiene) el archivo afectado
//   2. Propone un fix con confidence
//   3. Si confidence >= 85% Y riskAssessment safe Y < 30 líneas → auto-aplica
//      (con backup + typecheck; revierte si rompe)
//   4. Si confidence menor → encola para review humano
//   5. Todo se logea en storage/auto-fix/journal.jsonl
//
// GET: devuelve el journal + queue actual para que la UI los muestre.

import { NextResponse, type NextRequest } from 'next/server';
import { resolve } from 'node:path';
import { isAuthenticated } from '@/lib/auth';
import {
  captureError,
  ErrorReportSchema,
  processAutoFixQueue,
  readJournal,
  readPendingErrors,
} from '@/lib/auto-fix';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 600;

const REPO_ROOT = resolve(process.cwd(), '..', '..');

// POST: trigger processing (puede tardar 5-15 min si hay muchos errores)
export async function POST(req: NextRequest) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Body opcional: { manualError?: ErrorReport } → permite agregar 1 error manual y procesar
  try {
    const body = await req.json().catch(() => ({}));
    const manualErrorSchema = z.object({
      manualError: ErrorReportSchema.omit({ id: true, timestampIso: true }).optional(),
    });
    const parsed = manualErrorSchema.safeParse(body);
    if (parsed.success && parsed.data.manualError) {
      await captureError(parsed.data.manualError);
    }
  } catch {
    /* body opcional, ignoramos */
  }

  const results = await processAutoFixQueue(REPO_ROOT);
  const summary = {
    total: results.length,
    applied: results.filter((r) => r.status === 'applied').length,
    queued: results.filter((r) => r.status === 'queued-for-review').length,
    rejected: results.filter((r) => r.status === 'rejected-too-risky').length,
    noFix: results.filter((r) => r.status === 'no-fix-found').length,
    failed: results.filter((r) => r.status === 'apply-failed-reverted').length,
    forbidden: results.filter((r) => r.status === 'forbidden-path').length,
  };

  return NextResponse.json({
    summary,
    results: results.map((r) => ({
      errorId: r.errorId,
      status: r.status,
      proposal: r.proposal
        ? {
            targetFile: r.proposal.targetFile,
            description: r.proposal.description,
            confidence: r.proposal.confidence,
            riskAssessment: r.proposal.riskAssessment,
            estimatedLinesChanged: r.proposal.estimatedLinesChanged,
            reasoning: r.proposal.reasoning,
          }
        : null,
      applyError: r.applyError,
    })),
  });
}

// GET: state actual (queue + journal)
export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const [pending, journal] = await Promise.all([readPendingErrors(), readJournal()]);
  return NextResponse.json({
    pendingCount: pending.length,
    pending,
    journal: journal.slice(-50), // últimas 50 entries para no inflar
  });
}
