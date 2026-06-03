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
      'Regla crítica del owner. El chat tiene un normalizador, pero los prompts deben estar limpios en origen.',
    fuente: 'CLAUDE.md; apps/web/lib/claude-chat-discuss.ts (normalizeNeutralSpanish)',
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
    titulo: 'Personas = ruta UGC (video real en escena), NUNCA animar foto sobre verde',
    regla:
      'Las PERSONAS de un ad se generan por la RUTA UGC: un video real en una escena real (ej. Veo/Higgsfield image-to-video desde una imagen de escena real, estilo selfie). NUNCA animar una foto/headshot estático sobre fondo verde: eso produce "una persona que solo se mueve" (defecto tipo HeyGen talking_photo), no UGC creíble. El recorte/PiP se resuelve DESPUÉS y aparte (matting IA o caja PiP). NUNCA dejar que la necesidad de edición (recortar) fuerce la generación (ej. generar sobre verde): primero la persona bien, el recorte después.',
    porQue:
      'jun-2026: generar al médico como retrato sobre verde y animarlo salía rígido/falso; generarlo como UGC real en su consulta (Veo) lo dejó creíble. El error de raíz fue dejar que el recorte mandara sobre la generación.',
    fuente: 'docs/analisis_videos_ugc.md; investigacion/RUTA-IGUALAR-ESTILO.md; apps/web/lib/scene-animator.ts (routing UGC); route-profiles.ts',
  },
  {
    id: 'lipsync-voz-nativa',
    categoria: 'producto',
    titulo: 'Lipsync = voz NATIVA del clip + escenas cortas (no superponer TTS)',
    regla:
      'El lipsync debe venir de la VOZ NATIVA del clip generado (el modelo genera voz y labios juntos, ej. Seedance audio-driven o Veo con diálogo) y se usa ESE audio. NO superponer un TTS aparte sobre un video muteado: patina (desfase entre audio y labios). Además, escenas CORTAS = mejor lipsync (los modelos se confunden en clips largos): trocear los segmentos largos.',
    porQue:
      'jun-2026: al montar el TTS encima de los clips el lipsync no calzaba. La voz nativa del clip (sincronizada a sí misma) + clips cortos resuelve.',
    fuente: 'apps/web/lib/scene-animator.ts; compositor (audioSrc); Seedance/Veo audio',
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
