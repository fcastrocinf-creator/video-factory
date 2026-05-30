// POST /api/sugerencias — persiste una sugerencia de mejora del operador.
//
// Las sugerencias se guardan como archivos JSON individuales en
// storage/sugerencias/{timestamp}-{shortId}.json. NUNCA se aplican
// automáticamente al código — el owner las revisa cuando quiere.
//
// La carpeta storage/ está en .gitignore, así que las sugerencias son
// local-only por defecto. Si en algún momento se quieren compartir entre
// máquinas, hay que decidirlo explícitamente (mover a otro path versionado).

import { NextResponse, type NextRequest } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SUGERENCIAS_DIR } from '../../../lib/paths';
import { logSystemEvent } from '@/lib/system-log';

const SugerenciaCreateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  category: z
    .enum(['bug', 'feature', 'improvement', 'question', 'other'])
    .optional()
    .default('improvement'),
  contextPath: z.string().max(500).optional(),
  author: z.string().max(100).optional(),
});

type SugerenciaCreate = z.infer<typeof SugerenciaCreateSchema>;

interface SugerenciaRecord extends SugerenciaCreate {
  id: string;
  createdAt: string;
  status: 'new';
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = SugerenciaCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validación falló',
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  // Asegurar que la carpeta existe (mkdir recursive es no-op si ya está).
  await mkdir(SUGERENCIAS_DIR, { recursive: true });

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const record: SugerenciaRecord = {
    id,
    createdAt,
    status: 'new',
    ...parsed.data,
  };

  // Nombre del archivo: {ISO timestamp safe-for-filesystem}-{primeros 8 chars del UUID}.json
  // Orden cronológico natural + único.
  const safeTimestamp = createdAt.replace(/[:.]/g, '-');
  const fileName = `${safeTimestamp}-${id.slice(0, 8)}.json`;
  const filePath = resolve(SUGERENCIAS_DIR, fileName);

  try {
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `No se pudo guardar la sugerencia: ${msg}` },
      { status: 500 },
    );
  }

  // M9: auto-log al system event log
  void logSystemEvent({
    kind: 'suggestion-posted',
    data: {
      id,
      category: parsed.data.category,
      titleLength: parsed.data.title.length,
      descriptionLength: parsed.data.description.length,
      author: parsed.data.author,
    },
    summary: `Sugerencia posteada (${parsed.data.category}): "${parsed.data.title.slice(0, 80)}"`,
  });

  return NextResponse.json(
    {
      ok: true,
      id,
      fileName,
      savedAt: filePath,
    },
    { status: 201 },
  );
}
