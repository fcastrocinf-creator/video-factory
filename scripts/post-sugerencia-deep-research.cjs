// scripts/post-sugerencia-deep-research.cjs
// Posta una sugerencia formal con las 10 ideas accionables del reporte
// investigacion/14-deep-patterns-ideas-saas-oss.md (12 áreas, ~2400 palabras).

const http = require('node:http');

const body = JSON.stringify({
  title:
    'Deep research 12 áreas (timeline prompting, Topview competitor, top 10 ideas accionables)',
  category: 'improvement',
  author: 'owner+claude (deep research)',
  contextPath:
    'investigacion/14-deep-patterns-ideas-saas-oss.md, packages/blocks/image-gen-multi/, packages/blocks/scene-animator-kling/, packages/blocks/scene-planner/, packages/contracts/src/preset.schema.ts, apps/web/lib/',
  description: [
    'Research profundo de 12 areas (A-L) con SaaS (Runway, Pictory, Synthesia, HeyGen, Topview, Submagic, Vibemyad), OSS y papers academicos. Reporte completo: investigacion/14-deep-patterns-ideas-saas-oss.md (~2400 palabras).',
    '',
    'HALLAZGO CRITICO - Timeline prompting. Para image-to-video clips <=10s la practica dominante 2025-2026 (Seedance 2.0, Veo 3.1, Sora 2) dejo de ser un prompt por shot y paso a UN solo prompt time-coded ([Global setup] + [0:00-0:03] Shot/Action/Detail + [0:03-0:07] Shot/Development + [0:07-0:10] Shot/Resolution). Preserva consistencia de personaje SIN character sheet. Implica scene-animator-kling modo dual segmentado + timeline. -50% calls a Kling/Veo.',
    '',
    'COMPETIDOR DIRECTO - Topview AI. Lo mas cercano a Video Factory en SaaS publico. Hace EXACTAMENTE modo Ripear (analiza ad referencia + recrea con tu producto). AI Scriptwriter entrenado sobre 500M videos para hook taxonomy. Le falta: modo Aprender (no destila preset reusable -> nuestro diferenciador a defender), pipeline opaco, sin multi-provider fallback, sin character sheet multi-state. Si Topview agrega destilar preset, perdemos diferenciador -> moverse rapido en data flywheel.',
    '',
    'COMPETIDOR SECUNDARIO - Vibemyad/Creatify. Pre-launch performance prediction via 150k+ agentes consumer simulados. Aplicable como gate previo al render Remotion.',
    '',
    'TOP 10 IDEAS ACCIONABLES (impacto/esfuerzo):',
    '',
    'Alto impacto / Bajo esfuerzo:',
    '1. Two-layer cache (hash + semantico) en image-gen-multi. -70% costo re-renders. Drizzle ya esta.',
    '2. Timeline prompting time-coded en scene-animator-kling.',
    '3. LAION-Aesthetics pre-filter para auto-reroll. Modelo gratis ~50ms.',
    '4. Phase-tagged timeline UI en editor con colorcoding.',
    '5. Decision-logger JSONL append-only por bloque.',
    '',
    'Alto impacto / Esfuerzo medio:',
    '6. Tier strategy draft Schnell ($0.001) -> premium Imagen ($0.04) solo si aprobado. -60-80% costo Aprendizaje.',
    '7. VLM judge entre image-gen y scene-animator (catches errores antes del costo de video).',
    '8. Scene context buffer (palette + atmosphere post-imagen, inyectado al siguiente prompt). Consistency real sin character sheet.',
    '9. Langfuse self-hosted + instrumentacion OpenTelemetry.',
    '10. Hedging racing modo urgent en cascada image-gen para UX editor.',
    '',
    'DESCARTES: pre-launch consumer simulation panelistas (teatro), Tavus/Wav2Lip lip-sync (no apuntamos a avatar UGC hoy), STAGE training-free completo (complejo vs ganancia marginal sobre BigBanana).',
    '',
    'OTRAS POR AREA: middle layer plot beats (ACM CHI 2025), RAG corpus cinematografia (FilMaster), Director/Cinematographer separados, anchor frame chain, Veo 3.1 4 ref-images simultaneas, pairwise > pointwise validation, SpecifyUI edit-spec > edit-prompt, WhisperX phoneme alignment <100ms, auto music ducking, SSML emphasis, composition-aware subtitle placement no-tapar-cara, Frontify brand como API queryable, AIDA timing targets, emotional arc detection, hook taxonomy 7 formulas, VSL mechanism-story para suplementos, performance data -> preset weights, cohort patterns, ElevenLabs neutralLatam, forbidden claims COFEPRIS/FDA por mercado (CRITICO para Vitaly), deterministic replay con seeds.',
    '',
    'Files: investigacion/14-deep-patterns-ideas-saas-oss.md (12 areas, 30+ patrones).',
  ].join('\n'),
});

const opts = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/sugerencias',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = http.request(opts, (res) => {
  let chunks = '';
  res.on('data', (c) => (chunks += c));
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    try {
      console.log(JSON.stringify(JSON.parse(chunks), null, 2));
    } catch {
      console.log(chunks);
    }
    process.exit(res.statusCode === 201 ? 0 : 1);
  });
});

req.on('error', (e) => {
  console.error('REQ ERR:', e.message);
  process.exit(1);
});

req.write(body);
req.end();
