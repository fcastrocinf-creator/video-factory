// scripts/post-sugerencia-routing-animator.cjs
// Registra regla operacional del owner (25-may-2026) para el scene-animator routing.

const http = require('node:http');

const body = JSON.stringify({
  title:
    'Regla de routing del scene-animator: Higgsfield para UGC/realistas, Kling para animados/B-ROLL',
  category: 'feature',
  author: 'owner (25-may-2026)',
  contextPath:
    'apps/web/lib/scene-animator.ts, packages/blocks/image-gen-imagen/src/higgsfield-provider.ts, packages/contracts/src/preset.schema.ts',
  description: [
    'Regla operacional del owner para el scene-animator (image-to-video):',
    '',
    'UGC + personas reales -> Higgsfield (DoP/Soul/Veo via Higgsfield API)',
    'Animados + B-ROLL (Pixar, acuarela, comic, etc) -> Kling',
    'Veo Vertex -> last-resort fallback (quota daily limitada)',
    '',
    '## Estado actual',
    '- Higgsfield integrado solo para image generation (image-gen-multi cascade).',
    '- scene-animator.ts solo tiene Kling primary + Veo fallback.',
    '- API Higgsfield SI soporta video (response shape menciona "video?" — investigar endpoint exacto).',
    '',
    '## Implementacion sugerida (1-2h)',
    '',
    '1. Extender higgsfield-provider.ts con metodo generateVideo({imageBase64, prompt, durationSeconds, aspectRatio}) que use el endpoint video de Higgsfield (DoP, Soul, o Veo segun catalog).',
    '',
    '2. Agregar HiggsfieldVideoClient como third option al scene-animator junto con Kling y Veo.',
    '',
    '3. Implementar routing por preset en animateScenes():',
    '   const isUGCorRealistic = preset.format?.id?.startsWith("ugc-") || /realista|fotorealista|real|ugc/i.test(preset.style?.id ?? "");',
    '   const primary = isUGCorRealistic ? "higgsfield" : "kling";',
    '   const fallback = isUGCorRealistic ? "kling" : "higgsfield";',
    '   const lastResort = "veo";',
    '',
    '4. Test con preset UGC (mujer_ugc_broll_lifestyle o testimonio_ugc_real) para validar que routing va a Higgsfield primary.',
    '',
    '## Justificacion (por que Higgsfield para UGC)',
    'Higgsfield DoP tiene cinematografia profesional realista superior a Kling para humanos reales (mejor anatomia, expresion facial, movimiento natural). Kling es mejor para estilos animados/dibujados (Pixar, acuarela, comic) donde la fisica realista no es prioridad.',
    '',
    'Aplica a presets: mujer_ugc_broll_lifestyle, testimonio_ugc_real, doctor_ugc_broll_handheld, voiceover_fotorealista, voiceover_broll_animado_realista, y futuros presets UGC/realistas.',
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
