// GET /api/promptlab/[id]/image?file=iterNN.png — sirve una imagen de iteración.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { promptLabRunDir } from '@/lib/paths';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const file = new URL(req.url).searchParams.get('file') ?? '';
  const safe = basename(file); // anti path-traversal
  if (!/^iter\d+\.png$/.test(safe)) {
    return NextResponse.json({ error: 'archivo inválido' }, { status: 400 });
  }
  const fp = resolve(promptLabRunDir(params.id), safe);
  if (!existsSync(fp)) {
    return NextResponse.json({ error: 'no existe' }, { status: 404 });
  }
  const buf = await readFile(fp);
  return new NextResponse(new Uint8Array(buf), {
    headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' },
  });
}
