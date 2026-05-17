import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { runPipeline } from '@/lib/pipeline';
import { workDirFor } from '@/lib/paths';

export const runtime = 'nodejs';

const GenerateRequestSchema = z.object({
  brandId: z.string().min(1),
  presetId: z.string().min(1),
  script: z.string().min(10),
});

export async function POST(req: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = GenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { brandId, presetId, script } = parsed.data;
  const runId = randomUUID();
  const workDir = workDirFor(runId);

  await db.insert(runs).values({
    id: runId,
    brandId,
    presetId,
    scriptRaw: script,
    status: 'pending',
    workDir,
    progress: 0,
  });

  // Fire-and-forget. El proceso Node mantiene la promesa viva hasta que termine.
  // Para producción habría que usar BullMQ u otra cola, pero el MVP corre local-only.
  void runPipeline(runId, brandId, presetId, script).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[pipeline] uncaught error for run', runId, err);
  });

  return NextResponse.json({ runId });
}
