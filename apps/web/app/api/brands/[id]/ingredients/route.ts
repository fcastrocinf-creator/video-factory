import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated } from '@/lib/auth';
import { readBrand, updateBrandIngredients } from '@/lib/brand-ingredients-store';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const brand = await readBrand(params.id);
    return NextResponse.json({
      brandId: brand.id,
      displayName: brand.displayName,
      ingredients: brand.ingredients,
      products: brand.products,
      brandColors: brand.brandColors,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Marca no encontrada: ${(e as Error).message}` },
      { status: 404 },
    );
  }
}

const UpdateBodySchema = z.object({
  mustInclude: z.array(z.string()).optional(),
  mustAvoid: z.array(z.string()).optional(),
  colorPalette: z
    .array(
      z.object({
        name: z.string(),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        usage: z.string().optional(),
      }),
    )
    .optional(),
  logoPlacement: z
    .enum(['last-scene', 'all-scenes', 'product-scenes', 'never'])
    .optional(),
  logoDescription: z.string().optional(),
});

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
  const parsed = UpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const updated = await updateBrandIngredients({
    brandId: params.id,
    ...parsed.data,
  });
  return NextResponse.json({ ingredients: updated.ingredients });
}
