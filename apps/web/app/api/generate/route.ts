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
  productId: z.string().nullable().optional(),
  script: z.string().min(10),
  // Overrides opcionales desde la UI. Si vienen null o undefined, se infieren del guion.
  voiceOverride: z.string().nullable().optional(),
  narratorGenderOverride: z.enum(['male', 'female', 'neutral']).nullable().optional(),
  // v3.2 #115: modo colaborativo "Hacer video en conjunto" — pipeline pausa
  // entre cada scene esperando aprobación del owner.
  mode: z.enum(['auto', 'collaborative']).optional().default('auto'),
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

  const { brandId, presetId, productId, script, voiceOverride, narratorGenderOverride, mode } =
    parsed.data;
  const runId = randomUUID();
  const workDir = workDirFor(runId);

  await db.insert(runs).values({
    id: runId,
    brandId,
    presetId,
    productId: productId ?? null,
    scriptRaw: script,
    status: 'pending',
    workDir,
    progress: 0,
    mode,
    awaitingApproval: false,
  });

  void runPipeline(runId, brandId, presetId, script, {
    voiceOverride: voiceOverride ?? null,
    narratorGenderOverride: narratorGenderOverride ?? null,
    productId: productId ?? null,
    mode,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[pipeline] uncaught error for run', runId, err);
  });

  return NextResponse.json({ runId, mode });
}
