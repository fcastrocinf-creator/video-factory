// Repositorio de runs: queries para listado, soft-delete con papelera de 30 días,
// restore, purge permanente, y reasignación a otro producto.
//
// La papelera vive en la columna runs.deleted_at (timestamp). NULL = visible,
// not-NULL = en papelera (mostrarse en /runs/trash). El auto-purge corre
// best-effort cuando se lista la papelera: cualquier run con deletedAt más viejo
// que 30 días se elimina físicamente (DB + workDir).

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { db, runs } from './db';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_RETENTION_DAYS = 30;

export interface RunSummary {
  id: string;
  brandId: string;
  productId: string | null;
  presetId: string;
  status: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
  durationSeconds: number | null;
  outputPath: string | null;
  workDir: string | null;
  estimatedCostUsd: number;
  imageCount: number;
  ttsCharsBilled: number;
  createdAt: Date;
  completedAt: Date | null;
  deletedAt: Date | null;
  originalRunId: string | null;
  errorMessage: string | null;
}

function row(r: typeof runs.$inferSelect): RunSummary {
  return {
    id: r.id,
    brandId: r.brandId,
    productId: r.productId,
    presetId: r.presetId,
    status: r.status,
    durationSeconds: r.durationSeconds,
    outputPath: r.outputPath,
    workDir: r.workDir,
    estimatedCostUsd: r.estimatedCostUsd,
    imageCount: r.imageCount,
    ttsCharsBilled: r.ttsCharsBilled,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date((r.createdAt as unknown as number) * 1000),
    completedAt:
      r.completedAt instanceof Date
        ? r.completedAt
        : r.completedAt
          ? new Date((r.completedAt as unknown as number) * 1000)
          : null,
    deletedAt:
      r.deletedAt instanceof Date
        ? r.deletedAt
        : r.deletedAt
          ? new Date((r.deletedAt as unknown as number) * 1000)
          : null,
    originalRunId: r.originalRunId ?? null,
    errorMessage: r.errorMessage,
  };
}

export async function listActiveRuns(opts?: {
  brandId?: string;
  productId?: string | null;
  status?: 'pending' | 'running' | 'completed' | 'completed-with-warnings' | 'failed';
}): Promise<RunSummary[]> {
  const conditions = [isNull(runs.deletedAt)];
  if (opts?.brandId) conditions.push(eq(runs.brandId, opts.brandId));
  if (opts?.productId !== undefined) {
    if (opts.productId === null) {
      conditions.push(isNull(runs.productId));
    } else {
      conditions.push(eq(runs.productId, opts.productId));
    }
  }
  if (opts?.status) conditions.push(eq(runs.status, opts.status));
  const rows = await db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt));
  return rows.map(row);
}

export async function listTrashedRuns(): Promise<RunSummary[]> {
  // Purgar primero los > 30 días, después devolver lo que queda
  await purgeExpiredTrash();
  const rows = await db
    .select()
    .from(runs)
    .where(isNotNull(runs.deletedAt))
    .orderBy(desc(runs.deletedAt));
  return rows.map(row);
}

export async function moveToTrash(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ deletedAt: new Date() })
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)));
}

export async function restoreFromTrash(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ deletedAt: null })
    .where(and(eq(runs.id, runId), isNotNull(runs.deletedAt)));
}

export async function purgeRunPermanently(runId: string): Promise<void> {
  const result = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const run = result[0];
  if (!run) return;
  if (run.workDir && existsSync(run.workDir)) {
    try {
      await rm(run.workDir, { recursive: true, force: true });
    } catch {
      // archivo bloqueado / no existe — seguimos con el delete de DB
    }
  }
  await db.delete(runs).where(eq(runs.id, runId));
}

export async function purgeExpiredTrash(): Promise<number> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * DAY_MS);
  const expired = await db
    .select()
    .from(runs)
    .where(and(isNotNull(runs.deletedAt), lt(runs.deletedAt, cutoff)));
  let count = 0;
  for (const r of expired) {
    await purgeRunPermanently(r.id);
    count++;
  }
  return count;
}

export async function reassignRunProduct(
  runId: string,
  newProductId: string | null,
): Promise<void> {
  await db
    .update(runs)
    .set({ productId: newProductId })
    .where(eq(runs.id, runId));
}
