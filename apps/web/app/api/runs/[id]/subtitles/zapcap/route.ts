// POST /api/runs/[id]/subtitles/zapcap  -> genera el video con subtítulos (ZapCap)
// GET  /api/runs/[id]/subtitles/zapcap  -> descarga el video con subtítulos ya generado
//
// Sube el final.mp4 del run a ZapCap, le pone subtítulos animados estilo CapCut
// con el template/estilo elegido, y guarda el resultado como final-subtitled.mp4
// en el workDir. La key vive en .env (ZAPCAP_API_KEY).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@video-factory/core';
import { db, runs } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { workDirFor } from '@/lib/paths';
import { addCaptions, isZapcapConfigured, ZAPCAP_TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/zapcap';

export const runtime = 'nodejs';
export const maxDuration = 600; // el render de ZapCap puede tardar ~1-3 min

const SUBTITLED = 'final-subtitled.mp4';

function runWorkDir(row: unknown, id: string): string {
  return (row as { workDir?: string }).workDir ?? workDirFor(id);
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!isZapcapConfigured()) {
    return NextResponse.json(
      { error: 'ZapCap no está configurado (falta ZAPCAP_API_KEY en el .env).' },
      { status: 503 },
    );
  }
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });

  const workDir = runWorkDir(row, row.id);
  const finalPath = resolve(workDir, 'final.mp4');
  if (!existsSync(finalPath)) {
    return NextResponse.json({ error: 'El video final aún no existe' }, { status: 409 });
  }

  let body: { templateId?: string; fontUppercase?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* sin body, usamos defaults */
  }
  const templateId =
    body.templateId && ZAPCAP_TEMPLATES.some((t) => t.id === body.templateId)
      ? body.templateId
      : DEFAULT_TEMPLATE_ID;
  const fontUppercase = Boolean(body.fontUppercase);

  const logger = createLogger(params.id);
  try {
    const outPath = resolve(workDir, SUBTITLED);
    await addCaptions({ videoPath: finalPath, outPath, templateId, fontUppercase, logger });
    return NextResponse.json({
      ok: true,
      templateId,
      fontUppercase,
      message: 'Subtítulos generados. Descarga el video con subtítulos abajo.',
    });
  } catch (e) {
    logger.error({ runId: params.id, err: (e as Error).message }, 'zapcap:endpoint_failed');
    return NextResponse.json(
      { error: `ZapCap falló: ${(e as Error).message.slice(0, 300)}` },
      { status: 502 },
    );
  }
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthenticated()) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const row = (await db.select().from(runs).where(eq(runs.id, params.id)).limit(1))[0];
  if (!row) return NextResponse.json({ error: 'Run no encontrado' }, { status: 404 });
  const p = resolve(runWorkDir(row, row.id), SUBTITLED);
  if (!existsSync(p)) {
    return NextResponse.json({ error: 'Aún no hay video con subtítulos' }, { status: 404 });
  }
  const buf = await readFile(p);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="video-subtitulado-${row.id.slice(0, 8)}.mp4"`,
    },
  });
}
