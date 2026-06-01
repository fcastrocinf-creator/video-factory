// POST /api/chat/discuss — endpoint reusable para el chat IA en cualquier
// sección de la herramienta. Llama a discussWithClaude con el contexto que
// el frontend le pase.
//
// Request body shape: ver ChatDiscussRequestSchema en lib/claude-chat-discuss.
// Response: { reply: string, elapsedSec, modelUsed, tokensUsed }.
//
// Requiere ANTHROPIC_API_KEY. Si no está, devuelve 503 (Service Unavailable).

import { NextResponse, type NextRequest } from 'next/server';
import {
  discussWithClaude,
  ChatDiscussRequestSchema,
} from '@/lib/claude-chat-discuss';
import { isAuthenticated } from '@/lib/auth';
import { appendChatLog } from '@/lib/chat-log';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Seguridad: este endpoint llama a Anthropic y (según contextType) inyecta
  // contexto interno del proyecto. NO debe ser público — exige sesión válida.
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = ChatDiscussRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validación falló', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json(
      { error: 'Anthropic API key no configurada en el servidor' },
      { status: 503 },
    );
  }

  try {
    const result = await discussWithClaude(parsed.data);
    // Registro local del turno de chat (para mejorar la app — consentido por el owner).
    const lastUser = parsed.data.conversation[parsed.data.conversation.length - 1];
    const page =
      typeof parsed.data.contextData?.['currentPage'] === 'string'
        ? (parsed.data.contextData['currentPage'] as string)
        : undefined;
    void appendChatLog({
      contextType: parsed.data.contextType,
      userMessage: lastUser?.content ?? '',
      reply: result.reply,
      page,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Claude error: ${msg.slice(0, 400)}` }, { status: 500 });
  }
}
