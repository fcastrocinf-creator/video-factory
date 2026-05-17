import { resolve } from 'node:path';

// El cwd cuando Next.js corre es la carpeta de apps/web (next dev lo invoca desde ahí
// vía turbo). Subimos dos niveles hasta la raíz del monorepo para llegar a packages/,
// storage/, db/, etc.
export const REPO_ROOT = resolve(process.cwd(), '..', '..');

export const BRANDS_DIR = resolve(REPO_ROOT, 'packages', 'brands');
export const PRESETS_DIR = resolve(REPO_ROOT, 'packages', 'presets');
export const STORAGE_DIR = resolve(REPO_ROOT, 'storage');
export const RUNS_DIR = resolve(STORAGE_DIR, 'runs');

export function workDirFor(runId: string): string {
  return resolve(RUNS_DIR, runId);
}

export function outputPathFor(runId: string): string {
  return resolve(workDirFor(runId), 'final.mp4');
}
