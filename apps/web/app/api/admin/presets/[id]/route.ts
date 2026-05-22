// Endpoints REST para gestión de un preset pendiente individual.
//
//   GET    /api/admin/presets/[id]          → preset.json completo (para editar)
//   PATCH  /api/admin/presets/[id]          → aplica edits en pending/
//   DELETE /api/admin/presets/[id]          → rechaza (borra .json + .gif)
//   POST   /api/admin/presets/[id]/approve  → mueve a PRESETS_DIR (en otra ruta)
//
// Todos requieren auth. El presetId se valida con SAFE_ID_REGEX en el store.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import {
  readPendingPreset,
  rejectPendingPreset,
  editPendingPreset,
} from '@/lib/admin-presets-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const preset = await readPendingPreset(params.id);
    return NextResponse.json({ preset });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: /no encontrado/i.test((e as Error).message) ? 404 : 400 },
    );
  }
}

const EditBodySchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  defaultDurationSeconds: z.number().positive().optional(),
  scenesPerMinute: z.number().positive().optional(),
  visualEngine: z
    .enum(['imagen4', 'veo-lite', 'veo-fast', 'veo-standard', 'higgsfield'])
    .optional(),
  estrategia: z.enum(['plano_fijo', 'multi_escena']).optional(),
  category: z
    .object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string().optional(),
    })
    .optional(),
  format: z
    .object({
      id: z.enum([
        'b-roll-static',
        'b-roll-animated',
        'ugc-broll',
        'ugc-testimony',
        'vsl',
        'voiceover-animated',
      ]),
      displayName: z.string().min(1),
      description: z.string().optional(),
    })
    .optional(),
  visualStyle: z
    .object({
      promptTemplate: z.string().optional(),
      negativePrompt: z.string().optional(),
    })
    .optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = EditBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  try {
    const updated = await editPendingPreset(params.id, parsed.data);
    return NextResponse.json({ preset: updated });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    await rejectPendingPreset(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
