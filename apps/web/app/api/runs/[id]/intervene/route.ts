// POST /api/runs/[id]/intervene
//
// Endpoint del owner co-piloto en vivo. Recibe acciones que el owner toma
// durante un rip (mientras VALIDATOR corre) y las persiste para que:
//   1. El pipeline las consuma en el próximo turno
//   2. VALIDATOR las incorpore como contexto en escenas futuras
//   3. El cerebro evolutivo aprenda patrones cross-run
//
// Tipos de acción:
//   - "approve"  : force-accept la scene (skip future VALIDATOR turns)
//   - "reject"   : force-reject + (opcional) prompt nuevo para regenerar
//   - "comment"  : observación que NO bloquea pero alimenta aprendizaje
//   - "skip"     : aceptar tal cual sin validar
//   - "redirect-attention" : pedir a VALIDATOR mirar específicamente algo
//
// Body:
//   {
//     "type": "approve" | "reject" | "comment" | "skip" | "redirect-attention",
//     "sceneIndex": number | null,
//     "category"?: "style" | "anatomy" | "narrative" | ...,
//     "comment"?: "esto se ve drogada, regenerar más saludable",
//     "newImagePrompt"?: "...",
//     "newMotionPrompt"?: "..."
//   }
//
// Response:
//   {
//     "interventionId": "abc123_xyz",
//     "queuedAt": "2026-05-29T...",
//     "willBeProcessedBefore": "next scene validation turn"
//   }
//
// GET /api/runs/[id]/intervene
//   Devuelve el historial COMPLETO de intervenciones del run (procesadas + pendientes).

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import {
  InterventionCategorySchema,
  InterventionTypeSchema,
  readAllRunFeedback,
  recordIntervention,
} from '@/lib/owner-feedback';

export const runtime = 'nodejs';

const RequestBodySchema = z.object({
  type: InterventionTypeSchema,
  sceneIndex: z.number().int().nonnegative().nullable().optional(),
  category: InterventionCategorySchema.optional(),
  comment: z.string().min(1).max(2000).optional(),
  newImagePrompt: z.string().min(1).max(3000).optional(),
  newMotionPrompt: z.string().min(1).max(2000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Verificar que el run existe
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }

  let body: z.infer<typeof RequestBodySchema>;
  try {
    const raw = await req.json();
    const parsed = RequestBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body inválido: ${parsed.error.message.slice(0, 200)}` },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Body no es JSON válido' }, { status: 400 });
  }

  // Validaciones de negocio
  if (body.type === 'reject' && !body.newImagePrompt && !body.comment) {
    return NextResponse.json(
      { error: 'reject requiere newImagePrompt o comment explicando el problema' },
      { status: 400 },
    );
  }
  if (body.type === 'comment' && !body.comment) {
    return NextResponse.json(
      { error: 'comment requiere el campo "comment" con texto' },
      { status: 400 },
    );
  }

  const intervention = await recordIntervention({
    runId: params.id,
    sceneIndex: body.sceneIndex ?? null,
    type: body.type,
    category: body.category ?? null,
    comment: body.comment ?? null,
    newImagePrompt: body.newImagePrompt ?? null,
    newMotionPrompt: body.newMotionPrompt ?? null,
    context: {
      brandId: row.brandId ?? null,
      presetId: row.presetId ?? null,
      productId: row.productId ?? null,
    },
  });

  return NextResponse.json({
    interventionId: intervention.id,
    queuedAt: intervention.timestampIso,
    willBeProcessedBefore:
      body.type === 'comment'
        ? 'next VALIDATOR turn (will be injected as context)'
        : 'next scene-animator iteration',
    intervention,
  });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }
  const feedback = await readAllRunFeedback(params.id);
  return NextResponse.json({
    runId: params.id,
    totalInterventions: feedback.length,
    processed: feedback.filter((f) => f.processed).length,
    pending: feedback.filter((f) => !f.processed).length,
    interventions: feedback,
  });
}
