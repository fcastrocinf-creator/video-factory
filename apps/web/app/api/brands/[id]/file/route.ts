import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import {
  isBrandStoragePathSafe,
  inferContentTypeFromPath,
  readBrand,
} from '@/lib/brand-ingredients-store';

export const runtime = 'nodejs';

// GET /api/brands/[id]/file?which=logo
// GET /api/brands/[id]/file?which=asset&assetId=<id>
// Sirve el binario del logo o un asset específico, validando que el path
// esté contenido dentro del storage de la marca (anti path traversal).
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const url = new URL(req.url);
  const which = url.searchParams.get('which');
  const assetId = url.searchParams.get('assetId');

  let path: string | undefined;
  try {
    const brand = await readBrand(params.id);
    if (which === 'logo') {
      path = brand.ingredients?.logoPath ?? brand.logoPath;
    } else if (which === 'asset' && assetId) {
      path = brand.ingredients?.assets.find((a) => a.id === assetId)?.path;
    } else {
      return NextResponse.json({ error: 'parámetro "which" requerido (logo|asset)' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Marca no encontrada' }, { status: 404 });
  }

  if (!path) {
    return NextResponse.json({ error: 'Archivo no configurado' }, { status: 404 });
  }
  if (!isBrandStoragePathSafe(params.id, path)) {
    return NextResponse.json({ error: 'Path inválido' }, { status: 403 });
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return NextResponse.json({ error: 'No se pudo leer el archivo' }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'content-type': inferContentTypeFromPath(path),
      'cache-control': 'private, max-age=60',
    },
  });
}
