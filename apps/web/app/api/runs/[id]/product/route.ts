import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { reassignRunProduct } from '@/lib/runs-repository';

export const runtime = 'nodejs';

const BodySchema = z.object({
  productId: z.string().nullable(),
});

// PATCH /api/runs/[id]/product { productId: "vitaly_gotas" | null }
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  await reassignRunProduct(params.id, parsed.data.productId);
  return NextResponse.json({ ok: true, productId: parsed.data.productId });
}
