import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BrandConfigSchema } from '@video-factory/contracts';
import { loadAllBrands } from '@/lib/brand-preset-loader';
import { isAuthenticated } from '@/lib/auth';
import { BRANDS_DIR } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const brands = await loadAllBrands();
  return NextResponse.json({
    brands: brands.map((b) => ({
      id: b.id,
      displayName: b.displayName,
      logoPath: b.ingredients?.logoPath ?? b.logoPath ?? null,
      productCount: b.products.length,
      assetCount: b.ingredients?.assets.length ?? 0,
    })),
  });
}

// === POST /api/brands — crear marca nueva ============================
//
// Recibe el shape de BrandConfig (validado por Zod) y lo persiste como
// packages/brands/<id>.brand.json. El id debe ser único y seguro (alfanumérico
// + guiones), no debe colisionar con marcas existentes.
//
// El loadAllBrands() en /create, /rip, /aprendizaje lee este directorio
// directamente, así que la marca queda disponible inmediatamente sin extra config.

const SAFE_BRAND_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

const CreateBrandBodySchema = z.object({
  id: z.string().regex(SAFE_BRAND_ID, 'id inválido: usa minúsculas, números y guiones (3-41 chars)'),
  displayName: z.string().min(1).max(80),
  language: z.string().min(2).max(20).default('es'),
  products: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        dimensions: z.string().optional(),
      }),
    )
    .min(1, 'Necesitas al menos 1 producto'),
  defaultVoice: z.object({
    voiceId: z.string().min(1),
    modelId: z.string().default('eleven_multilingual_v2'),
    stability: z.number().min(0).max(1).default(0.5),
    similarity: z.number().min(0).max(1).default(0.75),
    style: z.number().min(0).max(1).default(0.3),
    speakerBoost: z.boolean().default(true),
    speedMultiplier: z.number().positive().default(1.0),
    gender: z.enum(['male', 'female', 'neutral']).default('neutral'),
    ageRange: z.string().default('30-45'),
    label: z.string().default(''),
  }),
  brandColors: z.array(z.string()).default([]),
  toneRules: z
    .object({
      avoid: z.array(z.string()).default([]),
      prefer: z.array(z.string()).default([]),
    })
    .default({ avoid: [], prefer: [] }),
});

export async function POST(req: Request) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = CreateBrandBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ') },
      { status: 400 },
    );
  }

  await mkdir(BRANDS_DIR, { recursive: true });
  const filePath = join(BRANDS_DIR, `${parsed.data.id}.brand.json`);
  if (existsSync(filePath)) {
    return NextResponse.json(
      { error: `Ya existe una marca con id "${parsed.data.id}". Elegí otro.` },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  // Validamos contra el schema completo (defensa en profundidad). El POST schema
  // es subset razonable, pero BrandConfigSchema agrega defaults para ingredients,
  // voiceLibrary, createdAt, updatedAt.
  const full = BrandConfigSchema.parse({
    ...parsed.data,
    voiceLibrary: [],
    ingredients: {
      mustInclude: [],
      mustAvoid: [],
      colorPalette: [],
      assets: [],
      logoPlacement: 'last-scene',
    },
    createdAt: now,
    updatedAt: now,
  });

  await writeFile(filePath, JSON.stringify(full, null, 2), 'utf-8');

  return NextResponse.json({
    id: full.id,
    displayName: full.displayName,
    filePath,
    message: `Marca "${full.displayName}" creada. Ya aparece en /create, /rip y /aprendizaje.`,
  });
}
