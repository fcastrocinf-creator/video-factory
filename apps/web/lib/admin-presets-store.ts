// Admin presets store: gestión de los presets aprendidos pendientes de aprobación.
//
// Flow:
//   1. Usuario sube video en /rip → análisis → builder construye preset
//   2. Preset queda en packages/presets/pending/learned-*.preset.json
//   3. Admin entra a /admin, ve la lista, puede:
//      - Aprobar → mueve preset.json + preview.gif a packages/presets/
//      - Rechazar → borra ambos files
//      - Editar campos (displayName, description, visualStyle, etc.)
//
// Restricciones de seguridad:
//   - SOLO presets con prefix "learned-" se pueden borrar/aprobar vía admin
//   - El presetId NO puede contener path traversal (validamos con regex)

import { readdir, readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PresetConfigSchema,
  type PresetConfig,
} from '@video-factory/contracts';
import { PRESETS_DIR, PENDING_PRESETS_DIR } from './paths';

// Sólo permitimos ids que matchean este patrón (alfanumérico + guiones).
// Bloquea cualquier intento de path traversal (../) o caracteres raros.
const SAFE_ID_REGEX = /^learned-[a-z0-9-]+$/;

function assertSafePresetId(id: string): void {
  if (!SAFE_ID_REGEX.test(id)) {
    throw new Error(
      `presetId "${id}" inválido: debe matchear ${SAFE_ID_REGEX.source}`,
    );
  }
}

export interface PendingPresetSummary {
  id: string;
  displayName: string;
  description: string;
  categoryDisplayName: string | null;
  formatDisplayName: string | null;
  estrategia: PresetConfig['estrategia'];
  visualEngine: PresetConfig['visualEngine'];
  defaultDurationSeconds: number;
  scenesPerMinute: number;
  hasPreview: boolean;
  createdAt: string;
}

/**
 * Lee todos los presets en pending/ y retorna un summary listo para la UI.
 */
export async function listPendingPresets(): Promise<PendingPresetSummary[]> {
  if (!existsSync(PENDING_PRESETS_DIR)) return [];
  const files = await readdir(PENDING_PRESETS_DIR);
  const presetFiles = files.filter(
    (f) => f.endsWith('.preset.json') && f.startsWith('learned-'),
  );

  const summaries = await Promise.all(
    presetFiles.map(async (file) => {
      const id = file.replace('.preset.json', '');
      try {
        const content = await readFile(join(PENDING_PRESETS_DIR, file), 'utf-8');
        const preset = PresetConfigSchema.parse(JSON.parse(content));
        const previewPath = join(PENDING_PRESETS_DIR, `${id}.preview.gif`);
        return {
          id: preset.id,
          displayName: preset.displayName,
          description: preset.description,
          categoryDisplayName: preset.category?.displayName ?? null,
          formatDisplayName: preset.format?.displayName ?? null,
          estrategia: preset.estrategia,
          visualEngine: preset.visualEngine,
          defaultDurationSeconds: preset.defaultDurationSeconds,
          scenesPerMinute: preset.scenesPerMinute,
          hasPreview: existsSync(previewPath),
          createdAt: preset.createdAt,
        } satisfies PendingPresetSummary;
      } catch {
        // Si un preset está corrupto, lo skipeamos en vez de tirar toda la lista
        return null;
      }
    }),
  );

  return summaries
    .filter((s): s is PendingPresetSummary => s !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Lee el JSON completo de un preset pendiente. Para que el admin pueda editarlo.
 */
export async function readPendingPreset(id: string): Promise<PresetConfig> {
  assertSafePresetId(id);
  const path = join(PENDING_PRESETS_DIR, `${id}.preset.json`);
  if (!existsSync(path)) {
    throw new Error(`Preset pendiente no encontrado: ${id}`);
  }
  const content = await readFile(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(`Preset "${id}" tiene JSON corrupto: ${(e as Error).message}`);
  }
  return PresetConfigSchema.parse(raw);
}

/**
 * Aprueba un preset pendiente moviéndolo (junto con su preview.gif si existe)
 * desde pending/ → PRESETS_DIR. A partir de acá aparece en /create.
 *
 * Si ya existe un preset con el mismo id en PRESETS_DIR, falla con error claro.
 */
export async function approvePendingPreset(id: string): Promise<PresetConfig> {
  assertSafePresetId(id);
  const srcJsonPath = join(PENDING_PRESETS_DIR, `${id}.preset.json`);
  const dstJsonPath = join(PRESETS_DIR, `${id}.preset.json`);
  if (!existsSync(srcJsonPath)) {
    throw new Error(`Preset pendiente no encontrado: ${id}`);
  }
  if (existsSync(dstJsonPath)) {
    throw new Error(`Ya existe un preset aprobado con id "${id}" — borralo primero`);
  }

  // Validamos y actualizamos updatedAt antes de mover, así queda registro de
  // "aprobado en X fecha". Si el JSON está corrupto (escritura parcial previa),
  // damos mensaje claro al admin en vez del SyntaxError críptico.
  const content = await readFile(srcJsonPath, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `Preset "${id}" tiene JSON corrupto en disco: ${(e as Error).message}. Rechazalo desde /admin para eliminarlo.`,
    );
  }
  const preset = PresetConfigSchema.parse(raw);
  const approved: PresetConfig = { ...preset, updatedAt: new Date().toISOString() };

  await mkdir(PRESETS_DIR, { recursive: true });
  await writeFile(dstJsonPath, JSON.stringify(approved, null, 2), 'utf-8');
  await unlink(srcJsonPath);

  // Mover preview.gif si existe (best-effort, no falla si no se puede)
  const srcGifPath = join(PENDING_PRESETS_DIR, `${id}.preview.gif`);
  const dstGifPath = join(PRESETS_DIR, `${id}.preview.gif`);
  if (existsSync(srcGifPath)) {
    try {
      await rename(srcGifPath, dstGifPath);
    } catch {
      // Si rename falla (cross-device en algunos FS), intentamos copy + unlink
      try {
        const gif = await readFile(srcGifPath);
        await writeFile(dstGifPath, gif);
        await unlink(srcGifPath);
      } catch {
        // ignored — el gif quedará en pending pero el preset aprobado igual sirve
      }
    }
  }

  return approved;
}

/**
 * Rechaza un preset pendiente borrando preset.json + preview.gif.
 */
export async function rejectPendingPreset(id: string): Promise<void> {
  assertSafePresetId(id);
  const jsonPath = join(PENDING_PRESETS_DIR, `${id}.preset.json`);
  const gifPath = join(PENDING_PRESETS_DIR, `${id}.preview.gif`);
  if (existsSync(jsonPath)) {
    await unlink(jsonPath);
  }
  if (existsSync(gifPath)) {
    try {
      await unlink(gifPath);
    } catch {
      // ignored
    }
  }
}

// Campos que el admin puede editar antes de aprobar. Mantenemos restrictivo
// para no romper el schema validando con Zod en el endpoint.
export interface PendingPresetEdits {
  displayName?: string;
  description?: string;
  defaultDurationSeconds?: number;
  scenesPerMinute?: number;
  visualEngine?: PresetConfig['visualEngine'];
  estrategia?: PresetConfig['estrategia'];
  category?: {
    id: string;
    displayName: string;
    description?: string;
  };
  format?: {
    id: PresetConfig['format'] extends { id: infer T } | undefined ? T : never;
    displayName: string;
    description?: string;
  };
  visualStyle?: {
    promptTemplate?: string;
    negativePrompt?: string;
  };
}

/**
 * Aplica edits a un preset pendiente in-place (no lo aprueba). El admin puede
 * iterar antes de aprobar.
 */
export async function editPendingPreset(
  id: string,
  edits: PendingPresetEdits,
): Promise<PresetConfig> {
  assertSafePresetId(id);
  const current = await readPendingPreset(id);
  const updated: PresetConfig = {
    ...current,
    ...(edits.displayName ? { displayName: edits.displayName } : {}),
    ...(edits.description ? { description: edits.description } : {}),
    ...(edits.defaultDurationSeconds
      ? { defaultDurationSeconds: edits.defaultDurationSeconds }
      : {}),
    ...(edits.scenesPerMinute ? { scenesPerMinute: edits.scenesPerMinute } : {}),
    ...(edits.visualEngine ? { visualEngine: edits.visualEngine } : {}),
    ...(edits.estrategia ? { estrategia: edits.estrategia } : {}),
    ...(edits.category
      ? {
          category: {
            id: edits.category.id,
            displayName: edits.category.displayName,
            description: edits.category.description ?? current.category?.description ?? '',
          },
        }
      : {}),
    ...(edits.format
      ? {
          format: {
            id: edits.format.id,
            displayName: edits.format.displayName,
            description: edits.format.description ?? current.format?.description ?? '',
          },
        }
      : {}),
    ...(edits.visualStyle
      ? {
          visualStyle: {
            ...current.visualStyle,
            ...(edits.visualStyle.promptTemplate
              ? { promptTemplate: edits.visualStyle.promptTemplate }
              : {}),
            ...(edits.visualStyle.negativePrompt
              ? { negativePrompt: edits.visualStyle.negativePrompt }
              : {}),
          },
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  const validated = PresetConfigSchema.parse(updated);
  const path = join(PENDING_PRESETS_DIR, `${id}.preset.json`);
  await writeFile(path, JSON.stringify(validated, null, 2), 'utf-8');
  return validated;
}
