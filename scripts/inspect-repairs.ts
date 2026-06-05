// Inspecciona qué reparaciones propone planRepairs sobre el reporte de gate de un run
// (sin ejecutar nada, sin gasto). Imprime, por bloqueante, la acción + escena + si el
// "brazo" la puede ejecutar. Sirve para elegir el blockerIndex a auto-reparar.
//
// Uso: pnpm tsx scripts/inspect-repairs.ts <runId>

import { readQualityGateReport } from '../apps/web/lib/kb/findings';
import { planRepairs } from '../apps/web/lib/kb/repair-loop';
import { repairActionIsExecutable } from '../apps/web/lib/repair-plan';

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Falta el runId. Uso: pnpm tsx scripts/inspect-repairs.ts <runId>');
    process.exit(1);
    return;
  }
  const gate = await readQualityGateReport(`gate:${runId}`);
  if (!gate) {
    console.error(`No hay reporte de gate para gate:${runId}`);
    process.exit(1);
    return;
  }
  const repairs = planRepairs(gate);
  console.log(`Reparaciones para ${runId} (${repairs.length} bloqueantes):\n`);
  repairs.forEach((r, i) => {
    const exec = repairActionIsExecutable(r.action) ? '✅ EJECUTABLE' : '— (editor/escalar)';
    console.log(
      `  [${i}] ${exec}  action=${r.action.kind}  escena=${r.sceneIndex ?? 'null'}  (${r.blocker.dimension})`,
    );
    console.log(`       ${r.blocker.titulo}`);
  });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
