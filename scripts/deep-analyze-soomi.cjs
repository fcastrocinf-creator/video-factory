// scripts/deep-analyze-soomi.cjs
//
// Análisis PROFUNDO del video SOOMI con énfasis en:
//   - Por qué cada escena "se siente viva" (motion + camera + character animation)
//   - Narrativa visual cross-scene (story arc, continuity)
//   - Patrones específicos de animación que hacen al video efectivo
//   - Errores que NO comete (que podríamos imitar como reglas anti-error)
//
// Output: JSON estructurado en storage/probe/soomi-deep-analysis.json
// que podamos usar para fortalecer prompts del scene-planner y motion del animator.

const { readFileSync, readdirSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const framesDir = resolve(__dirname, '..', 'storage', 'probe', 'video2-scenes');
const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

const SYSTEM_PROMPT = `Sos un director de cine + experto en motion design + analista de publicidad digital con 20 años de experiencia. Especializado en entender QUÉ hace que un ad animado se sienta vivo vs muerto.

Vas a recibir frames de un anuncio vertical 9:16 (167s). Tu análisis debe SUPERAR el típico "describe lo que ves" y entrar en:

1. **VIVACIDAD por escena**:
   - ¿Hay implicit motion (postura dinámica, gesto en progreso, expresión en transición)?
   - ¿Los personajes parecen estar EN MEDIO de una acción (no posando)?
   - ¿La composición sugiere movimiento futuro (foreshortening, leading lines)?
   - ¿Hay micro-expresiones detectables que un motion engine puede animar?

2. **NARRATIVA VISUAL cross-escena**:
   - ¿Cómo evoluciona el estado emocional del personaje principal a lo largo del video?
   - ¿Hay un story arc claro (problema → tensión → revelación → solución → resultado)?
   - ¿Qué transitions usa? (cut directo, dissolve implícito, match cut, etc.)
   - ¿Las escenas se sienten parte de UN video o como gallery aislada?

3. **PATRONES de animación** (qué tipo de motion espera cada frame):
   - Escenas tipo "talking head" → mouth + blink + slight head tilt
   - Escenas tipo "action" → full body movement + camera follow
   - Escenas tipo "product reveal" → push-in + lighting shift
   - Escenas tipo "anatomical diagram" → labeled parts flying in + zoom
   - Escenas tipo "comparison" → before/after wipe + character emotion shift

4. **ANTI-PATTERNS** (errores que el ad NO comete y que un mal análisis SÍ produciría):
   - ¿Texto burned-in? ¿Cuál? ¿Es intencional o leak?
   - ¿Anatomía rota? (dedos extra, manos deformes)
   - ¿Personajes inconsistentes entre escenas?
   - ¿Brand mismatch (muestra otro producto)?

Devolvé EXCLUSIVAMENTE JSON sin markdown:

{
  "overallStoryArc": "<3-4 oraciones describiendo el arco narrativo completo del ad>",
  "characterEvolution": [
    { "characterId": "doctor-japonés", "states": ["confident-explaining", "concerned", "revealing-secret", "satisfied"] },
    ...
  ],
  "vivenessKeyFactors": [
    "<3-7 factores específicos que hacen al ad sentirse vivo>"
  ],
  "narrativeTransitionTypes": [
    "<tipos de transición observados, ej: 'character-pose-evolution', 'symbolic-match-cut', 'before-after-wipe'>"
  ],
  "sceneAnimationRecommendations": [
    {
      "approxTimeSec": <inicio aprox>,
      "shotType": "talking-head" | "anatomical-diagram" | "split-screen" | "product-shot" | "comic-panel" | "before-after" | "character-action" | "infographic",
      "motionType": "<descripción específica del motion recomendado para imitar la vivacidad de esta escena>",
      "narrativeBeat": "<rol narrativo: hook | problem | mechanism | demo | product-reveal | social-proof | cta>",
      "expectedDuration": <segundos>,
      "vivenessNote": "<por qué esta escena se sintió viva en el original>"
    }
  ],
  "antiPatternsObserved": {
    "burnedInText": [{ "approxTime": N, "text": "...", "isIntentional": bool, "language": "es|en|other" }],
    "anatomyIssues": [{ "approxTime": N, "description": "..." }],
    "characterInconsistencies": [{ "description": "..." }],
    "brandMismatch": null | { "description": "..." }
  },
  "antiPatternRulesToEnforce": [
    "<reglas concretas que el scene-planner debería ENFORZAR para no cometer errores comunes>"
  ],
  "improvedMotionPromptTemplate": "<plantilla de motion prompt que el scene-animator debería usar para cada tipo de shot — debe activar story-driven motion, no bucle pasivo>",
  "globalNotes": "<insights únicos del análisis profundo que NO suelen aparecer en análisis superficial>"
}`;

(async () => {
  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  console.log(`Frames disponibles: ${files.length}`);

  // Tomamos 30 frames uniformes (1 cada ~5.6s) — más densidad que análisis previos
  const TARGET = 30;
  const step = Math.max(1, Math.floor(files.length / TARGET));
  const selected = [];
  for (let i = 0; i < files.length; i += step) {
    selected.push({ file: files[i], timeSec: i * 2 });
    if (selected.length >= TARGET) break;
  }
  console.log(`Enviando ${selected.length} frames a Claude Sonnet (análisis profundo)...\n`);

  const content = [];
  for (const { file, timeSec } of selected) {
    const data = readFileSync(resolve(framesDir, file)).toString('base64');
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    content.push({ type: 'text', text: `↑ t≈${timeSec}s` });
  }
  content.push({
    type: 'text',
    text: `\n\nAnalizá los ${selected.length} frames con el framework completo. Output JSON estructurado.`,
  });

  const t0 = Date.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!resp.ok) {
    console.error('API error ' + resp.status + ': ' + (await resp.text()).slice(0, 400));
    process.exit(1);
  }
  const json = await resp.json();
  const raw = json.content?.[0]?.text ?? '';
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    const fb = cleaned.indexOf('{');
    const lb = cleaned.lastIndexOf('}');
    if (fb >= 0 && lb > fb) cleaned = cleaned.slice(fb, lb + 1);
  }
  const parsed = JSON.parse(cleaned);

  const outPath = resolve(__dirname, '..', 'storage', 'probe', 'soomi-deep-analysis.json');
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf-8');

  console.log('=== ANÁLISIS PROFUNDO SOOMI ===\n');
  console.log('Story arc: ' + parsed.overallStoryArc + '\n');
  console.log('Viveness key factors:');
  for (const f of parsed.vivenessKeyFactors || []) console.log('  • ' + f);
  console.log('');
  console.log('Tipos de motion recomendados (' + (parsed.sceneAnimationRecommendations?.length || 0) + ' escenas):');
  for (const s of (parsed.sceneAnimationRecommendations || []).slice(0, 5)) {
    console.log(`  • [${s.shotType}] t=${s.approxTimeSec}s · ${s.narrativeBeat}: ${s.motionType.slice(0, 100)}`);
  }
  console.log('');
  console.log('Anti-pattern rules:');
  for (const r of (parsed.antiPatternRulesToEnforce || []).slice(0, 8)) console.log('  • ' + r);
  console.log('');
  console.log('Improved motion template:');
  console.log('  ' + (parsed.improvedMotionPromptTemplate?.slice(0, 250) || '?'));
  console.log('');
  console.log('Tiempo: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('Tokens: ' + JSON.stringify(json.usage));
  console.log('JSON completo: ' + outPath);
  process.exit(0);
})().catch((e) => {
  console.error('Falló:', e.message);
  process.exit(1);
});
