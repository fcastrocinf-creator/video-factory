// Persistencia de CTAs (cierres reusables) POR MARCA.
//
// Layout en disco:
//   storage/ctas/<brandId>/manifest.json     ← índice de CTAs de la marca
//   storage/ctas/<brandId>/<file>            ← binario (imagen o video)
//
// Son assets SOLO-VISUAL (sin audio ni texto) que el owner guarda para cargar o
// editar al armar un video. NO se aplican solos a ningún video — son una librería.

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CTAS_DIR } from './paths';

export const CtaItemSchema = z.object({
  id: z.string(),
  file: z.string(), // nombre de archivo dentro del dir de la marca
  type: z.enum(['image', 'video']),
  contentType: z.string(),
  label: z.string(),
  createdAt: z.string(),
});
export type CtaItem = z.infer<typeof CtaItemSchema>;

const ManifestSchema = z.object({ ctas: z.array(CtaItemSchema) });
type Manifest = z.infer<typeof ManifestSchema>;

// contentType → extensión + tipo de medio. Es también la allow-list de subida.
const CTA_CONTENT_TYPES: Record<string, { ext: string; type: 'image' | 'video' }> = {
  'image/png': { ext: 'png', type: 'image' },
  'image/jpeg': { ext: 'jpg', type: 'image' },
  'image/webp': { ext: 'webp', type: 'image' },
  'video/mp4': { ext: 'mp4', type: 'video' },
  'video/webm': { ext: 'webm', type: 'video' },
  'video/quicktime': { ext: 'mov', type: 'video' },
};
export const ACCEPTED_CTA_TYPES = Object.keys(CTA_CONTENT_TYPES);

export function ctaBrandDir(brandId: string): string {
  return resolve(CTAS_DIR, brandId);
}

function manifestPath(brandId: string): string {
  return resolve(ctaBrandDir(brandId), 'manifest.json');
}

async function readManifest(brandId: string): Promise<Manifest> {
  const p = manifestPath(brandId);
  if (!existsSync(p)) return { ctas: [] };
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(p, 'utf-8')));
    return parsed.success ? parsed.data : { ctas: [] };
  } catch {
    return { ctas: [] };
  }
}

async function writeManifest(brandId: string, m: Manifest): Promise<void> {
  await mkdir(ctaBrandDir(brandId), { recursive: true });
  await writeFile(manifestPath(brandId), JSON.stringify(m, null, 2), 'utf-8');
}

/** Lista los CTAs de una marca (más nuevos primero). */
export async function listCtas(brandId: string): Promise<CtaItem[]> {
  const m = await readManifest(brandId);
  return [...m.ctas].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface SaveCtaArgs {
  brandId: string;
  buffer: Buffer;
  contentType: string;
  label: string;
}

/** Guarda un CTA nuevo (imagen o video) y actualiza el manifest. */
export async function saveCta(args: SaveCtaArgs): Promise<CtaItem> {
  const meta = CTA_CONTENT_TYPES[args.contentType];
  if (!meta) throw new Error(`Tipo de CTA no soportado: ${args.contentType}`);
  await mkdir(ctaBrandDir(args.brandId), { recursive: true });
  const id = `cta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.${meta.ext}`;
  await writeFile(resolve(ctaBrandDir(args.brandId), file), args.buffer);
  const item: CtaItem = {
    id,
    file,
    type: meta.type,
    contentType: args.contentType,
    label: args.label.trim() || 'CTA sin nombre',
    createdAt: new Date().toISOString(),
  };
  const m = await readManifest(args.brandId);
  m.ctas.push(item);
  await writeManifest(args.brandId, m);
  return item;
}

/** Borra un CTA (archivo + entrada). Devuelve la lista resultante. */
export async function deleteCta(brandId: string, ctaId: string): Promise<CtaItem[]> {
  const m = await readManifest(brandId);
  const target = m.ctas.find((c) => c.id === ctaId);
  if (target) {
    const fp = resolve(ctaBrandDir(brandId), target.file);
    // Guardia de path traversal: solo borramos dentro del dir de la marca.
    if (fp.startsWith(ctaBrandDir(brandId)) && existsSync(fp)) {
      try {
        await unlink(fp);
      } catch {
        // archivo huérfano — no es crítico
      }
    }
  }
  m.ctas = m.ctas.filter((c) => c.id !== ctaId);
  await writeManifest(brandId, m);
  return m.ctas;
}

/** Lee un CTA para servirlo. null si no existe o si el path escapa del dir. */
export async function getCtaFile(
  brandId: string,
  ctaId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const m = await readManifest(brandId);
  const target = m.ctas.find((c) => c.id === ctaId);
  if (!target) return null;
  const fp = resolve(ctaBrandDir(brandId), target.file);
  // Guardia de path traversal.
  if (!fp.startsWith(ctaBrandDir(brandId))) return null;
  if (!existsSync(fp)) return null;
  return { buffer: await readFile(fp), contentType: target.contentType };
}
