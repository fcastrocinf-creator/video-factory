// POST /api/promptlab — arranca un objetivo en el Laboratorio (modo CREAR por
// intención). Corre en background; la UI pollea GET /api/promptlab/[id].

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { runPromptLab } from '@/lib/promptlab/service';

export const runtime = 'nodejs';

const Schema = z.object({
  intention: z.string().min(5),
  brandId: z.string().optional(),
  threshold: z.number().min(50).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(8).optional(),
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
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const id = randomUUID();
  void runPromptLab(id, {
    mode: 'crear',
    intention: parsed.data.intention,
    brandId: parsed.data.brandId,
    threshold: parsed.data.threshold,
    maxAttempts: parsed.data.maxAttempts,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[promptlab] uncaught', id, e);
  });
  return NextResponse.json({ id });
}
