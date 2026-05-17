import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BrandConfigSchema,
  PresetConfigSchema,
  type BrandConfig,
  type PresetConfig,
} from '@video-factory/contracts';
import { BRANDS_DIR, PRESETS_DIR } from './paths';

export async function loadBrand(id: string): Promise<BrandConfig> {
  const path = join(BRANDS_DIR, `${id}.brand.json`);
  const content = await readFile(path, 'utf-8');
  return BrandConfigSchema.parse(JSON.parse(content));
}

export async function loadPreset(id: string): Promise<PresetConfig> {
  const path = join(PRESETS_DIR, `${id}.preset.json`);
  const content = await readFile(path, 'utf-8');
  return PresetConfigSchema.parse(JSON.parse(content));
}

export async function loadAllBrands(): Promise<BrandConfig[]> {
  const files = await readdir(BRANDS_DIR);
  const brandFiles = files.filter((f) => f.endsWith('.brand.json'));
  return Promise.all(brandFiles.map((f) => loadBrand(f.replace('.brand.json', ''))));
}

export async function loadAllPresets(): Promise<PresetConfig[]> {
  const files = await readdir(PRESETS_DIR);
  const presetFiles = files.filter((f) => f.endsWith('.preset.json'));
  return Promise.all(presetFiles.map((f) => loadPreset(f.replace('.preset.json', ''))));
}
