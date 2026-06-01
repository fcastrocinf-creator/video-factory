// API de conversaciones del Copilot, POR USUARIO. Base del multi-usuario:
// cada persona (hoy identificada por su navegador; mañana por su login) tiene su
// propio historial. Todo queda grabado para, más adelante, mezclarlo (cerebro común).
//
//   GET  /api/copilot/conversations?userId=U            → lista [{id,title,updatedAt}]
//   GET  /api/copilot/conversations?userId=U&id=C       → conversación completa
//   POST /api/copilot/conversations  {userId,conversationId?,messages} → guarda

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { CONVERSATIONS_DIR } from '@/lib/paths';

export const runtime = 'nodejs';

// Evita path traversal: solo permitimos ids "seguros".
function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const SaveSchema = z.object({
  userId: z.string().min(1),
  conversationId: z.string().optional(),
  messages: z.array(MessageSchema).min(1).max(200),
});

interface StoredConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

function titleFrom(messages: Array<{ role: string; content: string }>): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const t = (firstUser?.content ?? 'Conversación').replace(/\s+/g, ' ').trim();
  return t.slice(0, 48) || 'Conversación';
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const url = new URL(req.url);
  const userId = safeId(url.searchParams.get('userId') ?? '');
  const id = url.searchParams.get('id');
  if (!userId) return NextResponse.json({ error: 'userId requerido' }, { status: 400 });
  const dir = resolve(CONVERSATIONS_DIR, userId);

  if (id) {
    const sid = safeId(id);
    if (!sid) return NextResponse.json({ error: 'id inválido' }, { status: 400 });
    try {
      const raw = await readFile(resolve(dir, `${sid}.json`), 'utf-8');
      return NextResponse.json(JSON.parse(raw) as StoredConversation);
    } catch {
      return NextResponse.json({ error: 'Conversación no encontrada' }, { status: 404 });
    }
  }

  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const items: Array<{ id: string; title: string; updatedAt: string }> = [];
    for (const f of files) {
      try {
        const c = JSON.parse(await readFile(resolve(dir, f), 'utf-8')) as StoredConversation;
        items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch {
        // archivo corrupto: lo ignoramos.
      }
    }
    items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return NextResponse.json({ conversations: items.slice(0, 50) });
  } catch {
    return NextResponse.json({ conversations: [] });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const userId = safeId(parsed.data.userId);
  if (!userId) return NextResponse.json({ error: 'userId inválido' }, { status: 400 });
  const dir = resolve(CONVERSATIONS_DIR, userId);
  await mkdir(dir, { recursive: true });

  // Si el id viene pero queda vacío tras sanear (solo símbolos), creamos uno nuevo
  // en vez de escribir un archivo basura ".json".
  const sanitized = parsed.data.conversationId ? safeId(parsed.data.conversationId) : '';
  const id = sanitized || `c-${randomUUID()}`;
  const title = titleFrom(parsed.data.messages);
  const now = new Date().toISOString();

  // Conservar createdAt si la conversación ya existía.
  let createdAt = now;
  try {
    const existing = JSON.parse(await readFile(resolve(dir, `${id}.json`), 'utf-8')) as StoredConversation;
    if (existing.createdAt) createdAt = existing.createdAt;
  } catch {
    // no existía: createdAt = ahora.
  }

  const conv: StoredConversation = {
    id,
    userId,
    title,
    createdAt,
    updatedAt: now,
    messages: parsed.data.messages,
  };
  await writeFile(resolve(dir, `${id}.json`), JSON.stringify(conv), 'utf-8');
  return NextResponse.json({ conversationId: id, title });
}
