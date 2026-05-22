import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { listActiveRuns, listTrashedRuns } from '@/lib/runs-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/runs?brandId=&productId=&status=&trash=1
export async function GET(req: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const url = new URL(req.url);
  const trash = url.searchParams.get('trash') === '1';
  if (trash) {
    const items = await listTrashedRuns();
    return NextResponse.json({ runs: items });
  }
  const brandId = url.searchParams.get('brandId') ?? undefined;
  const productIdParam = url.searchParams.get('productId');
  const productId =
    productIdParam === null || productIdParam === ''
      ? undefined
      : productIdParam === 'none'
        ? null
        : productIdParam;
  const status = (url.searchParams.get('status') as 'completed' | 'failed' | null) ?? undefined;
  // No usamos `productId ?? undefined` porque eso aplastaría `null` a `undefined`,
  // y `null` significa explícitamente "filtrar runs SIN producto asignado".
  const items = await listActiveRuns({
    brandId,
    productId,
    status: status ?? undefined,
  });
  return NextResponse.json({ runs: items });
}
