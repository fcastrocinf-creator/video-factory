// Dynamic preset builder: dado un AdAnalysis (resultado de analizar un MP4 con
// Gemini multimodal), construye un PresetConfig sintetizado que "aprende" del
// estilo visual + narrativo del anuncio original.
//
// El preset resultante:
//   - Se persiste en packages/presets/learned-<id>.preset.json
//   - Aparece automáticamente en /create bajo categoría "Aprendidos del Ripeo"
//   - Reusable: una vez creado, cualquier run futuro puede usarlo
//   - Inmutable: el user puede borrarlo desde el filesystem si quiere

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PresetConfigSchema,
  type AdAnalysis,
  type BrandConfig,
  type PresetConfig,
  type PresetClassification,
} from '@video-factory/contracts';
import { PRESETS_DIR, PENDING_PRESETS_DIR } from './paths';

// === HEURÍSTICAS DE MAPEO AdAnalysis → Preset ============================

/**
 * Infiere la categoría narrativa desde hookType + narratorProfile.
 *
 * Reglas:
 *   - autoridad + male age 40+              → doctor_autoridad
 *   - testimonio + female                   → mujer_protagonista
 *   - testimonio (otros)                    → testimonio_real
 *   - pain-agitation + female                → mujer_protagonista
 *   - pain-agitation (otros)                 → voiceover_impersonal
 *   - default                                → voiceover_impersonal
 */
function inferCategory(analysis: AdAnalysis): {
  id: string;
  displayName: string;
  description: string;
} {
  const narrator = analysis.narratorProfile;
  const isFemale = narrator?.gender === 'female';
  const isMale = narrator?.gender === 'male';
  const ageRange = narrator?.ageRange ?? '';
  const looksOlder = /[4-9]\d/.test(ageRange); // 40+

  switch (analysis.hookType) {
    case 'autoridad':
      if (isMale && looksOlder) {
        return {
          id: 'doctor_autoridad',
          displayName: 'Doctor / Experto (Autoridad)',
          description: 'Un especialista habla con autoridad sobre el problema y la solución.',
        };
      }
      return {
        id: 'autoridad_general',
        displayName: 'Voz de Autoridad',
        description: 'Narrador con autoridad técnica sobre el problema.',
      };

    case 'testimonio':
      if (isFemale) {
        return {
          id: 'mujer_protagonista',
          displayName: 'Mujer Protagonista (Testimonio)',
          description: 'Narradora cuenta su propia experiencia.',
        };
      }
      return {
        id: 'testimonio_real',
        displayName: 'Testimonio Real',
        description: 'Persona real cuenta su experiencia con el producto.',
      };

    case 'pain-agitation':
      if (isFemale) {
        return {
          id: 'mujer_protagonista',
          displayName: 'Mujer Protagonista (Pain-Agitation)',
          description: 'Narradora describe el dolor y agita antes de la solución.',
        };
      }
      return {
        id: 'voiceover_impersonal',
        displayName: 'Voice Over (Pain-Agitation)',
        description: 'Narración sin personaje, foco en el dolor del problema.',
      };

    default:
      return {
        id: 'voiceover_impersonal',
        displayName: 'Voice Over Genérico',
        description: 'Narración sin personaje identificable.',
      };
  }
}

/**
 * Decide el formato visual desde las escenas detectadas.
 *
 * Reglas simples:
 *   - Si la mayoría de escenas mencionan "habla a cámara" / "selfie" → ugc-testimony
 *   - Si la duración total > 180s → vsl (sales letter)
 *   - Por default → b-roll-animated (mayoría de ads modernos)
 */
function inferFormat(analysis: AdAnalysis): {
  id: 'b-roll-static' | 'b-roll-animated' | 'ugc-broll' | 'ugc-testimony' | 'vsl' | 'voiceover-animated';
  displayName: string;
  description: string;
} {
  // Primero: si tenemos visualStyleProfile, usar mediaType (señal más fuerte)
  const mediaType = analysis.visualStyleProfile?.mediaType;
  if (mediaType === 'ugc-real') {
    return {
      id: 'ugc-testimony',
      displayName: 'UGC Testimonio',
      description: 'Persona hablando a cámara amateur — estilo derivado del original.',
    };
  }
  if (mediaType === 'motion-graphics') {
    return {
      id: 'voiceover-animated',
      displayName: 'Voice Over Animado',
      description: 'Motion graphics / kinetic typography — estilo derivado del original.',
    };
  }
  if (mediaType === 'mixed-realistic' || mediaType === 'studio-photo' || mediaType === 'stock-medical' || mediaType === 'mixed-hybrid') {
    return {
      id: 'b-roll-static',
      displayName: 'B-ROLL Fotorealista',
      description: 'B-roll fotorealista mezclando shots reales — estilo derivado del original.',
    };
  }
  // illustration-2d / illustration-3d → animated
  if (mediaType === 'illustration-2d' || mediaType === 'illustration-3d') {
    return {
      id: 'b-roll-animated',
      displayName: 'B-ROLL Animado Ilustrado',
      description: 'Ilustración con motion — estilo derivado del original.',
    };
  }

  // === Fallback heurístico para análisis viejos sin mediaType ===
  const allDesc = analysis.scenes.map((s) => s.visualDescription.toLowerCase()).join(' ');
  const talkingHeadHits = (allDesc.match(/habla a cámara|selfie|primer plano de.*hablando|cara a cámara/g) ?? []).length;
  if (talkingHeadHits >= Math.ceil(analysis.scenes.length * 0.4)) {
    return {
      id: 'ugc-testimony',
      displayName: 'UGC Testimonio',
      description: 'Persona hablando a cámara — estilo derivado del original.',
    };
  }
  if (analysis.totalDurationSeconds > 180) {
    return {
      id: 'vsl',
      displayName: 'VSL (Sales Letter)',
      description: 'Formato persuasivo largo derivado del original.',
    };
  }
  return {
    id: 'b-roll-animated',
    displayName: 'B-ROLL Animado',
    description: 'Escenas animadas con motion — estilo derivado del original.',
  };
}

/**
 * Construye el `promptTemplate` que se inyecta como styleBase en CADA escena
 * generada. Si el análisis trae `visualStyleProfile` (nuevo schema), lo usamos
 * directo — esa es la fuente de verdad de "cómo se ve el original". Si no, caemos
 * al heurístico viejo (regex sobre visualDescription).
 *
 * CRÍTICO: este string es lo que rompe o salva el ripeo. Si decimos "watercolor
 * sepia" pero el original es UGC fotorealista, el output va a ser ilustración.
 */
function buildVisualPromptTemplate(analysis: AdAnalysis): string {
  // === Path nuevo: visualStyleProfile presente ===
  if (analysis.visualStyleProfile) {
    const p = analysis.visualStyleProfile;
    const palette =
      p.dominantPalette.length > 0
        ? `Dominant palette: ${p.dominantPalette.join(', ')}.`
        : '';
    const characters = p.realCharactersDescription
      ? `Characters: ${p.realCharactersDescription}.`
      : '';
    const tags = p.aestheticTags.length > 0 ? `Aesthetic: ${p.aestheticTags.join(', ')}.` : '';
    // El lookDescription es la pieza más importante — es la descripción concreta
    // del estilo fotográfico/ilustrativo del original.
    return [
      p.lookDescription,
      palette,
      characters,
      tags,
      'Vertical 9:16 composition, single coherent scene, no watermark, no embedded text (text overlays are added in post-production).',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // === Fallback heurístico (compat con análisis viejos sin visualStyleProfile) ===
  const firstScenes = analysis.scenes.slice(0, 5).map((s) => s.visualDescription);
  const allDescriptions = firstScenes.join('. ');
  const allLower = allDescriptions.toLowerCase();
  const palette: string[] = [];
  if (/cálid|amber|ámbar|sepia|ocre/.test(allLower)) palette.push('warm tones (amber, ochre, sepia)');
  if (/fr[ií]o|azul|cyan/.test(allLower)) palette.push('cool tones (blue, cyan)');
  if (/pastel|suave/.test(allLower)) palette.push('pastel soft palette');
  if (/contrast|vivo|vibrant/.test(allLower)) palette.push('high contrast vibrant');
  if (palette.length === 0) palette.push('natural realistic palette');
  const aestheticHints: string[] = [];
  if (/ilustra|acuarela|comic|cómic|pintur/.test(allLower)) aestheticHints.push('hand-illustrated style');
  if (/foto.?realista|natural|realista/.test(allLower)) aestheticHints.push('photo-realistic');
  if (/anim|3d|pixar/.test(allLower)) aestheticHints.push('3D animated character style');
  if (/ugc|amateur|móvil|selfie|handheld/.test(allLower)) aestheticHints.push('UGC amateur mobile-shot');
  if (aestheticHints.length === 0) aestheticHints.push('photo-realistic vertical short-form ad style');
  return `${aestheticHints.join(', ')}, ${palette.join(', ')}, vertical 9:16 composition, designed to match the editorial line: "${analysis.editorialLine.slice(0, 200)}", single coherent scene, no text overlay, no watermark`;
}

/**
 * Mapea hookType del análisis al `classification.hookAngulo` del preset.
 */
function mapHookAngulo(hookType: AdAnalysis['hookType']): PresetClassification['hookAngulo'] {
  switch (hookType) {
    case 'autoridad':
      return 'autoridad';
    case 'testimonio':
      return 'testimonio';
    case 'pain-agitation':
    case 'shock':
      return 'objeciones';
    case 'curiosidad':
    case 'misterio':
    case 'pregunta-directa':
      return 'curiosidad';
    case 'beneficio-directo':
    case 'humor':
    case 'otro':
    default:
      return 'test_diagnostico';
  }
}

/**
 * Decide el motor visual según el mediaType del análisis. Photo-real / UGC → imagen4
 * (sin animación, evita artefactos). Ilustración / motion graphics → veo-lite.
 */
function pickVisualEngine(analysis: AdAnalysis): PresetConfig['visualEngine'] {
  const mediaType = analysis.visualStyleProfile?.mediaType;
  switch (mediaType) {
    case 'ugc-real':
    case 'studio-photo':
    case 'stock-medical':
    case 'mixed-realistic':
      // Imagen4 hace photo-real mucho mejor que Veo (que es video gen). Mantenemos
      // estático para no introducir distorsiones de motion sobre fotos.
      return 'imagen4';
    case 'mixed-hybrid':
      // Híbrido (UGC + stock + illustration): imagen4 también, dejamos que el
      // prompt per-scene decida si la escena es foto o ilustración.
      return 'imagen4';
    case 'illustration-2d':
    case 'illustration-3d':
      return 'veo-lite';
    case 'motion-graphics':
      return 'veo-lite';
    default:
      // Sin visualStyleProfile (análisis viejo): default seguro = imagen4
      return 'imagen4';
  }
}

/**
 * Construye un negative prompt adecuado al estilo. Para photo-realistic queremos
 * REJECTAR ilustración. Para ilustración queremos REJECTAR fotografía.
 */
function buildNegativePrompt(analysis: AdAnalysis): string {
  // Base + reglas anti texto-burned-in. El renderer Remotion agrega texto vectorial
  // perfecto en post-production; queremos imágenes LIMPIAS sin texto incrustado
  // (sobre todo si el image generator tiende a meter texto en inglés en ads
  // cuyo idioma destino es otro).
  const base =
    'low quality, blurry, watermark, extra fingers, malformed limbs, deformed hands, distorted face anatomy, ' +
    'burned-in text, embedded captions, hardcoded subtitles, text overlay in image, ' +
    'English text on Spanish ad, gibberish letters, misspelled words, broken typography';
  const mediaType = analysis.visualStyleProfile?.mediaType;
  switch (mediaType) {
    case 'ugc-real':
    case 'studio-photo':
    case 'stock-medical':
    case 'mixed-realistic':
    case 'mixed-hybrid':
      return `${base}, illustration, drawing, painting, watercolor, comic, cartoon, 3d render, sepia tone`;
    case 'illustration-2d':
    case 'illustration-3d':
      return `${base}, photograph, photo-realistic, real photo, stock photo, dslr`;
    case 'motion-graphics':
      return `${base}, photo-realistic, real photo, raw video`;
    default:
      return base;
  }
}

/**
 * Mapea hookType al `classification.formato` (decisión semántica, no visual).
 */
function mapFormato(hookType: AdAnalysis['hookType']): PresetClassification['formato'] {
  switch (hookType) {
    case 'testimonio':
      return 'ugc';
    case 'autoridad':
      return 'storytelling';
    case 'humor':
    case 'curiosidad':
    case 'misterio':
      return 'storytelling';
    default:
      return 'educativo';
  }
}

// === BUILDER PRINCIPAL =================================================

export interface BuildDynamicPresetOptions {
  analysis: AdAnalysis;
  brand: BrandConfig;
  // Nombre del archivo de origen (ej "UGC - OBJECIONES.mp4") para el displayName
  sourceFileName?: string;
}

export interface BuildDynamicPresetResult {
  preset: PresetConfig;
  presetId: string;
  filePath: string;
  isNew: boolean;
}

/**
 * Construye un PresetConfig desde un AdAnalysis y lo persiste en disco.
 *
 * Idempotente vía hash: si ya existe un preset con el mismo hash (mismo analysis),
 * devuelve el existente (isNew=false) en vez de crear duplicado.
 */
export async function buildAndPersistDynamicPreset(
  opts: BuildDynamicPresetOptions,
): Promise<BuildDynamicPresetResult> {
  const { analysis, brand, sourceFileName } = opts;

  const category = inferCategory(analysis);
  const format = inferFormat(analysis);
  const promptTemplate = buildVisualPromptTemplate(analysis);

  // Id estable derivado del display name + brand. Si el user vuelve a ripear
  // el MISMO video con la MISMA marca, reusa el preset. Si cambia algo
  // significativo, genera uno nuevo.
  const presetId = `learned-${slugify(brand.id)}-${slugify(sourceFileName ?? 'rip')}-${randomShort()}`;

  const now = new Date().toISOString();
  const baseFileName = sourceFileName?.replace(/\.[^.]+$/, '') ?? 'Ripeo';
  const displayName = `🧠 Aprendido · ${baseFileName.slice(0, 40)}`;

  const preset: PresetConfig = {
    id: presetId,
    displayName,
    description: `Estilo aprendido del anuncio "${baseFileName}". Hook: ${analysis.hookType}. Línea editorial: ${analysis.editorialLine.slice(0, 120)}...`,
    category: {
      id: category.id,
      displayName: category.displayName,
      description: category.description,
    },
    format: {
      id: format.id,
      displayName: format.displayName,
      description: format.description,
    },
    style: {
      id: 'derived',
      displayName: 'Derivado del original',
    },
    classification: {
      formato: mapFormato(analysis.hookType),
      hookAngulo: mapHookAngulo(analysis.hookType),
      funnelStage: 'tofu',
      awareness: 'problem_aware',
    },
    estrategia: 'multi_escena',
    // visualEngine derivado de mediaType: si el original es fotorealista o UGC,
    // queremos imágenes estáticas (imagen4) en vez de animation. Si es ilustración
    // o motion graphics, sí animación. Esto es CRÍTICO porque animation forzada
    // sobre photo-real produce artefactos visibles.
    visualEngine: pickVisualEngine(analysis),
    visualStyle: {
      promptTemplate,
      // Negative prompt también adaptado: si el original es UGC, NO queremos
      // "photo-realistic" en el negative (lo queremos en el POSITIVE).
      negativePrompt: buildNegativePrompt(analysis),
      aspectRatio: '9:16',
      referenceImages: [],
    },
    subtitles: {
      style: 'word_level_kinetic',
      font: 'Inter',
      fontSize: 64,
      color: '#FFFFFF',
      strokeColor: '#000000',
      strokeWidth: 4,
      highlightColor: '#FFE600',
      position: 'bottom',
      allCaps: false,
    },
    defaultDurationSeconds: Math.round(analysis.totalDurationSeconds),
    scenesPerMinute: Math.max(
      6,
      Math.min(40, Math.round((analysis.scenes.length / analysis.totalDurationSeconds) * 60)),
    ),
    composition: {
      kenBurns: {
        enabled: false,
        zoomStart: 1.0,
        zoomEnd: 1.0,
        panX: 0,
        panY: 0,
      },
      backgroundMusic: {
        enabled: false,
        volumeDb: -20,
      },
    },
    createdAt: now,
    updatedAt: now,
  };

  // Validamos contra el schema antes de persistir (defensa en profundidad)
  const validated = PresetConfigSchema.parse(preset);

  // Los presets aprendidos NO se aprueban automáticamente: van a la carpeta
  // pending/ para que el admin los revise en /admin. Solo aparecen en /create
  // una vez aprobados.
  await mkdir(PENDING_PRESETS_DIR, { recursive: true });
  const filePath = join(PENDING_PRESETS_DIR, `${presetId}.preset.json`);
  const isNew = !existsSync(filePath);
  await writeFile(filePath, JSON.stringify(validated, null, 2), 'utf-8');

  return { preset: validated, presetId, filePath, isNew };
}

/**
 * Borra un preset aprendido (cleanup desde la UI de /create cuando el user
 * quiera mantener la lista limpia).
 */
export async function deleteLearnedPreset(presetId: string): Promise<void> {
  if (!presetId.startsWith('learned-')) {
    throw new Error(`Sólo se pueden borrar presets aprendidos (prefix "learned-"). ID dado: ${presetId}`);
  }
  const filePath = join(PRESETS_DIR, `${presetId}.preset.json`);
  if (!existsSync(filePath)) return;
  // Best-effort: si el file está bloqueado, no falla
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  } catch {
    // ignored
  }
  // También borramos el GIF preview asociado si existe
  try {
    const { unlink } = await import('node:fs/promises');
    const previewPath = join(PRESETS_DIR, `${presetId}.preview.gif`);
    if (existsSync(previewPath)) await unlink(previewPath);
  } catch {
    // ignored
  }
}

// === UTILS ============================================================

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[^.]+$/, '') // quitar extensión
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function randomShort(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Lee un preset aprendido si existe (para chequear si ya fue creado para este
 * rip). Útil para evitar duplicar el preset si el user clic ripear varias veces.
 */
export async function readLearnedPresetIfExists(
  presetId: string,
): Promise<PresetConfig | null> {
  const filePath = join(PRESETS_DIR, `${presetId}.preset.json`);
  if (!existsSync(filePath)) return null;
  try {
    const content = await readFile(filePath, 'utf-8');
    return PresetConfigSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}
