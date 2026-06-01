// POST /api/plan-preview — Parte 3: previsualiza las escenas que la herramienta
// propondría para un guion, SIN generar imágenes/voz/animación. Corre solo
// script-processor + scene-planner (barato). Sirve para que el usuario vea las
// escenas y elija cuáles convertir en micro-escenas antes de generar el video.
//
// Devuelve: { scenes: [{ index, text, componentType, isEnumeration }] }
// isEnumeration marca escenas candidatas a micro-escenas (enumeraciones tipo
// "cara, abdomen y piernas"). La expansión real ocurre en el pipeline con los
// tiempos por palabra; acá es solo una pista visual para la selección.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger, type BlockContext } from '@video-factory/core';
import { scriptProcessor } from '@video-factory/block-script-processor';
import { ScenePlannerBlock } from '@video-factory/block-scene-planner';
import { isAuthenticated } from '@/lib/auth';
import { loadBrand, loadPreset } from '@/lib/brand-preset-loader';
import { workDirFor, PREVIEWS_DIR, previewPlanPath } from '@/lib/paths';

export const runtime = 'nodejs';

const PreviewRequestSchema = z.object({
  brandId: z.string().min(1),
  presetId: z.string().min(1),
  script: z.string().min(10),
});

// Heurística de texto para marcar escenas candidatas a micro-escenas. La detección
// fina (con tiempos por palabra) la hace el pipeline; acá solo orientamos al usuario.
function looksLikeEnumeration(text: string): boolean {
  const t = text.toLowerCase();
  if (/\w+\s*,\s*[^,]+\s+(y|e)\s+\w+/.test(t)) return true; // "a, b y c"
  if ((t.match(/,/g)?.length ?? 0) >= 2) return true; // 2+ comas = lista
  return false;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = PreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { brandId, presetId, script } = parsed.data;
  const previewId = `preview-${randomUUID()}`;
  const workDir = workDirFor(previewId);

  try {
    const [brand, preset] = await Promise.all([loadBrand(brandId), loadPreset(presetId)]);
    await mkdir(workDir, { recursive: true });
    const logger = createLogger(previewId);
    const ctx: BlockContext = { runId: previewId, workDir, logger, brand, preset };

    const inputResult = scriptProcessor.validateInput({
      rawText: script,
      language: brand.language.split('-')[0] ?? 'es',
    });
    if (inputResult.isErr()) {
      return NextResponse.json(
        { error: `Guion inválido: ${inputResult.error.message}` },
        { status: 400 },
      );
    }
    const parsedResult = await scriptProcessor.run(inputResult.value, ctx);
    if (parsedResult.isErr()) {
      return NextResponse.json({ error: 'No se pudo procesar el guion.' }, { status: 500 });
    }

    const subtitleTrack = {
      language: 'es',
      words: [] as Array<{ word: string; startTimeSeconds: number; endTimeSeconds: number }>,
      lines: [] as Array<{
        text: string;
        startTimeSeconds: number;
        endTimeSeconds: number;
        wordRefs: number[];
      }>,
    };

    const planner = new ScenePlannerBlock({});
    const planResult = await planner.run({ parsedScript: parsedResult.value, subtitleTrack }, ctx);
    if (planResult.isErr()) {
      return NextResponse.json({ error: 'No se pudieron planificar las escenas.' }, { status: 500 });
    }

    const scenes = planResult.value.scenes.map((s) => ({
      index: s.index,
      text: s.text,
      componentType: (s as { componentType?: string }).componentType ?? 'other',
      isEnumeration: looksLikeEnumeration(s.text),
    }));

    // Persistimos el plan EXACTO para que la generación lo reuse (índices estables
    // entre lo que el usuario eligió acá y lo que se genera). Archivo pequeño.
    await mkdir(PREVIEWS_DIR, { recursive: true });
    await writeFile(previewPlanPath(previewId), JSON.stringify(planResult.value), 'utf-8');

    return NextResponse.json({ previewId, scenes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  } finally {
    // El preview es efímero: borramos su workDir temporal para no acumular
    // carpetas huérfanas en storage/runs.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
