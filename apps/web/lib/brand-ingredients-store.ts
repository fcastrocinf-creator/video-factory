// Persistencia de Brand Ingredients en filesystem.
//
// Layout en disco:
//   packages/brands/<brand-id>.brand.json        ← config (incluye ingredients)
//   storage/brands/<brand-id>/logo.<ext>         ← logo binario
//   storage/brands/<brand-id>/assets/<id>.<ext>  ← productos / mockups / etc.
//
// Las rutas (logoPath, asset.path) que guardamos en el brand.json son ABSOLUTAS.
// El pipeline las recibe tal cual y las pasa al image generator / Remotion sin
// reinterpretación.

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import {
  BrandConfigSchema,
  type BrandConfig,
  type BrandIngredients,
} from '@video-factory/contracts';
import { BRANDS_DIR, STORAGE_DIR } from './paths';

export function brandConfigPath(brandId: string): string {
  return join(BRANDS_DIR, `${brandId}.brand.json`);
}

export function brandStorageDir(brandId: string): string {
  return resolve(STORAGE_DIR, 'brands', brandId);
}

export function brandAssetsDir(brandId: string): string {
  return resolve(brandStorageDir(brandId), 'assets');
}

export async function readBrand(brandId: string): Promise<BrandConfig> {
  const raw = await readFile(brandConfigPath(brandId), 'utf-8');
  return BrandConfigSchema.parse(JSON.parse(raw));
}

export async function writeBrand(brand: BrandConfig): Promise<void> {
  const updated = { ...brand, updatedAt: new Date().toISOString() };
  await writeFile(brandConfigPath(brand.id), JSON.stringify(updated, null, 2), 'utf-8');
}

export async function ensureBrandDirs(brandId: string): Promise<void> {
  await mkdir(brandAssetsDir(brandId), { recursive: true });
}

export interface SaveLogoArgs {
  brandId: string;
  buffer: Buffer;
  contentType: string; // image/png | image/jpeg | image/webp | image/svg+xml
  description?: string;
  placement?: BrandIngredients['logoPlacement'];
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export async function saveBrandLogo(args: SaveLogoArgs): Promise<BrandConfig> {
  const ext = CONTENT_TYPE_EXT[args.contentType];
  if (!ext) throw new Error(`Tipo de logo no soportado: ${args.contentType}`);

  await ensureBrandDirs(args.brandId);
  const logoPath = resolve(brandStorageDir(args.brandId), `logo.${ext}`);
  await writeFile(logoPath, args.buffer);

  const brand = await readBrand(args.brandId);
  const updated: BrandConfig = {
    ...brand,
    logoPath, // legacy field — lo dejamos por compatibilidad con código viejo
    ingredients: {
      ...brand.ingredients,
      logoPath,
      logoDescription: args.description ?? brand.ingredients.logoDescription,
      logoPlacement: args.placement ?? brand.ingredients.logoPlacement,
    },
  };
  await writeBrand(updated);
  return updated;
}

export interface SaveAssetArgs {
  brandId: string;
  buffer: Buffer;
  contentType: string;
  kind: 'product-shot' | 'packaging' | 'mockup' | 'lifestyle' | 'icon' | 'other';
  description: string;
  // Si se provee, sobreescribe un asset existente; si no, genera un id nuevo.
  assetId?: string;
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export async function saveBrandAsset(args: SaveAssetArgs): Promise<BrandConfig> {
  const ext = ASSET_CONTENT_TYPES[args.contentType];
  if (!ext) throw new Error(`Tipo de asset no soportado: ${args.contentType}`);
  if (!args.description?.trim()) {
    throw new Error('description es requerida para que la IA reconozca el asset');
  }

  await ensureBrandDirs(args.brandId);
  const assetId = args.assetId ?? `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = resolve(brandAssetsDir(args.brandId), `${assetId}.${ext}`);
  await writeFile(path, args.buffer);

  const brand = await readBrand(args.brandId);
  const existingIdx = brand.ingredients.assets.findIndex((a) => a.id === assetId);
  const newAsset = {
    id: assetId,
    path,
    kind: args.kind,
    description: args.description.trim(),
  };
  const assets = [...brand.ingredients.assets];
  if (existingIdx >= 0) {
    assets[existingIdx] = newAsset;
  } else {
    assets.push(newAsset);
  }

  const updated: BrandConfig = {
    ...brand,
    ingredients: { ...brand.ingredients, assets },
  };
  await writeBrand(updated);
  return updated;
}

export async function deleteBrandAsset(brandId: string, assetId: string): Promise<BrandConfig> {
  const brand = await readBrand(brandId);
  const target = brand.ingredients.assets.find((a) => a.id === assetId);
  if (target && existsSync(target.path)) {
    try {
      await unlink(target.path);
    } catch {
      // archivo huérfano — no es crítico
    }
  }
  const updated: BrandConfig = {
    ...brand,
    ingredients: {
      ...brand.ingredients,
      assets: brand.ingredients.assets.filter((a) => a.id !== assetId),
    },
  };
  await writeBrand(updated);
  return updated;
}

export interface UpdateIngredientsArgs {
  brandId: string;
  mustInclude?: string[];
  mustAvoid?: string[];
  colorPalette?: BrandIngredients['colorPalette'];
  logoPlacement?: BrandIngredients['logoPlacement'];
  logoDescription?: string;
}

export async function updateBrandIngredients(args: UpdateIngredientsArgs): Promise<BrandConfig> {
  const brand = await readBrand(args.brandId);
  const updated: BrandConfig = {
    ...brand,
    ingredients: {
      ...brand.ingredients,
      ...(args.mustInclude !== undefined ? { mustInclude: args.mustInclude } : {}),
      ...(args.mustAvoid !== undefined ? { mustAvoid: args.mustAvoid } : {}),
      ...(args.colorPalette !== undefined ? { colorPalette: args.colorPalette } : {}),
      ...(args.logoPlacement !== undefined ? { logoPlacement: args.logoPlacement } : {}),
      ...(args.logoDescription !== undefined ? { logoDescription: args.logoDescription } : {}),
    },
  };
  await writeBrand(updated);
  return updated;
}

// Sirve un archivo del brand storage de forma segura: solo paths dentro de
// storage/brands/<id>/. Cualquier intento de path traversal es rechazado.
export function isBrandStoragePathSafe(brandId: string, candidatePath: string): boolean {
  const base = brandStorageDir(brandId);
  const normalized = resolve(candidatePath);
  return normalized.startsWith(base + (process.platform === 'win32' ? '\\' : '/')) ||
    normalized === base;
}

export function inferContentTypeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    }[ext] ?? 'application/octet-stream'
  );
}
