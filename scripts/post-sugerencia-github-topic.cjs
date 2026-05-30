// scripts/post-sugerencia-github-topic.cjs
// Posta una sugerencia formal con las 4 ideas accionables destiladas del
// research del topic GitHub `video-generator` (reporte completo en
// investigacion/13-github-video-generator-topic.md).
//
// Aprovecha el mismo endpoint que usamos para la sugerencia Soomi.

const http = require('node:http');

const body = JSON.stringify({
  title:
    '4 ideas accionables del topic GitHub video-generator (BigBanana, autoclip, seedance-prompts, OpenMontage)',
  category: 'improvement',
  author: 'owner+claude (research)',
  contextPath:
    'investigacion/13-github-video-generator-topic.md, packages/blocks/image-gen-multi/, packages/blocks/scene-animator-kling/, packages/blocks/scene-planner/, packages/blocks/compositor-remotion/, packages/contracts/src/preset.schema.ts',
  description: [
    'Research del topic GitHub video-generator (+ vecinos). 11 repos, 4 con aprendizaje directo a oportunidades del backlog. Reporte completo: investigacion/13-github-video-generator-topic.md',
    '',
    'IDEA 1 - HALLAZGO PRIORITARIO. Character sheets multi-state. Repos: BigBanana-AI-Director (1.3k) + Phantom (1.5k). BigBanana tiene fase 02 dedicada a consistency assets: genera makeup photos del personaje + biblioteca de props, todas las generaciones posteriores se condicionan contra esa biblioteca. Produce video por keyframe interpolation (start frame + end frame -> Veo interpola). Resuelve casi llave-en-mano los ads tipo 3 semanas / antes-durante-despues. Plan: leer fase 02 BigBanana, implementar 3 ref-images en style-trainer.ts (STRUGGLING/TRYING/RESTORED), condicionar Nano Banana con multi-ref.',
    '',
    'IDEA 2. Hook bombardeo automatico con scoring LLM. Repo: autoclip (5.4k). Pipeline outline -> timeline -> highlight scoring -> title gen. En vez de elegir a ojo los 5 frames clave del bombardeo de 2s, scorear con Gemini multimodal y tomar top-5 picos. Decision auditable. Plan: nuevo block scene-highlight-scorer.ts que pida a Gemini score 1-10 por escena segun retention potential. Compositor extrae frames de top-5 si duracion > 60s.',
    '',
    'IDEA 3. Two-pass prompting para image-to-video. Repos: awesome-seedance-2-prompts (1.2k) + Seedance2-skill (70). Corpus 2000+ prompts con estructura [STYLE]+[CHARACTER]+[SCENE]+[SHOTS time-coded]+[CAMERA]+[TECHNICAL] y secuencias time-coded (0-4s, 4-9s, 9-15s). Seedance2-skill: four-gate creative review (memorability/surprise/emotional arc/narrative variation) que itera prompt hasta pasar gate. Plan: extender scene-animator-kling con buildAnimationPrompt() que sigue corpus structure + validateAnimationPrompt() con 4 gates. Robar reference.md de terminos cinematograficos para defaultCameraMoves.',
    '',
    'IDEA 4 - BONUS arquitectonico. Scorer provider selection 7-D. Repo: OpenMontage (3.9k). Sistema agentico con score engine de 7 dimensiones: task-fit, quality, control, reliability, cost, latency, continuity. Nuestra cascada de 6 providers hoy es binaria quota-OK/no-OK. El scorer 7-D da: decisiones auditables, continuity (priorizar el provider del scene anterior), cost-awareness (barato en no-criticas, quality en hero). Plan: agregar ProviderScore a image-gen-multi. Decision-log persistido en runs/{id}/decision-log.jsonl.',
    '',
    'DONDE YA ESTAMOS MEJOR: Modo Ripear (ningun repo lo hace), Modo Aprender (nadie tiene loop preset-discovery), editor canvas nativo, cascada con fallback formalizada.',
    '',
    'TOP 3 TAKEAWAYS: (1) character sheets ya - max impacto/esfuerzo. (2) scorer 7-D - aditivo sobre quota-detection + Bottleneck actuales. (3) Two-pass prompting - reemplaza Three layers por algo testeable.',
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
