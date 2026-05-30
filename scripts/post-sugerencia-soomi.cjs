// scripts/post-sugerencia-soomi.cjs
// Posta una sugerencia formal con el aprendizaje destilado de los 2 scripts
// de producción que el owner compartió (Soomi EsoRepair Pixar Full,
// herramienta de su amigo).
//
// Esto guarda el aprendizaje en storage/sugerencias/{timestamp}-{shortId}.json
// vía POST /api/sugerencias — NO toca código, sólo deposita un record para
// que el owner lo revise cuando quiera priorizar features.

const http = require('node:http');

const body = JSON.stringify({
  title:
    'Importar disciplina de plantillas del especialista Pixar (scripts Soomi EsoRepair)',
  category: 'improvement',
  author: 'owner+claude (analysis)',
  contextPath:
    'packages/presets/, packages/contracts/src/preset.schema.ts, packages/blocks/scene-animator-kling/, packages/blocks/compositor-remotion/',
  description: [
    '## Origen',
    'El owner compartió 2 scripts de producción de un especialista externo (herramienta del amigo), ambos del mismo producto Soomi EsoRepair en estilo Pixar 3D B-ROLL: uno de 46s/21 clips y otro de 114s/50 clips. Workflow externo: Nano Banana Pro (start frames) → Kling 3.0 (animación) → CapCut (sync VO+subs) → Canva (CTA overlays).',
    '',
    '## Patrones que nos faltan y deberíamos incorporar',
    '',
    '### ALTO valor',
    '1. styleBoilerplate + forbiddenStyleTerms como campos formales del preset. Cada prompt del especialista empieza con la MISMA línea de estilo (\"Pixar 3D animation style, premium Pixar quality, NOT claymation, NOT realistic, NOT vintage cartoon, vertical 9:16\"). Nosotros lo tenemos disperso entre promptTemplate y negativePrompt; formalizarlo evita olvidos.',
    '2. animationPromptTemplate de \"tres capas simultáneas\". El especialista invariablemente termina el prompt de Kling con: \"Three layers: {accion fisica} + {interno emocional/anatomico} + camera {move}\". Evita videos estaticos o caoticos. Nuestro scene-animator deberia enforzarlo (validacion + auto-completion).',
    '3. Character sheet multi-estado. Para narrativas de evolucion temporal (3 semanas, antes/durante/despues), un personaje con 3 versiones: STRUGGLING / TRYING / RESTORED. Hoy nuestro style-trainer genera UNA version. Schema sugerido: character.states[] con keys nombradas.',
    '4. Anti-replication boilerplate auto-inyectado. Cuando attachas char sheet, Nano Banana copia la composicion neutral. Solucion del especialista: prefijo \"use reference ONLY for facial identity — DO NOT replicate composition\". Auto-injectar en cada prompt con referenceImages.length > 0.',
    '5. Hook bombardeo (feature nueva). Los 2s iniciales de un ad largo (>60s) = recorte de 5 frames clave del propio video (0.4s c/u). Tecnica de retencion. Bandera al lanzar: enableHookBombardeo: true. El compositor extrae frames de clips marcados \"hookHighlight\" y los pre-pendea.',
    '6. \"Generar de mas y trimar\" para Kling. Kling genera duraciones discretas (3s, 5s). Para un clip de 2s pides 3s y trimas. VERIFICAR si nuestro scene-animator lo hace — si no, clips cortos pueden venir alargados o fallar.',
    '',
    '### MEDIO valor',
    '7. Reglas locked del preset: maxClipSeconds (3), useKlingEndFrame (false), renderInPostText (true=texto solo en post). Hoy son convenciones implicitas.',
    '8. Paleta de entidades named. Las 5 moleculas del producto tienen 5 colores fijos (zinc=silver-blue, DGL=amber-gold, etc) consistentes entre TODOS los ads del producto. Mapear como brand.namedEntities[] auto-inyectados al prompt cuando se mencionen.',
    '9. Phase tagging del scene-plan: hook|mechanism|resolution|cta. Util para hook bombardeo (extraer de fase \"hook\"), reportes y aprendizaje.',
    '10. Beats acelerados al final. Los CTAs finales son 1s (\"Confia en mi\", \"Enlace abajo\"). Patron de urgencia. Scene-planner deberia conocerlo cuando preset es b-roll-animado + funnelStage=bofu.',
    '',
    '### Nice to have',
    '11. Export tabla de clips (Clip / Inicio / Fin / Dur / VO) en CSV/MD desde /runs/{id}. Contrato humano-legible para auditoria.',
    '12. UI affordance: sugerir hook bombardeo cuando duracion estimada > 60s.',
    '',
    '## Donde NOSOTROS ya estamos mejor',
    '- Formatos: ellos solo Pixar B-ROLL; nosotros 4 categorias x sub-formatos.',
    '- Modos: ellos solo crear manual; nosotros crear/ripear/aprender.',
    '- Pipeline: ellos manual entre 4 tools; nosotros single pipeline programable.',
    '- Multi-provider con fallback: ellos lockeados a NB+Kling; nosotros cascada de 6 con fix recien aplicado.',
    '- Editor de composicion: ellos CapCut externo; nosotros canvas nativo /runs/{id}/editor.',
    '',
    'Conclusion: ellos tienen plantillas humanas afiladas para UN ad; nosotros tenemos infraestructura programable para muchos, pero plantillas mas debiles. La oportunidad es importar su disciplina a nuestra estructura.',
    '',
    '## Acciones propuestas (orden de impacto)',
    'A. (Sin codigo) Esta sugerencia — registro del aprendizaje.',
    'B. (Pequeno cambio aditivo) Agregar styleBoilerplate, forbiddenStyleTerms, animationLayers al preset schema. Backfill learned-vitaly con valores derivados.',
    'C. (Feature nueva — backlog) Hook bombardeo + multi-state character sheet. Plan propio porque tocan compositor + scene-planner + brand schema.',
    '',
    'Files de origen: C:\\Users\\cmktc\\Downloads\\Soomi_EsoRepair_*.txt (2 archivos).',
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
