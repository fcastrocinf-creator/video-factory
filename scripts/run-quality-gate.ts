// COMPUERTA DE CALIDAD a demanda sobre un RENDER ya producido (un final.mp4).
// Corre el panel multi-agente con visión (format-audit) sobre el render, deriva un
// VEREDICTO determinista pass/revisar/fail + recomendaciones, lo persiste y sale con
// un EXIT-CODE semántico (usable como gate real en CI/precommit). NUNCA aplica nada
// (solo PROPONE). Molde: scripts/run-format-audit.ts.
//
// Uso:
//   pnpm tsx scripts/run-quality-gate.ts --run <runId> [--original <ref.mp4>] [--depth rapido|profundo] [--gemini] [--rip <ripId>]
//   pnpm tsx scripts/run-quality-gate.ts --render storage/runs/<id>/final.mp4 --original ./ref.mp4
//
// --rip <ripId>: carga el AdAnalysis del rip (tabla `rips`) para DERIVAR la rúbrica
//   del formato y pasársela al juez (sin esto el juez Gemini corre "ciego" de los
//   criterios del formato). Recomendado junto a --gemini.
//
// Exit codes:  0 = PASA · 1 = REVISAR · 2 = FALLA · 3 = error de ejecución.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Cargar .env raíz (ANTHROPIC_API_KEY para la visión de los agentes + VF_GATE_*).
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

import { runQualityGate, gateEnabled, type GateBlocker } from '../apps/web/lib/kb/quality-gate';
import { AdAnalysisSchema, type AdAnalysis } from '@video-factory/contracts';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
// Importamos el SCHEMA por ruta RELATIVA (no vía el alias `@db/*` de apps/web): ese
// alias solo está en apps/web/tsconfig, así que importar apps/web/lib/db.ts rompería
// la carga del CLI bajo tsx (Cannot find module '@db/schema'). Aquí abrimos la misma
// DB (db/local.db) con un cliente propio.
import { rips } from '../db/schema';

/** Carga el AdAnalysis de un rip (tabla `rips.analysisJson`). null si no existe/ilegible. */
async function loadAnalysisForRip(ripId: string): Promise<AdAnalysis | null> {
  try {
    const dbFile = process.env['DATABASE_URL'] ?? `file:${resolve(process.cwd(), 'db', 'local.db')}`;
    const db = drizzle(createClient({ url: dbFile }));
    const rows = await db.select().from(rips).where(eq(rips.id, ripId)).limit(1);
    const row = rows[0];
    if (!row || !row.analysisJson) return null;
    const parsed = AdAnalysisSchema.safeParse(JSON.parse(row.analysisJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ─── Parseo simple de flags (--clave valor / --bandera) ─────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function fmtBlocker(b: GateBlocker, i: number): string {
  return `  ${i + 1}. [${b.severidad}] (${b.dimension}) ${b.titulo}\n      fix: ${b.fixPropuesto}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runId = typeof args['run'] === 'string' ? (args['run'] as string) : undefined;
  const renderArg = typeof args['render'] === 'string' ? (args['render'] as string) : undefined;
  const originalArg = typeof args['original'] === 'string' ? (args['original'] as string) : undefined;
  const ripId = typeof args['rip'] === 'string' ? (args['rip'] as string) : undefined;
  const depth = args['depth'] === 'profundo' ? 'profundo' : 'rapido';
  const useGemini = args['gemini'] === true || args['gemini'] === 'true';

  if (!runId && !renderArg) {
    console.error('Falta el render a juzgar. Usa --run <runId> o --render <ruta a final.mp4>.');
    console.error('Ej: pnpm tsx scripts/run-quality-gate.ts --run abc123 --original ./ref.mp4 --gemini');
    process.exit(3);
    return;
  }

  const renderVideoPath = renderArg ? resolve(renderArg) : undefined;
  const originalVideoPath = originalArg ? resolve(originalArg) : undefined;
  if (renderVideoPath && !existsSync(renderVideoPath)) {
    console.error(`No existe el render: ${renderVideoPath}`);
    process.exit(3);
    return;
  }
  if (originalVideoPath && !existsSync(originalVideoPath)) {
    console.error(`No existe el original: ${originalVideoPath} — se ignora (auditoría solo del render).`);
  }
  const original = originalVideoPath && existsSync(originalVideoPath) ? originalVideoPath : undefined;

  if (!gateEnabled()) {
    console.error('ANTHROPIC_API_KEY no disponible — la compuerta no puede correr el panel. Saliendo 0 (no rompe CI).');
    process.exit(0);
    return;
  }

  // Rúbrica: si se pasó --rip, cargamos el AdAnalysis para derivarla y dársela al
  // juez (criterios del formato). Sin esto el juez corre con su prompt genérico.
  let analysis: AdAnalysis | undefined;
  if (ripId) {
    analysis = (await loadAnalysisForRip(ripId)) ?? undefined;
    if (!analysis) {
      console.error(`Aviso: no se pudo cargar el análisis del rip ${ripId} — la compuerta corre SIN rúbrica del formato.`);
    }
  }

  console.log(`Render:   ${renderVideoPath ?? `storage/runs/${runId}/final.mp4 (por runId)`}`);
  console.log(`Original: ${original ?? '(no provisto — sin comparación de fidelidad)'}`);
  console.log(`Rúbrica:  ${analysis ? `derivada del rip ${ripId}` : '(sin --rip — el juez corre con criterios genéricos)'}`);
  console.log(`Profundidad: ${depth} · Juez Gemini video+audio: ${useGemini ? 'SÍ' : 'no'}`);
  console.log('Corriendo compuerta de calidad...\n');

  const report = await runQualityGate({
    runId,
    renderVideoPath,
    originalVideoPath: original,
    analysis,
    depth,
    useGemini,
  });

  const icono = report.veredicto === 'pass' ? 'PASA' : report.veredicto === 'revisar' ? 'REVISAR' : 'FALLA';
  console.log(`===== VEREDICTO: ${icono} =====`);
  console.log(report.resumen);
  console.log('');
  console.log(`especialistas: ${report.especialistasAuditados.join(', ') || '—'}`);
  if (report.especialistasSalteados.length) console.log(`salteados: ${report.especialistasSalteados.join(', ')}`);
  console.log(`comparado con original: ${report.comparedWithOriginal ? 'sí' : 'no'} · política: fail≥${report.policy.failOn}, revisar≥${report.policy.reviewOn}`);
  if (report.errores.length) console.log(`errores: ${report.errores.join(' | ')}`);

  if (report.bloqueantes.length) {
    console.log('\n----- BLOQUEANTES (justifican el veredicto) -----');
    report.bloqueantes.forEach((b, i) => console.log(fmtBlocker(b, i)));
  }
  if (report.recomendaciones.length) {
    console.log('\n----- RECOMENDACIONES (menores; NO se aplican solas) -----');
    report.recomendaciones.forEach((b, i) => console.log(fmtBlocker(b, i)));
  }

  const proximoPaso =
    report.veredicto === 'fail'
      ? 'Próximo paso: corrige los bloqueantes (en el editor / regenerando el componente que falla) y vuelve a correr la compuerta.'
      : report.veredicto === 'revisar'
        ? 'Próximo paso: revisa los puntos marcados; si te parecen aceptables, puedes publicar.'
        : 'Próximo paso: el render pasó la compuerta. Listo para publicar.';
  console.log(`\n${proximoPaso}`);

  // Exit-code semántico (gate real en CI/precommit).
  process.exit(report.veredicto === 'fail' ? 2 : report.veredicto === 'revisar' ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('Error corriendo la compuerta de calidad:', e instanceof Error ? e.message : e);
  process.exit(3);
});
