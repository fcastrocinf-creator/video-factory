// Probe del correction-pipeline vía API HTTP local (usa el dev server corriendo).
// Auth con cookie app_auth. Inserta el run original en DB primero si no existe.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';

const ORIGINAL_RUN_ID = 'perros-fast-ebe0be58';
const ORIGINAL_WORKDIR = resolve('storage', 'runs', ORIGINAL_RUN_ID);
const CORRECTION_MESSAGE =
  'Cambia la escena 0 por una imagen de una mujer joven en su casa, sonriendo, con una taza de café en la mano. Más cálida y luminosa.';
const APP_URL = 'http://localhost:3000';
const APP_PASSWORD = process.env['APP_PASSWORD'] ?? '';

async function main() {
  const overallStart = Date.now();

  if (!existsSync(ORIGINAL_WORKDIR)) {
    console.error(`No existe ${ORIGINAL_WORKDIR}`);
    process.exit(1);
  }
  console.log(`[probe-api] workDir OK: ${ORIGINAL_WORKDIR}`);

  // 1. Insertar run original en DB si no existe
  const dbPath = resolve('db/local.db');
  const sqlite = createClient({ url: `file:${dbPath}` });
  const existing = await sqlite.execute({
    sql: 'SELECT id FROM runs WHERE id = ?',
    args: [ORIGINAL_RUN_ID],
  });
  if (existing.rows.length === 0) {
    console.log(`[probe-api] insertando run original en DB...`);
    await sqlite.execute({
      sql: `INSERT INTO runs (id, brand_id, preset_id, script_raw, status, work_dir, output_path, progress, duration_seconds, created_at, completed_at)
            VALUES (?, ?, ?, ?, 'completed', ?, ?, 100, 46.4, unixepoch(), unixepoch())`,
      args: [
        ORIGINAL_RUN_ID,
        'vitaly',
        'mujer_protagonista_broll_animado_comic_sepia',
        'guion perros',
        ORIGINAL_WORKDIR,
        resolve(ORIGINAL_WORKDIR, 'final.mp4'),
      ],
    });
  } else {
    console.log(`[probe-api] run original ya en DB`);
  }

  // 2. Auth
  console.log(`[probe-api] autenticando...`);
  const authResp = await fetch(`${APP_URL}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: APP_PASSWORD }),
  });
  if (!authResp.ok) throw new Error(`Auth falló: ${authResp.status}`);
  const setCookie = authResp.headers.get('set-cookie') ?? '';
  console.log(`[probe-api] auth cookie set`);

  // 3. POST correction
  console.log(`[probe-api] enviando corrección...`);
  const formData = new FormData();
  formData.append('message', CORRECTION_MESSAGE);

  const corrResp = await fetch(`${APP_URL}/api/runs/${ORIGINAL_RUN_ID}/corrections`, {
    method: 'POST',
    headers: { cookie: setCookie },
    body: formData,
  });
  if (!corrResp.ok) {
    const errBody = await corrResp.text();
    throw new Error(`Corrección rechazada: ${corrResp.status} ${errBody.slice(0, 500)}`);
  }
  const corrData = await corrResp.json();
  const newRunId = corrData.newRunId;
  console.log(`[probe-api] corrección encolada. newRunId=${newRunId}`);
  console.log(`[probe-api] esperando completion via polling...\n`);

  // 4. Poll hasta completion
  const maxWaitMs = 25 * 60 * 1000; // 25 min max
  const startPoll = Date.now();
  let lastStep = '';
  while (Date.now() - startPoll < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusResp = await fetch(`${APP_URL}/api/runs/${newRunId}`, {
      headers: { cookie: setCookie },
    });
    if (!statusResp.ok) {
      console.warn(`[probe-api] poll error ${statusResp.status}`);
      continue;
    }
    const status = await statusResp.json();
    if (status.currentStep && status.currentStep !== lastStep) {
      const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
      console.log(`[probe-api] [${elapsed}s · ${status.progress}%] ${status.currentStep}`);
      lastStep = status.currentStep;
    }
    if (status.status === 'completed') {
      const total = (Date.now() - overallStart) / 1000;
      console.log(`\n[probe-api] ============================================`);
      console.log(`[probe-api] ✅ COMPLETED en ${total.toFixed(1)}s = ${(total / 60).toFixed(1)} min`);
      console.log(`[probe-api] outputPath: ${status.outputPath}`);
      if (status.outputPath && existsSync(status.outputPath)) {
        const r = spawnSync('cmd.exe', ['/c', 'start', '', status.outputPath]);
        void r;
        console.log(`[probe-api] ✅ MP4 existe y se abre`);
      } else {
        console.log(`[probe-api] ⚠️  MP4 NO existe en disco`);
      }
      console.log(`[probe-api] ============================================`);
      sqlite.close();
      return;
    }
    if (status.status === 'failed') {
      console.error(`\n[probe-api] ❌ FAILED: ${status.errorMessage}`);
      sqlite.close();
      process.exit(1);
    }
  }
  console.error(`\n[probe-api] ⏱️  Timeout (>${maxWaitMs / 60000} min)`);
  sqlite.close();
  process.exit(1);
}

main().catch((err) => {
  console.error('[probe-api] FAILED:', err);
  process.exit(1);
});
