// GET /api/runs/[id]/subtitles
//
// Genera un archivo .srt con el TEXTO EXACTO del guion + los tiempos de cada
// escena. Pensado para importarlo en CapCut / ZapCap / cualquier editor y
// aplicarle el estilo SIN errores de transcripción (le damos el texto real,
// no se adivina del audio). El idioma del subtítulo es el del guion (matchea la voz).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { workDirFor } from '@/lib/paths';

export const runtime = 'nodejs';

/** Segundos → timestamp SRT "HH:MM:SS,mmm". */
function toSrtTime(sec: number): string {
  const s = Math.max(0, sec);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(secs)},${pad(ms, 3)}`;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) {
    return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  }
  const workDir = (row as { workDir?: string }).workDir ?? workDirFor(row.id);
  const planPath = resolve(workDir, 'scene-plan.json');
  if (!existsSync(planPath)) {
    return NextResponse.json(
      { error: 'Este run no tiene scene-plan.json (no se puede generar subtítulos).' },
      { status: 404 },
    );
  }

  const plan = JSON.parse(await readFile(planPath, 'utf-8')) as {
    scenes: Array<{
      index: number;
      text?: string;
      startTimeSeconds?: number;
      endTimeSeconds?: number;
    }>;
  };

  const scenes = [...(plan.scenes ?? [])].sort((a, b) => a.index - b.index);
  const cues: string[] = [];
  let n = 0;
  for (const s of scenes) {
    const text = (s.text ?? '').trim();
    if (!text || s.startTimeSeconds == null || s.endTimeSeconds == null) continue;
    // El end nunca debe ser <= start (algún editor rechaza cues de duración 0).
    const end = s.endTimeSeconds > s.startTimeSeconds ? s.endTimeSeconds : s.startTimeSeconds + 0.5;
    n++;
    cues.push(`${n}\n${toSrtTime(s.startTimeSeconds)} --> ${toSrtTime(end)}\n${text}\n`);
  }

  if (n === 0) {
    return NextResponse.json(
      { error: 'No hay frases con tiempos para generar subtítulos.' },
      { status: 422 },
    );
  }

  const srt = cues.join('\n');
  return new NextResponse(srt, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="subtitulos-${row.id.slice(0, 8)}.srt"`,
    },
  });
}
