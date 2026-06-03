// Corre el PANEL MULTI-AGENTE de detección (format-audit) sobre un RENDER creado,
// comparándolo (si existe) con el ORIGINAL de referencia. Esto es lo que faltaba:
// que los agentes corran sobre lo que CREAMOS, no solo al aprender.
// Uso: npx tsx scripts/run-format-audit.ts [renderMp4] [originalMp4]
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Cargar .env raíz (ANTHROPIC_API_KEY para la visión de los agentes).
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

import { runFormatAudit, formatAuditEnabled } from '../apps/web/lib/kb/format-audit';

const ROOT = 'C:\\Users\\cmktc\\proyectos\\video-factory';
const render = resolve(process.argv[2] ?? `${ROOT}\\storage\\proto-composite\\supercalm-validacion.mp4`);
const originalArg =
  process.argv[3] ??
  'C:\\Users\\cmktc\\OneDrive\\Escritorio\\ORGANIZADO\\02-MARCAS\\SuperCalm\\Creativos\\UGC - OBJECIONES - MOFU - PRODUCT AWARE V2.mp4';
const original = existsSync(originalArg) ? originalArg : undefined;

const CONTEXT = `Formato original "SuperCalm doctor split-screen" (primeros ~29s): médico (autoridad) habla a cámara + usuaria (Rosa) testimonio + médico en PiP durante el testimonio + círculos/flechas ROJOS señalando ojeras y papada cuando el médico las menciona + 2 voces (médico + usuaria) + captions amarillos.
El RENDER auditado REPRODUCE esos ~29s con personas UGC reales: (1) médico UGC a pantalla completa en su consulta (hook); (2) Rosa UGC testimonio a pantalla completa + médico en PiP esquina; (3) médico UGC explicando a pantalla completa; (4) corte a Rosa close-up con CÍRCULOS ROJOS en ojeras y papada sincronizados a "sus ojeras y su papada". 2 voces reales (médico + Rosa). SIN subtítulos (decisión del owner). Compara la fidelidad del ESTILO DE EDICIÓN vs el original (estructura, cortes, PiP, anotaciones sincronizadas, ritmo) y detecta lo que aún se ve falso/amateur o lo que falta.`;

async function main(): Promise<void> {
  if (!formatAuditEnabled()) {
    console.error('ANTHROPIC_API_KEY no disponible — no se puede correr el panel.');
    process.exit(1);
    return;
  }
  console.log(`Render:   ${render}`);
  console.log(`Original: ${original ?? '(no encontrado — auditoría solo del render)'}`);
  console.log('Corriendo panel multi-agente con visión...\n');
  const res = await runFormatAudit({
    scope: 'supercalm-validacion',
    label: 'Validación rip SuperCalm (médico PiP + anotaciones)',
    renderVideoPath: render,
    originalVideoPath: original,
    contextText: CONTEXT,
    depth: 'rapido',
  });
  console.log(`\n===== AUDITORÍA: ${res.label} =====`);
  console.log(`especialistas: ${res.especialistasAuditados.join(', ')}`);
  console.log(`salteados: ${res.especialistasSalteados.join(', ') || '—'}`);
  console.log(`hallazgos: ${res.hallazgos.length} · descartados (falsos+): ${res.descartados} · llamadas IA: ${res.llamadas}`);
  if (res.errores.length) console.log(`errores: ${res.errores.join(' | ')}`);
  console.log('\n----- HALLAZGOS -----');
  for (const h of res.hallazgos) {
    console.log(`\n[${(h as { severidad?: string }).severidad ?? '?'}] ${(h as { titulo?: string }).titulo ?? ''}`);
    console.log(JSON.stringify(h, null, 2));
  }
  if (res.sintesis) {
    console.log('\n----- SÍNTESIS (IA superior) -----');
    console.log(JSON.stringify(res.sintesis, null, 2));
  }
}
void main();
