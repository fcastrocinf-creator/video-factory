// Backfill Error Memory desde logs históricos.
//
// Lee TODOS los .log de smokes anteriores en storage/runs/ y extrae las
// entradas "scene_done_with_issues" + "scene_validated" verdict=regenerate.
// Las inyecta retroactivamente en la Error Memory para que el próximo run
// arranque con lecciones aprendidas de todas las iteraciones anteriores.

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordError, type ErrorCategory } from '@video-factory/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface LogEntry {
  msg?: string;
  scene?: number;
  runId?: string;
  issues?: string[];
  refinementHint?: string | null;
  finalScore?: number;
  score?: number;
  verdict?: string;
  step?: string;
  exhaustedStep?: string;
}

function categorizeIssues(issues: string[]): ErrorCategory[] {
  const text = issues.join(' ').toLowerCase();
  const cats: ErrorCategory[] = [];
  if (/finger|digit|hand_\d|thumb/i.test(text)) cats.push('anatomy_hands');
  if (/toe|foot_\d/i.test(text)) cats.push('anatomy_feet');
  if (/face|eye|nose|mouth|symmetry/i.test(text)) cats.push('anatomy_face');
  if (/proportion|larger than head|too small/i.test(text)) cats.push('body_proportions');
  if (/fusion|fuse|merge/i.test(text)) cats.push('body_part_fusion');
  if (/gibberish|illegible|nonsense|^text/i.test(text)) cats.push('text_gibberish');
  if (/number|calendar|sequential/i.test(text)) cats.push('numbers_illogical');
  if (/illogical visual|infinity|abstract|symbol|geometric/i.test(text)) cats.push('illogical_element');
  if (/semantic|does not match|disconnected|narration/i.test(text)) cats.push('semantic_mismatch');
  if (/character mismatch|gender|ethnic|age/i.test(text)) cats.push('character_mismatch');
  if (cats.length === 0) cats.push('other');
  return cats;
}

function extractKeywords(text: string): string[] {
  const found = text.toLowerCase().match(
    /\b(ojeras|dark[\s-]?circles?|swollen|hinchada|finger|dedo|toe|hand|mano|foot|pie|face|cara|skin|piel|calendar|days?|d[ií]as?|vitaly|gotas?|number|riñ[oó]n|kidney|infinity|abstract|gibberish|label|linf[áa]tico|lymphatic|colapsado)\b/g,
  );
  return [...new Set(found ?? [])].slice(0, 10);
}

async function processLog(logPath: string): Promise<number> {
  const content = await readFile(logPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // Buscamos pares: scene_validated (regenerate) + scene_done_with_issues
  // O scene_done_with_issues directo.
  let recorded = 0;
  for (const line of lines) {
    // Las líneas no-JSON las saltamos
    if (!line.startsWith('{')) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }
    if (entry.msg !== 'image-gen-multi:scene_done_with_issues') continue;
    if (!entry.issues || entry.issues.length === 0) continue;
    if (typeof entry.scene !== 'number') continue;

    // Para cada entrada, registramos UNA categoría (la primera detectada)
    const cats = categorizeIssues(entry.issues);
    const desc = entry.issues.join(' | ').slice(0, 500);
    const keywords = extractKeywords(`${entry.issues.join(' ')} ${entry.refinementHint ?? ''}`);

    for (const cat of cats.slice(0, 2)) {
      await recordError({
        runId: entry.runId,
        provider: 'historical',
        model: 'unknown', // logs viejos no tienen step label estándar
        narration: '', // no se logueaba en los old runs
        originalPrompt: '',
        errorCategory: cat,
        errorDescription: desc,
        validatorScore: entry.finalScore ?? entry.score,
        refinementHintGiven: entry.refinementHint ?? undefined,
        keywords,
        wasFixed: false,
      });
      recorded++;
    }
  }
  return recorded;
}

async function main() {
  const runsDir = resolve(REPO_ROOT, 'storage/runs');
  const files = await readdir(runsDir);
  const logs = files.filter((f) => f.endsWith('.log'));
  console.log(`Encontrados ${logs.length} archivos .log:`);
  let totalRecorded = 0;
  for (const log of logs) {
    const path = resolve(runsDir, log);
    const n = await processLog(path);
    if (n > 0) console.log(`  - ${log}: ${n} errores registrados`);
    totalRecorded += n;
  }
  console.log(`\nTOTAL: ${totalRecorded} entradas registradas en Error Memory.`);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
