import { readFile, stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const result = await db.select().from(runs).where(eq(runs.id, params.id)).limit(1);
  const run = result[0];
  if (!run || !run.outputPath) {
    return NextResponse.json({ error: 'Video no disponible' }, { status: 404 });
  }

  let buffer: Buffer;
  let size: number;
  try {
    [buffer, size] = await Promise.all([
      readFile(run.outputPath),
      stat(run.outputPath).then((s) => s.size),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `No se pudo leer el archivo: ${message}` }, { status: 500 });
  }

  const url = new URL(req.url);
  const isDownload = url.searchParams.get('download') === '1';
  const headers: Record<string, string> = {
    'content-type': 'video/mp4',
    'content-length': size.toString(),
    'cache-control': 'private, no-store',
  };
  if (isDownload) {
    headers['content-disposition'] = `attachment; filename="video-${params.id}.mp4"`;
  }

  // TS strict: Web Response requiere Uint8Array<ArrayBuffer> (no ArrayBufferLike).
  // new Uint8Array(buffer) copia los bytes a un ArrayBuffer fresco y satisface el tipo.
  // El copy es despreciable para los tamaños de video MVP (<50 MB).
  return new NextResponse(new Uint8Array(buffer), { headers });
}
