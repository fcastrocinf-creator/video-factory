// /api/debug/env-check
//
// Endpoint diagnóstico: confirma qué keys están disponibles en process.env
// del worker de Next.js (sin exponer valores). Útil para diagnosticar
// problemas de carga del .env desde el root del monorepo.
//
// Devuelve solo presence/length, NUNCA valores.

import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

function presence(key: string): { present: boolean; length: number } {
  const v = process.env[key];
  return {
    present: !!v && v.length > 0,
    length: v?.length ?? 0,
  };
}

export async function GET(): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    process_pid: process.pid,
    runtime_node_version: process.version,
    cwd: process.cwd(),
    keys: {
      ANTHROPIC_API_KEY: presence('ANTHROPIC_API_KEY'),
      OPENAI_API_KEY: presence('OPENAI_API_KEY'),
      GOOGLE_AI_API_KEY: presence('GOOGLE_AI_API_KEY'),
      KLING_ACCESS_KEY: presence('KLING_ACCESS_KEY'),
      ELEVENLABS_API_KEY: presence('ELEVENLABS_API_KEY'),
      HIGGSFIELD_KEY_ID: presence('HIGGSFIELD_KEY_ID'),
    },
  });
}
