// Selecciona un run COMPLETADO reusable para probar el "brazo" (auto-reparar):
// debe estar en la DB como completed, con final.mp4 + scene-plan.json + audio.mp3 +
// las imágenes scene_XX.png (applyCorrection las necesita). Ordena por pocas escenas
// (re-render más barato) y prioriza runs con TODAS las imágenes presentes.
//
// Uso: pnpm tsx scripts/pick-run-for-repair.ts

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Cargar .env raíz (DATABASE_URL si lo hubiera).
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]!]) process.env[m[1]!] = v;
    }
  }
} catch {}

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { inArray } from 'drizzle-orm';
import { runs } from '../db/schema';

async function main(): Promise<void> {
  const dbFile = process.env['DATABASE_URL'] ?? `file:${resolve(process.cwd(), 'db', 'local.db')}`;
  const db = drizzle(createClient({ url: dbFile }));
  const rows = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ['completed', 'completed-with-warnings']));

  type Cand = {
    id: string;
    status: string;
    brandId: string;
    presetId: string;
    isCorrection: boolean;
    nScenes: number;
    withImg: number;
  };
  const cands: Cand[] = [];
  for (const r of rows) {
    if (!r.workDir) continue;
    const wd = r.workDir;
    if (
      !existsSync(resolve(wd, 'final.mp4')) ||
      !existsSync(resolve(wd, 'scene-plan.json')) ||
      !existsSync(resolve(wd, 'audio.mp3'))
    )
      continue;
    let nScenes = 0;
    let withImg = 0;
    try {
      const track = JSON.parse(readFileSync(resolve(wd, 'scene-plan.json'), 'utf8')) as {
        scenes?: { index: number }[];
      };
      nScenes = track.scenes?.length ?? 0;
      for (const s of track.scenes ?? []) {
        if (existsSync(resolve(wd, `scene_${String(s.index).padStart(2, '0')}.png`))) withImg++;
      }
    } catch {
      /* plan ilegible → se omite el conteo */
    }
    cands.push({
      id: r.id,
      status: r.status,
      brandId: r.brandId,
      presetId: r.presetId,
      isCorrection: !!r.originalRunId,
      nScenes,
      withImg,
    });
  }

  // Prioriza: todas las imágenes presentes → no-corrección → menos escenas.
  cands.sort(
    (a, b) =>
      Number(a.withImg !== a.nScenes) - Number(b.withImg !== b.nScenes) ||
      Number(a.isCorrection) - Number(b.isCorrection) ||
      a.nScenes - b.nScenes,
  );

  console.log(
    `Candidatos (completados, con final.mp4 + scene-plan.json + audio.mp3): ${cands.length}\n`,
  );
  for (const c of cands.slice(0, 15)) {
    console.log(
      `  ${c.id}  escenas=${c.nScenes} conImg=${c.withImg} brand=${c.brandId} preset=${c.presetId}${
        c.isCorrection ? ' (corrección)' : ''
      }`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
