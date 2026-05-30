// GET  /api/admin/prompt-patches            → lista propuestas (default: solo pendientes)
// POST /api/admin/prompt-patches/detect     → escanea logs y propone patches nuevos

import { NextResponse, type NextRequest } from 'next/server';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAuthenticated } from '@/lib/auth';
import {
  detectSystemicPatterns,
  listAllPatchProposals,
  listPendingPatchProposals,
  proposePromptPatch,
} from '@/lib/prompt-evolution';
import { REPO_ROOT } from '@/lib/paths';

export const runtime = 'nodejs';
// Detect + propose puede tardar varios minutos con muchos patrones (cada uno
// llama a Claude Sonnet). En Vercel default es 10s — sin esto el endpoint corta.
export const maxDuration = 300;

// Mapeo de bloque afectado → path source + nombre de la const del SYSTEM_PROMPT.
// Solo incluimos bloques que tienen un SYSTEM_PROMPT EXTRACTABLE (un template
// literal asignado a una const con nombre conocido). Bloques cuyo prompt se
// construye dinámicamente scene-by-scene (image-gen-multi, rip-fidelity-aligner)
// NO están acá — sus mejoras requieren patch al código de construcción, no al
// prompt directamente.
//
// IMPORTANTE: los promptVarName de acá deben matchear EXACTAMENTE con const|let
// en el source. Si renombrás una const en el código, hay que actualizar acá.
const BLOCK_TO_SOURCE: Record<
  string,
  { relativePath: string; promptVarName: string }
> = {
  'scene-planner': {
    relativePath: 'packages/blocks/scene-planner/src/block.ts',
    promptVarName: 'systemInstruction',
  },
  // visual-quality-low → preview-judge (no image-gen-multi, que construye scene-by-scene)
  'image-gen-multi': {
    relativePath: 'packages/blocks/preview-judge/src/judge-prompt.ts',
    promptVarName: 'SYSTEM_PROMPT',
  },
  'editor-loop': {
    relativePath: 'packages/blocks/post-render-judge/src/editor-loop.ts',
    promptVarName: 'EDITOR_V2_SYSTEM_PROMPT',
  },
  'video-understander': {
    relativePath: 'apps/web/lib/video-understander.ts',
    promptVarName: 'SYSTEM_PROMPT',
  },
  'ad-analyzer': {
    relativePath: 'apps/web/lib/ad-analyzer.ts',
    promptVarName: 'SYSTEM_INSTRUCTION',
  },
  // NOTA: 'rip-fidelity-aligner' y 'post-render-judge' no aparecen acá porque
  // sus prompts se construyen dinámicamente. Los patrones de error categorizados
  // a esos bloques generan un error explícito "sin mapping" en el endpoint.
};

/**
 * Extrae el contenido literal de un const STRING del source file via regex.
 * Funciona para template literals `...` y strings con backticks.
 */
function extractPromptFromSource(source: string, varName: string): string | null {
  // Pattern: [export ]const|let NAME [: type] = `...` ;
  // Tomamos el template literal completo entre backticks. Soporta también
  // `export const` (preview-judge expone SYSTEM_PROMPT así).
  // El varName se escapa por seguridad contra regex injection (defensa en
  // profundidad — aunque hoy viene de BLOCK_TO_SOURCE hardcoded).
  const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:export\\s+)?(?:const|let)\\s+${escapedVarName}(?:\\s*:[^=]+)?\\s*=\\s*\`([\\s\\S]*?)\`;`,
    'm',
  );
  const m = re.exec(source);
  return m && m[1] ? m[1] : null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const url = new URL(req.url);
  const includeAll = url.searchParams.get('all') === '1';
  const proposals = includeAll
    ? await listAllPatchProposals()
    : await listPendingPatchProposals();
  return NextResponse.json({
    proposals: proposals.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'].startsWith('ROTATE_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY no configurada' }, { status: 503 });
  }

  let body: { minOccurrences?: number; maxAgeDays?: number; maxRuns?: number } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // opcional
  }

  // Bounds defensivos: prevenir abuse (minOccurrences negativo → patrones spurio;
  // maxRuns gigante → escaneo exhaustivo del disco; etc.)
  const clamp = (v: number | undefined, def: number, min: number, max: number) =>
    Math.max(min, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def));

  // 1) Detectar patrones
  const patterns = await detectSystemicPatterns({
    minOccurrences: clamp(body.minOccurrences, 3, 1, 100),
    maxAgeDays: clamp(body.maxAgeDays, 30, 1, 365),
    maxRuns: clamp(body.maxRuns, 50, 1, 500),
  });

  if (patterns.length === 0) {
    return NextResponse.json({
      ok: true,
      patternsDetected: 0,
      proposalsCreated: 0,
      message: `Sin patrones sistémicos detectados (umbral ${body.minOccurrences ?? 3} runs distintos).`,
    });
  }

  // 2) Para cada patrón, proponer patch al bloque afectado
  const proposals = [];
  const errors: string[] = [];
  for (const pattern of patterns) {
    const blockInfo = BLOCK_TO_SOURCE[pattern.affectedBlock];
    if (!blockInfo) {
      errors.push(`Bloque ${pattern.affectedBlock} sin mapping de source — skip`);
      continue;
    }
    const targetFilePath = resolve(REPO_ROOT, blockInfo.relativePath);
    if (!existsSync(targetFilePath)) {
      errors.push(`Source ${blockInfo.relativePath} no existe`);
      continue;
    }
    let currentPromptText: string | null = null;
    try {
      const source = await readFile(targetFilePath, 'utf-8');
      currentPromptText = extractPromptFromSource(source, blockInfo.promptVarName);
    } catch (e) {
      errors.push(`Falló lectura de ${blockInfo.relativePath}: ${(e as Error).message}`);
      continue;
    }
    if (!currentPromptText) {
      errors.push(
        `No se pudo extraer ${blockInfo.promptVarName} de ${blockInfo.relativePath} (regex no matcheó)`,
      );
      continue;
    }

    try {
      const { proposal } = await proposePromptPatch({
        pattern,
        targetFilePath,
        targetPromptVarName: blockInfo.promptVarName,
        currentPromptText,
      });
      proposals.push(proposal);
    } catch (e) {
      errors.push(`Patch proposer falló para ${pattern.category}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    patternsDetected: patterns.length,
    proposalsCreated: proposals.length,
    proposals,
    errors,
  });
}
