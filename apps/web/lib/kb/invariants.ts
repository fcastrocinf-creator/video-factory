// invariants.ts — "Memoria viva del proyecto": registro de INVARIANTES, reglas
// duras y wirings no-obvios ("gotchas").
//
// Propósito: que CUALQUIER Claude (sesión nueva, post-compactación) y la IA
// in-app arranquen con la verdad ACTUAL del proyecto y NO re-descubran ni
// tropiecen (ej.: el feed de la KB ya pasa por el bridge M9 system-log → no
// duplicar). Se propaga por dos canales:
//   1. IA in-app: inyectada en system-context (cada llamada a Claude la ve).
//   2. Claude desarrollador: sincronizada a CLAUDE.md (auto-cargado por sesión)
//      vía scripts/sync-invariants.ts.
//
// Fuente de verdad: storage/kb/invariantes.jsonl (append-only; última por id gana).
// Si el store está vacío, se usa la semilla CORE_INVARIANTS (conocimiento ganado).

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KB_DIR } from './record';

const INVARIANTS_PATH = resolve(KB_DIR, 'invariantes.jsonl');
const SEED_TS = '2026-06-01T00:00:00.000Z';

export type InvariantCategoria =
  | 'idioma'
  | 'seguridad'
  | 'arquitectura'
  | 'wiring'
  | 'decision'
  | 'producto';

export interface Invariant {
  id: string;
  ts: string;
  categoria: InvariantCategoria;
  titulo: string;
  regla: string; // la regla, en imperativo
  porQue: string; // contexto / por qué existe (incl. el error que evita)
  fuente: string; // dónde vive en el código / quién la decidió
}

/** Semilla: el conocimiento duro ganado hasta hoy. Se usa si el store está vacío. */
export const CORE_INVARIANTS: Array<Omit<Invariant, 'ts'>> = [
  {
    id: 'idioma-neutro',
    categoria: 'idioma',
    titulo: 'Español neutro SIEMPRE',
    regla:
      'Toda salida (UI, chat, prompts, código, commits) en español neutro con "tú". PROHIBIDO el voseo argentino (sos/tenés/podés/hacé/mirá/decí/dale) y "acá" (usar "aquí").',
    porQue:
      'Regla crítica del owner. La normalización (toNeutralSpanish, en apps/web/lib/neutral-es.ts) se aplica al CHAT, al GUION del video (antes del TTS) y la COMPUERTA bloquea (critical) si queda voseo. Límite: los imperativos voseo homógrafos del pretérito (descubrí/salí/sentí sin -s) NO se corrigen solos sin contexto.',
    fuente:
      'CLAUDE.md; apps/web/lib/neutral-es.ts (toNeutralSpanish/detectVoseo, lista única compartida); apps/web/lib/pipeline.ts (normaliza el guion antes del TTS); apps/web/lib/kb/quality-gate.ts (guardián de voseo, bloqueante)',
  },
  {
    id: 'nada-auto-aplica',
    categoria: 'seguridad',
    titulo: 'Nada se auto-aplica',
    regla:
      'El sistema PROPONE; el owner aprueba. Ningún cambio de código/prompt/config se aplica sin consentimiento explícito.',
    porQue: 'Invariante de seguridad del owner. El Consejo/auditoría/evolución solo observan y proponen.',
    fuente: 'apps/web/lib/prompt-evolution.ts applyPatch (gated); kb/deep-audit.ts',
  },
  {
    id: 'kb-fed-by-system-log',
    categoria: 'wiring',
    titulo: 'La KB se alimenta vía el bridge M9 (system-log)',
    regla:
      'Los eventos de run (run-completed/failed, editor-ia-verdict, etc.) llegan a la KB SOLO vía logSystemEvent → systemEventToKb. NO agregues emisores paralelos a recordEvent para esos eventos: duplicarías.',
    porQue:
      'En jun-2026 casi se duplicó el feed creando un run-events.ts paralelo. El bridge ya existía y no estaba documentado de forma accesible.',
    fuente: 'apps/web/lib/system-log.ts (systemEventToKb); apps/web/lib/kb/record.ts',
  },
  {
    id: 'storage-unificado',
    categoria: 'arquitectura',
    titulo: 'Storage único en /storage',
    regla:
      'Todo el storage vive en <root>/storage vía VF_STORAGE_DIR (lo fuerza next.config.mjs). NO uses process.cwd() para rutas de storage.',
    porQue: 'Antes se partía entre apps/web/storage y /storage (split-brain).',
    fuente: 'apps/web/lib/paths.ts; next.config.mjs',
  },
  {
    id: 'env-root',
    categoria: 'arquitectura',
    titulo: 'El .env raíz es la única fuente de verdad',
    regla:
      'next.config.mjs carga TODO el .env raíz y SOBREESCRIBE process.env al arrancar. Vars nuevas: agrégalas al .env raíz (y .env.example).',
    porQue: 'Evita valores stale/vacíos (ANTHROPIC_API_KEY rompía el judge IA).',
    fuente: 'next.config.mjs',
  },
  {
    id: 'admin-gate',
    categoria: 'seguridad',
    titulo: 'Admin protegido por ADMIN_PASSWORD',
    regla:
      '/admin y /api/admin/* exigen cookie admin_auth (separada de app_auth). La clave vive en ADMIN_PASSWORD del .env.',
    porQue: 'El panel admin es solo para el owner.',
    fuente: 'apps/web/lib/auth.ts; apps/web/middleware.ts',
  },
  {
    id: 'no-push',
    categoria: 'decision',
    titulo: 'Nunca hacer git push sin que el owner lo pida',
    regla: 'Commits locales OK cuando el owner los pide; git push SOLO con orden explícita del owner.',
    porQue: 'Regla del owner.',
    fuente: 'owner',
  },
  {
    id: 'composicion-multicapa-existe',
    categoria: 'wiring',
    titulo: 'La composición multi-capa YA existe (no rebuildear)',
    regla:
      'Para overlays/PiP/recorte(chroma)/anotaciones usa CompositeElement + FreeformComposite/FreeformElement + el editor manual + rip-fidelity-aligner. EXTIÉNDELO; no crees un motor de composición paralelo.',
    porQue:
      'En jun-2026 casi se reconstruyó un compositor desde cero sin saber que FreeformComposite ya hacía multi-capa. El chroma key + anotaciones se fusionaron en FreeformElement.',
    fuente:
      'packages/contracts/src/scene.schema.ts (CompositeElement); packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (FreeformComposite)',
  },
  {
    id: 'chroma-cutout-despill',
    categoria: 'producto',
    titulo: 'Recorte por chroma: hay que hacer DESPILL, no solo keying',
    regla:
      'Al recortar un sujeto generado sobre verde, el green-spill (reflejo verde sobre bata/piel) lo vuelve translúcido si solo aplicas el filtro SVG (feColorMatrix no hace min/max para despill). Haz chroma+despill por píxel sobre el asset: gd = G − max(R,B); gd alto → transparente; gd medio → ramp de alfa + despill (G = max(R,B)). Genera el sujeto con luz neutra y fondo verde saturado para minimizar spill. Mide píxeles reales antes de fijar umbrales.',
    porQue:
      'En jun-2026 el demo de la médica salía fantasma/translúcida por green-spill en la bata; el fondo verde generado tenía gd~100 (no ~200), así que umbrales a ojo fallaban. El chroma+despill por píxel + buen prompt de fondo lo dejó impecable.',
    fuente:
      'packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (filtro chroma SVG, fallback); preproceso de cutout (System.Drawing chroma+despill → PNG transparente)',
  },
  {
    id: 'estilo-capcut-edicion',
    categoria: 'producto',
    titulo: 'Estilo CapCut: edición profunda (Copilot + automática) — el norte',
    regla:
      '"Estilo CapCut" es el MODO de edición profunda de VF, para CUALQUIER estilo de video (no solo autoridad/doctor). Funciona de dos formas sobre el MISMO timeline (CompositeElement + FreeformComposite): (1) CONVERSACIONAL vía el Copilot — el owner le dice qué editar ("pon el círculo en la papada cuando diga papada", "muévelo", "más grande") y el Copilot PROPONE cambios al timeline; (2) AUTOMÁTICO — los agentes (rip + auditor de formato) lo arman y corrigen comparando ORIGINAL vs RENDER. Render con Remotion. Cabezas que hablan (lip-sync) vía HeyGen. Multi-voz por hablante. Personalizable e iterativo; NADA se auto-aplica (el owner aprueba).',
    porQue:
      'Decisión del owner (jun-2026): tratar la edición profunda como un modo con nombre, copilot-driven + automático. NO usar editor externo: CapCut no tiene API real de render server-side; Shotstack/Creatomate solo duplican lo que Remotion ya hace.',
    fuente:
      'owner; apps/web/lib/kb/format-audit.ts (auditor comparativo); packages/blocks/compositor-remotion (FreeformComposite/CompositeElement); Copilot (apps/web/lib/claude-chat-discuss.ts)',
  },
  {
    id: 'video-chroma-alpha-webm',
    categoria: 'producto',
    titulo: 'Recorte de VIDEO: pre-keying a webm alpha + OffthreadVideo transparent',
    regla:
      'Para superponer un VIDEO recortado (ej. una figura de autoridad ANIMADA que habla), el filtro SVG url() sobre <OffthreadVideo> NO resuelve fiable en el render headless (sale negro). Y OffthreadVideo descarta el alpha por defecto (mostraría el fondo verde). Solución probada: (1) pre-procesa el clip a .webm con alpha REAL — extrae frames, keying+despill por frame (gd=G−max(R,B), keyer en C# por velocidad), y encodea con ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0; (2) renderiza con OffthreadVideo transparent. El ffmpeg recortado de Remotion NO trae el filtro chromakey, pero SÍ encoders con alpha (vp9/prores).',
    porQue:
      'jun-2026: el doctor animado (Kling) salía como mancha negra (filtro url) y luego como caja verde (alpha descartado). Pre-keying a webm alpha + transparent lo montó limpio. Habilita overlays de video que hablan en el formato "Estilo CapCut".',
    fuente:
      'packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (FreeformElement video: transparent); preproceso de cutout de video (frames → keyer C# → ffmpeg vp9 yuva420p)',
  },
  {
    id: 'deteccion-patrones-animacion',
    categoria: 'producto',
    titulo: 'Aprender un formato = detectar patrones de animación/movimiento (no solo keyframes)',
    regla:
      'Los ads MEZCLAN tramos ANIMADOS (el experto se mueve/habla; el usuario prueba el producto) y ESTÁTICOS (imágenes fijas), con distintos elementos moviéndose en distintos momentos. Al ripear/aprender un formato hay que DETECTARLO, no solo mirar keyframes estáticos (lo que hace hoy video-understander). Método: (a) muestreo temporal denso + frame-diff → motion% por tramo (alto=animado, bajo=estático) = mapa temporal; (b) visión multimodal para interpretar QUÉ/QUIÉN se mueve en cada tramo (experto, usuaria, producto, b-roll). Es un especialista del panel multi-agente que debe MEJORAR con el tiempo (más agentes detectan más y mejor). Reproducción: el motor YA soporta tramos animados (OffthreadVideo) + estáticos (Img) + timing por elemento; falta automatizar el mapeo detección→composición.',
    porQue:
      'jun-2026: el owner señaló que el análisis solo veía keyframes estáticos y NO el movimiento (qué tramo está animado, quién se mueve y cuándo). Hueco real de la capacidad de reconocimiento a pulir.',
    fuente:
      'apps/web/lib/video-understander.ts (keyframes → extender a motion); frame-diff (mapa de movimiento); apps/web/lib/kb/format-audit.ts (panel multi-agente — nuevo especialista de animación); packages/blocks/compositor-remotion (reproducción animado+estático+timing)',
  },
  {
    id: 'persona-ruta-ugc',
    categoria: 'producto',
    titulo: 'Personas = ruta UGC con soul_2 + VERIFICAR la cara (no alien), NUNCA animar foto sobre verde',
    regla:
      'Las PERSONAS de un ad se generan por la RUTA UGC: un video/foto real en escena real, estilo selfie. Para GENERAR la cara usar Higgsfield SOUL (soul_2) — da humanos creíbles con piel real (poros, textura, imperfecciones); los modelos genéricos (nano_banana, etc.) salen con look "AI liso / alien". Para mantener la MISMA persona (antes/después, identidad) pasar la imagen base como referencia (medias role image en soul_2, o reference-element para otros modelos). SIEMPRE VERIFICAR la cara con ojo crítico (¿parece humano real o alien/avejentado/grotesco?) ANTES de usarla o animarla — nunca asumir que "técnicamente funciona" = "se ve bien". Si una cara que habla en cámara sale fea/uncanny, mejor FOTO fija (o b-roll) + voz en off que un clip malo. NUNCA animar headshot sobre verde (defecto HeyGen). El recorte/PiP se resuelve DESPUÉS y aparte. Nota: el enhancer de soul_2 tiende a neutralizar la expresión (no fuerza sonrisa en la foto) → la sonrisa se logra al ANIMAR.',
    porQue:
      'jun-2026: (1) el médico sobre verde salía rígido; como UGC real (Veo) quedó creíble. (2) Un "después" generado con nano_banana desde una fuente fea salió "alien/avejentado" y el owner lo cortó en seco ("la imagen está horrible, no te das cuenta?"); soul_2 con el "antes" como referencia dio una persona REAL (misma mujer, deshinchada, sana). Lección doble: soul_2 para humanos UGC + VERIFICAR la cara antes de seguir (no confundir "funciona" con "se ve bien").',
    fuente: 'docs/analisis_videos_ugc.md; investigacion/RUTA-IGUALAR-ESTILO.md; apps/web/lib/scene-animator.ts (routing UGC); route-profiles.ts (perfil ugc-real); Higgsfield soul_2 (Soul 2.0) + reference-element para identidad',
  },
  {
    id: 'lipsync-voz-nativa',
    categoria: 'producto',
    titulo: 'Lipsync = voz NATIVA del MISMO modelo (Veo), NUNCA TTS de ElevenLabs encima',
    regla:
      'El lipsync de una cara que HABLA debe venir de la VOZ NATIVA del MISMO modelo que genera el video (genera voz y labios JUNTOS). Modelo correcto y PROBADO = Veo 3.1 (talking-head con diálogo nativo, vía el MCP de generación de Higgsfield): se le pasa la foto (start_image) + la LÍNEA hablada en el prompt y devuelve a la persona diciéndola con lipsync real. ⛔ NUNCA superpongas un TTS aparte (ElevenLabs) sobre el clip muteado: la boca no coincide con la voz ajena → la compuerta lo caza como "lipsync inexistente". ⛔ Seedance audio-driven NO sirve para lipsync (es reference-driven), y Higgsfield DoP NO genera voz (solo movimiento). La voz nativa EXIGE controlar la PRONUNCIACIÓN en el prompt (línea clara, ES neutro) + VERIFICAR OYENDO (transcribir; el modelo puede pronunciar mal, ej. "cara en chaqueta"). Para CONSISTENCIA de voz, usa clips del MISMO modelo para TODA la voz del personaje (hook + voz en off), no mezcles con ElevenLabs. Escenas CORTAS (Veo ≤8s) = mejor lipsync y ritmo. Montaje: el compositor MUTEA los <video>; el audio sale de la pista combinada (audio nativo EXTRAÍDO de los clips, concatenado) → el lipsync calza por construcción. Si aun así una cara hablando no se logra, alternativa robusta: b-roll (sin hablar) + voz en off.',
    porQue:
      'jun-2026 (ad del médico SuperCalm): generé el clip con Seedance y monté un TTS de ElevenLabs encima → la compuerta cazó "lipsync inexistente". El owner corrigió: "el problema es que usas el narrador de Eleven; tienes que hacerlo con el mismo higgsfield". Regenerar al médico con Veo 3.1 (voz nativa, la línea en el prompt) + extraer su audio para la pista → el lipsync dejó de ser bloqueante. Verificar oyendo es clave (Veo también puede pronunciar mal).',
    fuente: 'scripts/prep-key.ts (concat del audio nativo de los clips → combined-key.mp3); packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (FreeformElement video MUTED; audioSrc = combinado nativo); Veo 3.1 vía MCP de generación (talking-head con diálogo); scripts/transcribe-gemini.ts (verificar oyendo); render-quality-judge.ts (dimensión lipsync)',
  },
  {
    id: 'pip-persona-corte-posicion',
    categoria: 'producto',
    titulo: 'PiP/overlay de una persona = CLIP con movimiento (corte y posición), nunca foto fija',
    regla:
      'Cuando una persona aparece en un PiP/recuadro (ej. el médico "reaccionando" arriba mientras se ven los planos del usuario), o como hook de varios segundos, debe tener MOVIMIENTO: es un CLIP recortado y posicionado en el recuadro (edición de "CORTE Y POSICIÓN", estilo CapCut), NUNCA una foto fija. Una persona en foto fija (PiP o hook) se ve muerta/estática y el owner la RECHAZA (es la "persona que no se mueve" tipo HeyGen). Reutiliza el MISMO clip de la persona (el de su voz nativa) recortándolo/posicionándolo en el PiP; la voz nativa de ese clip sirve además como la voz en off de ese tramo. El compositor ya soporta video en FreeformElement (rect = corte y posición, muted).',
    porQue:
      'jun-2026: puse al médico como FOTO fija en el hook (10s) y en el PiP → la compuerta y el owner lo marcaron estático/muerto ("sigue teniendo errores, no puedes verlos?"). El owner: "el médico cuando está arriba tiene que tener movimiento, es una edición de corte y posición como habíamos hablado, apréndelo". Con el clip Veo recortado en el PiP dejó de ser estático.',
    fuente:
      'packages/blocks/compositor-remotion/src/proto-key.ts (medico-pip = video recortado); packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (FreeformElement video, rect = corte y posición); owner',
  },
  {
    id: 'anotaciones-ancladas-sincronizadas',
    categoria: 'producto',
    titulo: 'Anotaciones: ancladas a la zona + sincronizadas a la narración (nunca arbitrarias)',
    regla:
      'Los círculos/flechas de anotación deben (a) anclarse a la ZONA exacta del rasgo (cara/región, idealmente con detección de cara) y (b) aparecer SINCRONIZADOS al momento en que la narración menciona ese rasgo (ej. el círculo en ojeras/papada aparece cuando se dicen esas palabras). NUNCA poner anotaciones arbitrarias o sin relación con lo que se dice o se ve.',
    porQue:
      'jun-2026: el owner marcó que poner círculos rojos sin sentido (sin sincronía ni zona correcta) se ve "estúpido". La anotación solo aporta si tiene sentido temporal y espacial.',
    fuente: 'packages/blocks/compositor-remotion (kind annotation, startSeconds/endSeconds); pendiente: detección de cara para anclar la zona',
  },
  {
    id: 'sin-subtitulos-salvo-pedido',
    categoria: 'decision',
    titulo: 'No poner subtítulos salvo que el usuario los pida',
    regla:
      'NO agregar subtítulos/captions a un video salvo que el owner/usuario los pida EXPLÍCITAMENTE.',
    porQue: 'jun-2026: el owner rechazó subtítulos agregados sin pedirlos ("eso no te lo pedí, recuérdalo").',
    fuente: 'owner',
  },
  {
    id: 'usuaria-antes-hinchada-progresion',
    categoria: 'producto',
    titulo: 'Antes/después: "antes" = hinchada (no golpeada) + progresión de mejora',
    regla:
      'En ads de antes/después, la persona en el estado "antes" debe verse HINCHADA/inflamada (retención de líquido): mejillas y párpados hinchados, papada blanda, cara pesada; pero con tono de piel SANO y SIN moretones ni ojeras tipo golpe. Y debe MEJORAR progresivamente a lo largo del ad (antes → intermedio → después) a medida que usa el producto. Generar los estados como una progresión coherente de la MISMA persona.',
    porQue:
      'jun-2026: la usuaria salía "golpeada" (ojeras tipo moretón) en vez de hinchada; y el original muestra mejora progresiva con el uso del producto, que hay que reproducir.',
    fuente: 'docs/formato-supercalm-doctor-split.md; prompts de generación de la usuaria',
  },
  {
    id: 'validators-detectan-y-usuario-corrige',
    categoria: 'producto',
    titulo: 'Los validators detectan defectos y los proponen al usuario (autonomía)',
    regla:
      'Los validators (format-audit + jueces de imagen) deben CORRER sobre lo CREADO (no solo al aprender) y detectar solos: persona golpeada-vs-hinchada, lipsync flojo, PiP estático, producto ilegible, anotación desincronizada, recorte sucio, etc. Esos hallazgos se surfacean al usuario como RECOMENDACIONES aplicables en el editor y/o vía el Copilot. El objetivo es que la herramienta perfeccione el video SOLA (con aprobación del usuario), sin depender de que el owner corrija a mano.',
    porQue:
      'jun-2026: el owner exige que estos aprendizajes los aplique la herramienta sin depender de que hablemos; las correcciones deben recomendarse al usuario in-app.',
    fuente: 'apps/web/lib/kb/format-audit.ts; /admin Consejo; editor + apps/web/lib/claude-chat-discuss.ts (Copilot); pendiente: surfacear hallazgos en el editor',
  },
  {
    id: 'validacion-siempre-obligatoria',
    categoria: 'arquitectura',
    titulo: 'La validación de calidad corre SIEMPRE (no opt-in): un video no se declara listo sin validar',
    regla:
      'La compuerta que VE+OYE (Gemini: render-quality-judge + panel format-audit) corre de forma OBLIGATORIA al terminar CADA render — NO detrás de una flag opt-in (VF_GATE_ON_RENDER quedó ELIMINADO) ni fire-and-forget. Se ejecuta con AWAIT y useGemini:true, y el ESTADO FINAL del run DEPENDE de su veredicto: "completed" SOLO si pasó (pass); si dio fail/revisar o NO pudo validar (sin Gemini/cuota/error) → "completed-with-warnings" marcado "NO VERIFICADO" (fail-loud + fail-closed). JAMÁS se marca un video "listo" a ciegas. Un TEST GUARDIÁN (quality-gate-wiring.test.ts) lee el pipeline y ROMPE si alguien revierte esto (lo vuelve opt-in/fire-and-forget o desacopla el estado). El juez hace una AUDITORÍA FORENSE (transiciones/cortes, empalmes de audio, manos/anatomía, oclusiones, estabilidad de overlays, legibilidad) con timestamp, no solo dimensiones de alto nivel.',
    porQue:
      'jun-2026: el owner llevaba MUCHOS intentos de que la validación se usara SIEMPRE y nunca se mantenía, porque cada vez quedaba OPT-IN (flag apagada) + best-effort SILENCIOSO → un video se declaraba "listo" sin validar y nadie se enteraba. La grieta era el DISEÑO, no la capacidad. Se cierra: obligatoria + fail-loud + test guardián que impide desconectarla en silencio. El owner exigió "certeza absoluta de que después no será un problema".',
    fuente:
      'apps/web/lib/pipeline.ts (CANDADO: VALIDACIÓN OBLIGATORIA — await runQualityGate, finalStatus depende de gateVeredicto); apps/web/lib/render-quality-judge.ts (AUDITORÍA FORENSE); apps/web/lib/quality-gate-wiring.test.ts (guardián)',
  },
  {
    id: 'circulo-leer-actuar',
    categoria: 'producto',
    titulo: 'El círculo de mejora: DETECTA bien y ya ACTÚA (5-7 hechos); falta cerrar APRENDER (8)',
    regla:
      'Video Factory tiene un círculo de 8 pasos para perfeccionar videos. Los pasos 1-4 FUNCIONAN: LEER (Gemini ve+oye), ENTENDER (panel de 6 especialistas), DETECTAR, PROPONER el fix en la KB. Los pasos 5-7 YA están IMPLEMENTADOS (Fase 2 cerrada a nivel código): MOSTRAR el hallazgo en la UI (GateFindings en RunViewer + GET /api/runs/[id]/gate), APLICAR la corrección dirigida y REGENERAR solo la escena que falla — planRepairs (kb/repair-loop.ts) DECIDE la reparación de forma determinista y executeGateRepair (repair-executor.ts) la EJECUTA con OK del owner (POST /api/runs/[id]/gate/repair → forkea el run vía applyCorrection y regenera SOLO esa escena). Falta cerrar el paso 8: APRENDER para no repetir (el aprendizaje sigue siendo pasivo). El NORTE es CERRAR EL CÍRCULO: que la herramienta corrija sola (con OK del owner), no que el owner parche a mano. NO trabajar pieza-por-pieza en un proto manual; trabajar en que el SISTEMA lo haga.',
    porQue:
      'jun-2026: el owner señaló que yo no captaba la totalidad — estuve parchando un proto (proto-key.ts) a mano en vez de cerrar el círculo del sistema. El owner invirtió en percepción+detección; la ACCIÓN (mostrar/aplicar/regenerar dirigido) se construyó después (Fase 2, verificada a nivel código). Queda pendiente que el sistema APRENDA del resultado para no repetir.',
    fuente:
      'docs/PLAN-CIERRE-CIRCULO.md; apps/web/lib/kb/repair-loop.ts (planRepairs — decide); apps/web/lib/repair-executor.ts (executeGateRepair — ejecuta con OK del owner); apps/web/app/(app)/runs/[id]/GateFindings.tsx (surfacea en RunViewer); apps/web/lib/kb/findings.ts (fixPropuesto)',
  },
  {
    id: 'motor-soporta-vs-pipeline-emite',
    categoria: 'arquitectura',
    titulo: 'Capacidad del motor ≠ autonomía del pipeline (el motor SOPORTA, el pipeline no EMITE)',
    regla:
      'El motor de composición (Remotion/PlanoEscenas.tsx + scene.schema.ts) SOPORTA PiP, chroma/cutout, anotaciones con timing y multi-audio/multi-voz (el campo speakerId YA existe). PERO el pipeline automático (pipeline.ts) NO los EMITE: hoy genera escenas estáticas + 1 TTS único + animación cruda. Para automatizar un formato complejo hay que EXTENDER el pipeline para que EMITA esas composiciones (anotaciones sincronizadas vía word-sync, PiP, multi-voz por hablante), NO rebuildear el motor (que ya las aguanta).',
    porQue:
      'jun-2026: cada parche manual del proto SuperCalm (audio nativo, círculos sincronizados, antes/después) es una pieza que el motor soporta pero el pipeline no emite. Confundir "el motor puede" con "el sistema lo hace solo" llevó a trabajar a mano lo que falta automatizar.',
    fuente:
      'apps/web/lib/pipeline.ts (emite escenas + 1 TTS); packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx (soporta todo); packages/contracts/src/scene.schema.ts (speakerId, CompositeElement)',
  },
  {
    id: 'verificar-viendo-y-oyendo',
    categoria: 'producto',
    titulo: 'Verificar un render VIENDO y OYENDO (transcribir el audio), no solo frames',
    regla:
      'Al validar un video generado, no basta mirar los frames: hay que OÍR el audio (transcribirlo, ej. scripts/transcribe-gemini.ts) y leer la transcripción. La voz nativa de los clips generados puede decir frases mal pronunciadas o sin sentido. Verificar VISUAL + AUDIO antes de decir que algo está bien.',
    porQue:
      'jun-2026: validé el tramo SuperCalm mirando solo los frames y lo di por bueno, pero el clip del médico decía "la cara EN CHAQUETA" (debía ser hinchada), "mucha TENSIÓN" (debía ser retención) y "un EJERCICIO" (debía ser este caso). El owner lo oyó, yo no. Verificar solo lo visual no alcanza.',
    fuente: 'scripts/transcribe-gemini.ts; apps/web/lib/render-quality-judge.ts (Gemini OYE); owner',
  },
];

async function readRaw(): Promise<Invariant[]> {
  try {
    const raw = await readFile(INVARIANTS_PATH, 'utf-8');
    const byId = new Map<string, Invariant>();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const inv = JSON.parse(t) as Invariant;
        byId.set(inv.id, inv); // última ocurrencia gana
      } catch {
        // skip línea corrupta
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** Lista las invariantes. Si el store está vacío, devuelve la semilla CORE. */
export async function listInvariants(): Promise<Invariant[]> {
  const stored = await readRaw();
  const list = stored.length > 0 ? stored : CORE_INVARIANTS.map((c) => ({ ...c, ts: SEED_TS }));
  return list.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.titulo.localeCompare(b.titulo));
}

export interface AddInvariantInput {
  categoria: InvariantCategoria;
  titulo: string;
  regla: string;
  porQue?: string;
  fuente?: string;
}

/** Agrega (o actualiza por id) una invariante. Materializa la semilla la 1ra vez. */
export async function addInvariant(i: AddInvariantInput): Promise<Invariant> {
  const slug =
    i.titulo
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || `inv-${randomUUID().slice(0, 6)}`;
  const inv: Invariant = {
    id: slug,
    ts: new Date().toISOString(),
    categoria: i.categoria,
    titulo: i.titulo,
    regla: i.regla,
    porQue: i.porQue ?? '',
    fuente: i.fuente ?? 'owner',
  };
  try {
    await mkdir(KB_DIR, { recursive: true });
    // Si el store está vacío, materializamos la semilla para no perderla al filtrar.
    const stored = await readRaw();
    if (stored.length === 0) {
      for (const c of CORE_INVARIANTS) {
        await appendFile(INVARIANTS_PATH, JSON.stringify({ ...c, ts: SEED_TS }) + '\n', 'utf-8');
      }
    }
    await appendFile(INVARIANTS_PATH, JSON.stringify(inv) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
  return inv;
}

/** Texto compacto para inyectar en system prompts (IA in-app). */
export async function formatInvariantsForContext(maxChars = 1800): Promise<string> {
  const list = await listInvariants();
  if (list.length === 0) return '';
  const lines: string[] = [];
  let total = 0;
  for (const inv of list) {
    const line = `- [${inv.categoria}] ${inv.titulo}: ${inv.regla}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}

/** Markdown para sincronizar a CLAUDE.md (Claudes desarrolladores). */
export async function renderInvariantsMarkdown(): Promise<string> {
  const list = await listInvariants();
  return list
    .map(
      (inv) =>
        `- **${inv.titulo}** _(${inv.categoria})_ — ${inv.regla}` +
        (inv.porQue ? ` _Por qué:_ ${inv.porQue}` : '') +
        (inv.fuente ? ` _Fuente:_ \`${inv.fuente}\`` : ''),
    )
    .join('\n');
}
