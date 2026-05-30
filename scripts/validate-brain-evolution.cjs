// scripts/validate-brain-evolution.cjs
//
// Valida el cerebro evolutivo de la herramienta (M7 #5).
//
// Workflow:
//   1. Llama POST /api/admin/prompt-patches → escanea logs + post-render-reports,
//      detecta patrones sistémicos y propone patches con Claude Sonnet.
//   2. Reporta:
//      - Patterns detectados (por categoría)
//      - Patches propuestos (con confidence + diff resumido)
//      - Si encontró burned-in-text como patrón sistémico → ✓ esperado
//      - Si no → cuántos runs distintos con burned-in faltan para superar el umbral
//   3. Lee storage/preset-memory/judgments.jsonl y reporta:
//      - Top presets por confidence
//      - Tendencias (qué tipo de presets más aprobados)
//
// Uso: node scripts/validate-brain-evolution.cjs
//
// Requiere dev server up (consulta el endpoint) + cookie auth válida en
// storage/probe/vf-cookie.txt (la misma usada por test-editor-flow.cjs).

const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const COOKIE_FILE = resolve(REPO_ROOT, 'storage', 'probe', 'vf-cookie.txt');

function readCookie() {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`Cookie no encontrada en ${COOKIE_FILE}`);
    console.error('Logueate primero con:');
    console.error('  curl -c storage/probe/vf-cookie.txt -H "Content-Type: application/json" \\');
    console.error('    -d \'{"password":"<APP_PASSWORD>"}\' http://localhost:3000/api/auth');
    process.exit(1);
  }
  const raw = readFileSync(COOKIE_FILE, 'utf-8');
  for (let line of raw.split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.replace(/^#HttpOnly_/, '');
    if (line.startsWith('#') || !line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[5] === 'app_auth') {
      return `app_auth=${cols[6]}`;
    }
  }
  throw new Error('Cookie app_auth no encontrada');
}

async function callApi(method, urlPath, body) {
  const cookie = readCookie();
  const opts = {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const resp = await fetch(`http://localhost:3000${urlPath}`, opts);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${method} ${urlPath} → HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function readJudgments() {
  // Mismo path resolution que preset-judgment-memory.ts (process.cwd() based)
  const candidates = [
    resolve(REPO_ROOT, 'storage', 'preset-memory', 'judgments.jsonl'),
    resolve(REPO_ROOT, 'apps', 'web', 'storage', 'preset-memory', 'judgments.jsonl'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null);
    }
  }
  return [];
}

function colorScore(score) {
  if (score >= 80) return `\x1b[32m${score}\x1b[0m`; // green
  if (score >= 60) return `\x1b[33m${score}\x1b[0m`; // yellow
  return `\x1b[31m${score}\x1b[0m`; // red
}

(async () => {
  console.log('🧬 VALIDADOR DEL CEREBRO EVOLUTIVO\n');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================
  // PASO 1 — Disparar detección de patrones (calls POST endpoint)
  // ============================================================
  console.log('📊 Paso 1: escaneando logs + post-render-reports en busca de patrones...\n');
  let detection;
  try {
    detection = await callApi('POST', '/api/admin/prompt-patches', {
      minOccurrences: 1, // bajamos a 1 para detectar patrones tempranos
      maxAgeDays: 90,
      maxRuns: 100,
    });
  } catch (e) {
    console.error('✗ Falló el endpoint de detección:', e.message);
    console.error('  ¿Dev server up? ¿Cookie válida?');
    process.exit(1);
  }

  console.log(`✓ Detección completa: ${detection.patternsDetected} patrón(es) sistémico(s)`);
  console.log(`  → ${detection.proposalsCreated} patch(es) propuesto(s)`);
  if (detection.errors && detection.errors.length > 0) {
    console.log(`  ⚠ ${detection.errors.length} error(es) durante propuesta:`);
    for (const err of detection.errors) console.log(`     - ${err}`);
  }
  console.log('');

  // ============================================================
  // PASO 2 — Listar todos los patches (pending + applied + rejected)
  // ============================================================
  console.log('📋 Paso 2: listando TODOS los patches propuestos hasta ahora...\n');
  const list = await callApi('GET', '/api/admin/prompt-patches?all=1');
  const proposals = list.proposals ?? [];

  if (proposals.length === 0) {
    console.log('(Ningún patch propuesto todavía)\n');
  } else {
    const byStatus = { pending: 0, approved: 0, rejected: 0, applied: 0 };
    for (const p of proposals) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    console.log(
      `Total: ${proposals.length} (${byStatus.pending} pending · ${byStatus.applied} applied · ${byStatus.rejected} rejected)\n`,
    );

    const byCategory = {};
    for (const p of proposals) {
      const cat = p.pattern.category;
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p);
    }
    for (const [cat, ps] of Object.entries(byCategory)) {
      console.log(`  [${cat}] (${ps.length} patches)`);
      for (const p of ps.slice(0, 3)) {
        console.log(`    - ${p.id.slice(0, 8)} · status=${p.status} · confidence=${colorScore(p.confidence)} · ${p.pattern.occurrenceCount} runs afectados`);
        console.log(`      target: ${p.targetFilePath.split(/[\\/]/).slice(-2).join('/')}`);
        console.log(`      reasoning: ${p.reasoning.slice(0, 120)}...`);
      }
      if (ps.length > 3) console.log(`    ... y ${ps.length - 3} más`);
    }
  }
  console.log('');

  // ============================================================
  // PASO 3 — Check específico: ¿detectó burned-in-text?
  // ============================================================
  console.log('🎯 Paso 3: validación específica — ¿se detectó "burned-in-text"?\n');
  const burnedInPatches = proposals.filter((p) => p.pattern.category === 'burned-in-text');
  if (burnedInPatches.length > 0) {
    console.log(`✅ SÍ — ${burnedInPatches.length} patch(es) para burned-in-text`);
    const p = burnedInPatches[0];
    console.log(`   Pattern detectado en ${p.pattern.occurrenceCount} runs distintos`);
    console.log(`   Target: ${p.targetFilePath.split(/[\\/]/).slice(-3).join('/')}`);
    console.log(`   Confidence Claude Sonnet: ${p.confidence}/100`);
    console.log(`   patchType: ${p.patchType}`);
    console.log(`   Expected improvement: "${p.expectedImprovement.slice(0, 200)}"`);
    console.log(`   → Revisá en UI: /admin sección "🧬 Cerebro evolutivo"`);
  } else {
    console.log('⏳ NO todavía — el patrón burned-in-text no superó el umbral de runs');
    console.log('   Esto puede ser porque:');
    console.log('   - Pocos runs con burned-in registrado en post-render-reports');
    console.log('   - Threshold minOccurrences=1 muy bajo (filtró por noise antes)');
    console.log('   - Los issues no usan keywords que el clasificador reconoce');
    console.log('');
    console.log('   Para confirmar: revisá storage/runs/*/post-render-report.json');
    console.log('   y buscá issues con description que contenga "burned" o "text incrustado"');
  }
  console.log('');

  // ============================================================
  // PASO 4 — Feedback loop (M7 #3) — top presets por confidence
  // ============================================================
  console.log('🏆 Paso 4: feedback loop — top presets por confidence histórica\n');
  const judgments = readJudgments();
  if (judgments.length === 0) {
    console.log('(Sin juicios registrados todavía en storage/preset-memory/judgments.jsonl)');
    console.log('  → Aprobá un preset en /admin para empezar a alimentar este log');
  } else {
    console.log(`${judgments.length} juicios registrados totales`);
    const byPreset = new Map();
    for (const j of judgments) {
      if (!byPreset.has(j.presetId)) {
        byPreset.set(j.presetId, { presetId: j.presetId, confidence: 0, counts: {} });
      }
      const s = byPreset.get(j.presetId);
      s.counts[j.kind] = (s.counts[j.kind] || 0) + 1;
      const w = typeof j.weight === 'number' && Number.isFinite(j.weight) ? j.weight : 1.0;
      if (j.kind === 'approved' || j.kind === 'run-success') s.confidence += w;
      else if (j.kind === 'rejected' || j.kind === 'run-failed') s.confidence -= w;
      else if (j.kind === 'edited') s.confidence += 0.3 * w;
      else if (j.kind === 'used-for-rip') s.confidence += 0.1 * w;
    }
    const sorted = [...byPreset.values()].sort((a, b) => b.confidence - a.confidence);
    console.log('Top 5:');
    for (const s of sorted.slice(0, 5)) {
      const counts = Object.entries(s.counts).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`  ${colorScore(Math.round(s.confidence))} · ${s.presetId}`);
      console.log(`     ${counts}`);
    }
  }
  console.log('');

  // ============================================================
  // PASO 5 — Resumen final
  // ============================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧬 RESUMEN DEL CEREBRO\n');
  console.log(`  Patrones sistémicos detectados:    ${detection.patternsDetected}`);
  console.log(`  Patches propuestos por Claude:     ${detection.proposalsCreated}`);
  console.log(`  Patches totales en historial:      ${proposals.length}`);
  console.log(`  Juicios humanos registrados:       ${judgments.length}`);
  console.log(`  Burned-in detectado como patrón:   ${burnedInPatches.length > 0 ? '✅ SÍ' : '⏳ pendiente'}`);
  console.log('');
  console.log('  → Para revisar/aprobar patches: http://localhost:3000/admin');
  console.log('  → Para ver el código: apps/web/lib/prompt-evolution.ts');
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ Error fatal:', e.message);
  process.exit(1);
});
