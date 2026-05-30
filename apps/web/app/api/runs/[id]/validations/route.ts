// GET /api/runs/[id]/validations
//
// M3 — devuelve los artefactos de validación que el pipeline produjo durante
// el run, para que la UI los muestre en RunViewer. Lee del workDir:
//   - post-render-report.json (M5: judge post-render)
//   - editor-conversation.md (M6: loop iterativo del editor IA)
//
// Si alguno no existe (corridas viejas o que fallaron antes de llegar a esa
// etapa) se devuelve null en ese campo — la UI lo gestiona.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

interface PostRenderIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  sceneIndex?: number;
  description: string;
  suggestion?: string;
}

interface PostRenderReport {
  pass: boolean;
  totalScenes: number;
  scenesWithVideo: number;
  scenesWithStaticImageOnly: number;
  scenesMissingVisual: number;
  audioDurationSec: number;
  scenePlanDurationSec: number;
  durationMismatchSec: number;
  visualSampleSize: number;
  visualSampleAvgScore: number;
  visualSampleFailures: number;
  issues: PostRenderIssue[];
  rationale: string;
}

interface ValidationsResponse {
  postRender: PostRenderReport | null;
  editorConversationMarkdown: string | null;
  systemLogSummary: {
    runStarted?: string;
    runCompleted?: string;
    runFailed?: string;
  } | null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.workDir) {
    return NextResponse.json({ error: 'Run sin workDir' }, { status: 404 });
  }

  const response: ValidationsResponse = {
    postRender: null,
    editorConversationMarkdown: null,
    systemLogSummary: null,
  };

  // M5 — post-render-report.json
  const reportPath = resolve(run.workDir, 'post-render-report.json');
  if (existsSync(reportPath)) {
    try {
      const raw = await readFile(reportPath, 'utf-8');
      response.postRender = JSON.parse(raw) as PostRenderReport;
    } catch {
      // best-effort: corrupto se ignora
    }
  }

  // M6 — editor-conversation.md
  const convPath = resolve(run.workDir, 'editor-conversation.md');
  if (existsSync(convPath)) {
    try {
      response.editorConversationMarkdown = await readFile(convPath, 'utf-8');
    } catch {
      // best-effort
    }
  }

  return NextResponse.json(response);
}
