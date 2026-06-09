// GET /api/promptlab/library — lista los prompts ganadores aprendidos.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { loadWinningPrompts } from '@/lib/promptlab/prompt-library';

export const runtime = 'nodejs';

export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const all = await loadWinningPrompts();
  const prompts = all.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return NextResponse.json({ prompts });
}
