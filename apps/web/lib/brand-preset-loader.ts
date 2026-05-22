import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type BrandConfig,
  type PresetConfig,
} from '@video-factory/contracts';
import { BRANDS_DIR, PRESETS_DIR, PENDING_PRESETS_DIR } from './paths';

export async function loadBrand(id: string): Promise<BrandConfig> {
  const path = join(BRANDS_DIR, `${id}.brand.json`);
  const content = await readFile(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`brand.json corrupto para "${id}": ${(e as Error).message}`);
  }
  return BrandConfigSchema.parse(raw);
}

/**
 * Carga un preset por id. Busca primero en PRESETS_DIR (aprobados) y luego en
 * PENDING_PRESETS_DIR (aprendidos pendientes de aprobación). Esto permite que
 * el pipeline use un preset aprendido inmediatamente después de ripear, antes
 * de que el admin lo apruebe en /admin.
 */
export async function loadPreset(id: string): Promise<PresetConfig> {
  const approvedPath = join(PRESETS_DIR, `${id}.preset.json`);
  const pendingPath = join(PENDING_PRESETS_DIR, `${id}.preset.json`);
  const path = existsSync(approvedPath)
    ? approvedPath
    : existsSync(pendingPath)
      ? pendingPath
      : approvedPath; // dejará caer el ENOENT con el path "approved" en el mensaje
  const content = await readFile(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`preset.json corrupto para "${id}": ${(e as Error).message}`);
  }
  return PresetConfigSchema.parse(raw);
}

export async function loadAllBrands(): Promise<BrandConfig[]> {
  const files = await readdir(BRANDS_DIR);
  const brandFiles = files.filter((f) => f.endsWith('.brand.json'));
  return Promise.all(brandFiles.map((f) => loadBrand(f.replace('.brand.json', ''))));
}

/**
 * Lista los presets aprobados (solo PRESETS_DIR, NO pending). Los pendientes
 * se listan vía loadAllPendingPresets() en lib/admin-presets-store.ts.
 */
export async function loadAllPresets(): Promise<PresetConfig[]> {
  const files = await readdir(PRESETS_DIR);
  const presetFiles = files.filter((f) => f.endsWith('.preset.json'));
  return Promise.all(presetFiles.map((f) => loadPreset(f.replace('.preset.json', ''))));
}
