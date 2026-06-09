import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// Raíz del monorepo. ROBUSTO sin importar desde dónde se invoque: next dev corre con
// cwd=apps/web, pero un SCRIPT (tsx) puede correr desde la raíz o desde un paquete, y
// entonces "subir 2 niveles" daba una ruta FUERA del repo (split-brain: el storage se
// escribía en C:\Users\<user>\storage). Subimos desde el cwd hasta hallar el marcador
// pnpm-workspace.yaml; fallback al comportamiento histórico (cwd=apps/web).
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), '..', '..');
}

export const REPO_ROOT = findRepoRoot();

export const BRANDS_DIR = resolve(REPO_ROOT, 'packages', 'brands');
export const PRESETS_DIR = resolve(REPO_ROOT, 'packages', 'presets');
// Presets aprendidos por el sistema (vía Ripear) quedan en pending/ hasta que
// el admin los apruebe en /admin. Una vez aprobados se mueven al PRESETS_DIR
// y aparecen como opciones en /create.
export const PENDING_PRESETS_DIR = resolve(PRESETS_DIR, 'pending');
// Respeta VF_STORAGE_DIR (lo setea next.config) para que TODO el storage —memoria
// de aprendizaje incluida— viva en un solo lugar y no se parta por process.cwd().
export const STORAGE_DIR = process.env['VF_STORAGE_DIR'] ?? resolve(REPO_ROOT, 'storage');
export const RUNS_DIR = resolve(STORAGE_DIR, 'runs');
export const RIPS_DIR = resolve(STORAGE_DIR, 'rips');
export const TRAINING_DIR = resolve(STORAGE_DIR, 'training');
// Sugerencias de mejora dejadas por el operador desde /sugerencias.
// Persistidas como JSON por archivo. NUNCA se aplican automáticamente —
// el owner las revisa cuando quiere.
export const SUGERENCIAS_DIR = resolve(STORAGE_DIR, 'sugerencias');
// Planes de escenas de los previews (Parte 3). Pequeños JSON que la generación
// reusa para que los índices de micro-escenas elegidos sean estables.
export const PREVIEWS_DIR = resolve(STORAGE_DIR, 'previews');
// Conversaciones del Copilot POR USUARIO (historial propio + base multi-usuario).
// Estructura: storage/conversations/<userId>/<conversationId>.json
export const CONVERSATIONS_DIR = resolve(STORAGE_DIR, 'conversations');
// CTAs reusables (cierres) POR MARCA: imágenes y videos solo-visual que el owner
// guarda para cargar/editar al armar un video. Estructura:
// storage/ctas/<brandId>/<file> + storage/ctas/<brandId>/manifest.json
export const CTAS_DIR = resolve(STORAGE_DIR, 'ctas');
// Laboratorio de Prompts: bucle generar→juzgar→refinar→aprobar + librería de
// prompts ganadores. storage/promptlab/winning-prompts.jsonl (memoria) y
// storage/promptlab/runs/<id>/ (trayectoria + imágenes de cada iteración).
export const PROMPTLAB_DIR = resolve(STORAGE_DIR, 'promptlab');
export function promptLabRunDir(runId: string): string {
  return resolve(PROMPTLAB_DIR, 'runs', runId);
}

export function workDirFor(runId: string): string {
  return resolve(RUNS_DIR, runId);
}

export function previewPlanPath(previewId: string): string {
  return resolve(PREVIEWS_DIR, `${previewId}.json`);
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
