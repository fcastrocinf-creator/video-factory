// Watcher en vivo de un run en storage/runs/. Muestra progreso de escenas + audio + final.mp4.
// Uso: pnpm exec tsx scripts/watch-run.ts [runId]
//      (si no pasás runId, agarra el más reciente)

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..');
const RUNS_DIR = resolve(REPO_ROOT, 'storage', 'runs');

async function findLatestRun(): Promise<string> {
  const entries = await readdir(RUNS_DIR);
  const runs = await Promise.all(
    entries.map(async (name) => {
      const path = join(RUNS_DIR, name);
      const s = await stat(path).catch(() => null);
      return s?.isDirectory() ? { name, mtime: s.mtimeMs } : null;
    }),
  );
  const valid = runs.filter((r): r is { name: string; mtime: number } => r !== null);
  valid.sort((a, b) => b.mtime - a.mtime);
  if (!valid[0]) throw new Error('No runs found in storage/runs');
  return valid[0].name;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function elapsed(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

async function snapshot(runDir: string): Promise<{
  scenes: { idx: number; size: number; mtime: number }[];
  audioBytes: number | null;
  finalBytes: number | null;
  totalPlanned: number | null;
}> {
  const files = await readdir(runDir).catch(() => []);
  const scenes: { idx: number; size: number; mtime: number }[] = [];
  let audioBytes: number | null = null;
  let finalBytes: number | null = null;

  for (const f of files) {
    const m = /^scene_(\d+)\.png$/.exec(f);
    if (m) {
      const s = await stat(join(runDir, f));
      scenes.push({ idx: parseInt(m[1]!, 10), size: s.size, mtime: s.mtimeMs });
    } else if (f === 'audio.mp3') {
      const s = await stat(join(runDir, f));
      audioBytes = s.size;
    } else if (f === 'final.mp4') {
      const s = await stat(join(runDir, f));
      finalBytes = s.size;
    }
  }
  scenes.sort((a, b) => a.idx - b.idx);

  // scene-plan.json tiene el total esperado
  let totalPlanned: number | null = null;
  const planPath = join(runDir, 'scene-plan.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(planPath, 'utf-8')));
      totalPlanned = Array.isArray(plan?.scenes) ? plan.scenes.length : null;
    } catch {
      /* ignore */
    }
  }
  return { scenes, audioBytes, finalBytes, totalPlanned };
}

function bar(done: number, total: number, width = 24): string {
  if (total <= 0) return '─'.repeat(width);
  const filled = Math.min(width, Math.round((done / total) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main() {
  const argRunId = process.argv[2];
  const runId = argRunId ?? (await findLatestRun());
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    console.error(`Run no existe: ${runDir}`);
    process.exit(1);
  }
  const startMs = Date.now();
  let lastSceneCount = -1;
  let lastFinalBytes: number | null = null;

  console.log(`\n[watch] Mirando run ${runId}`);
  console.log(`[watch] ${runDir}\n`);

  // Loop: refresca cada 2s, imprime una línea solo cuando hay cambios.
  // Sale cuando final.mp4 existe y deja de crecer (stable durante 2 ticks).
  let stableFinalTicks = 0;
  while (true) {
    const snap = await snapshot(runDir);
    const total = snap.totalPlanned ?? 0;
    const done = snap.scenes.length;

    const changed = done !== lastSceneCount || snap.finalBytes !== lastFinalBytes;
    if (changed) {
      const audio = snap.audioBytes ? `audio:${fmtMB(snap.audioBytes)}` : 'audio:—';
      const finalStr = snap.finalBytes ? `final.mp4:${fmtMB(snap.finalBytes)}` : 'final.mp4:—';
      const lastScene =
        done > lastSceneCount && snap.scenes[done - 1]
          ? `[+scene_${String(snap.scenes[done - 1]!.idx).padStart(2, '0')}.png ${fmtMB(snap.scenes[done - 1]!.size)}]`
          : '';
      console.log(
        `[${elapsed(startMs)}] ${bar(done, total || 29)} ${done}/${total || '?'} ${audio} ${finalStr} ${lastScene}`,
      );
      lastSceneCount = done;
      lastFinalBytes = snap.finalBytes;
    }

    if (snap.finalBytes && snap.finalBytes === lastFinalBytes) {
      stableFinalTicks++;
      if (stableFinalTicks >= 2) {
        console.log(`\n[watch] final.mp4 estable @ ${fmtMB(snap.finalBytes)} — done.`);
        process.exit(0);
      }
    } else {
      stableFinalTicks = 0;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error('[watch] FAILED:', err);
  process.exit(1);
});
