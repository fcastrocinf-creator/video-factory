import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, rips } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const result = await db.select().from(rips).where(eq(rips.id, params.id)).limit(1);
  const rip = result[0];
  if (!rip) {
    return NextResponse.json({ error: 'Rip no encontrado' }, { status: 404 });
  }
  return NextResponse.json({
    id: rip.id,
    status: rip.status,
    videoFileName: rip.videoFileName,
    videoBytes: rip.videoBytes,
    errorMessage: rip.errorMessage,
    createdAt: rip.createdAt,
    analyzedAt: rip.analyzedAt,
    analysis: rip.analysisJson ? JSON.parse(rip.analysisJson) : null,
  });
}
