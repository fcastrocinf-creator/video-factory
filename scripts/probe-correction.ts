// Probe del correction-pipeline contra el último smoke (perros-fast-ebe0be58).
// Inserta el run original en DB + crea un newRun + llama applyCorrection().
// Mide tiempos y reporta resultado.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, runs } from '../apps/web/lib/db';
import { applyCorrection } from '../apps/web/lib/correction-pipeline';
import { workDirFor } from '../apps/web/lib/paths';

const ORIGINAL_RUN_ID = 'perros-fast-ebe0be58';
const ORIGINAL_WORKDIR = resolve('storage', 'runs', ORIGINAL_RUN_ID);
const CORRECTION_MESSAGE =
  'Cambia la escena 0 por una imagen de una mujer joven en su casa, sonriendo, con una taza de café en la mano. Más cálida y luminosa.';

async function main() {
  const overallStart = Date.now();

  if (!existsSync(ORIGINAL_WORKDIR)) {
    console.error(`No existe el workDir del run original: ${ORIGINAL_WORKDIR}`);
    process.exit(1);
  }
  console.log(`[probe-corr] original workDir OK: ${ORIGINAL_WORKDIR}`);
  console.log(`[probe-corr] mensaje: "${CORRECTION_MESSAGE}"`);

  // 1. Verificar / insertar el run original en DB (smoke no lo hizo)
  const existing = await db.select().from(runs).where(eq(runs.id, ORIGINAL_RUN_ID)).limit(1);
  if (existing.length === 0) {
    console.log(`[probe-corr] insertando run original en DB...`);
    await db.insert(runs).values({
      id: ORIGINAL_RUN_ID,
      brandId: 'vitaly',
      presetId: 'mujer_protagonista_broll_animado_comic_sepia',
      scriptRaw: 'guion de perros (smoke)',
      status: 'completed',
      workDir: ORIGINAL_WORKDIR,
      outputPath: resolve(ORIGINAL_WORKDIR, 'final.mp4'),
      progress: 100,
      durationSeconds: 46.4,
    });
  } else {
    console.log(`[probe-corr] run original ya estaba en DB`);
  }

  // 2. Crear newRun pre-insert (lo que hace el endpoint API)
  const newRunId = randomUUID();
  const newWorkDir = workDirFor(newRunId);
  console.log(`[probe-corr] newRunId: ${newRunId}`);
  await db.insert(runs).values({
    id: newRunId,
    brandId: 'vitaly',
    presetId: 'mujer_protagonista_broll_animado_comic_sepia',
    scriptRaw: 'guion de perros (corrección)',
    status: 'pending',
    workDir: newWorkDir,
    progress: 0,
  });

  // 3. Llamar applyCorrection (mismo flujo que el endpoint)
  console.log(`[probe-corr] >>> applyCorrection iniciado\n`);
  await applyCorrection({
    originalRunId: ORIGINAL_RUN_ID,
    newRunId,
    correctionMessage: CORRECTION_MESSAGE,
    uploadedAssetPath: null,
    uploadedAssetIsVideo: false,
  });

  // 4. Leer estado final desde DB
  const finalState = await db.select().from(runs).where(eq(runs.id, newRunId)).limit(1);
  const final = finalState[0];

  const total = (Date.now() - overallStart) / 1000;
  console.log(`\n[probe-corr] ============================================`);
  console.log(`[probe-corr] TOTAL: ${total.toFixed(1)}s = ${(total / 60).toFixed(1)} min`);
  console.log(`[probe-corr] status: ${final?.status}`);
  console.log(`[probe-corr] currentStep: ${final?.currentStep ?? 'null (done)'}`);
  console.log(`[probe-corr] error: ${final?.errorMessage ?? 'ninguno'}`);
  console.log(`[probe-corr] outputPath: ${final?.outputPath ?? 'NO OUTPUT'}`);
  if (final?.outputPath && existsSync(final.outputPath)) {
    console.log(`[probe-corr] ✅ MP4 existe en disco`);
  } else {
    console.log(`[probe-corr] ❌ MP4 NO existe en disco`);
  }
  console.log(`[probe-corr] ============================================`);
}

main().catch((err) => {
  console.error('[probe-corr] FAILED:', err);
  process.exit(1);
});
