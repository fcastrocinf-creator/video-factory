// POST /api/runs/[id]/validator-chat-ia/chat
//
// Endpoint conversacional con la entidad VALIDATOR CHAT IA. El owner manda un
// mensaje (free-form) y opcionalmente un sceneIndex (foco). VALIDATOR:
//   - Carga el contexto completo del run (history de veredictos, anti-patrones,
//     overrides activos, holistic verdict si existe).
//   - Carga el historial de chat externo previo (multi-turn).
//   - Responde conversacionalmente.
//   - Si detecta una acción (add-override, request-revalidation, etc.) la
//     ejecuta o reporta para que la UI la ejecute.
//
// GET /api/runs/[id]/validator-chat-ia/chat
// Devuelve el historial del chat externo para que la UI lo renderice.

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { createLogger } from '@video-factory/core';
import {
  processExternalChat,
  readExternalChatTurns,
} from '@/lib/validator-chat-ia-external-chat';
import { VALIDATOR_NAME } from '@/lib/validator-chat-ia';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RequestBodySchema = z.object({
  message: z.string().min(1).max(4000),
  sceneIndex: z.number().int().nonnegative().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  // Validar que el run existe
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

  const logger = createLogger(`chat-${params.id.slice(0, 8)}`);

  const result = await processExternalChat({
    runId: params.id,
    ownerMessage: body.message,
    sceneIndex: body.sceneIndex,
    logger,
  });

  if (!result.response) {
    return NextResponse.json(
      {
        entity: VALIDATOR_NAME,
        error: result.error ?? { type: 'unknown', message: 'No response' },
        durationMs: result.durationMs,
      },
      { status: result.error?.type === 'no-api-key' ? 503 : 500 },
    );
  }

  return NextResponse.json({
    entity: VALIDATOR_NAME,
    response: result.response,
    appliedActions: result.appliedActions,
    durationMs: result.durationMs,
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
  const turns = await readExternalChatTurns(params.id);
  return NextResponse.json({
    entity: VALIDATOR_NAME,
    runId: params.id,
    turnCount: turns.length,
    turns,
  });
}
