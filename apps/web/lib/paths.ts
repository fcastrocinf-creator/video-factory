import { resolve } from 'node:path';

// El cwd cuando Next.js corre es la carpeta de apps/web (next dev lo invoca desde ahí
// vía turbo). Subimos dos niveles hasta la raíz del monorepo para llegar a packages/,
// storage/, db/, etc.
export const REPO_ROOT = resolve(process.cwd(), '..', '..');

export const BRANDS_DIR = resolve(REPO_ROOT, 'packages', 'brands');
export const PRESETS_DIR = resolve(REPO_ROOT, 'packages', 'presets');
// Presets aprendidos por el sistema (vía Ripear) quedan en pending/ hasta que
// el admin los apruebe en /admin. Una vez aprobados se mueven al PRESETS_DIR
// y aparecen como opciones en /create.
export const PENDING_PRESETS_DIR = resolve(PRESETS_DIR, 'pending');
export const STORAGE_DIR = resolve(REPO_ROOT, 'storage');
export const RUNS_DIR = resolve(STORAGE_DIR, 'runs');
export const RIPS_DIR = resolve(STORAGE_DIR, 'rips');
export const TRAINING_DIR = resolve(STORAGE_DIR, 'training');

export function workDirFor(runId: string): string {
  return resolve(RUNS_DIR, runId);
}

export function outputPathFor(runId: string): string {
  return resolve(workDirFor(runId), 'final.mp4');
}

export function ripWorkDirFor(ripId: string): string {
  return resolve(RIPS_DIR, ripId);
}

export function trainingWorkDirFor(trainingId: string): string {
  return resolve(TRAINING_DIR, trainingId);
}
