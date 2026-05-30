// auto-learn-preset.ts — M7 Pieza B v1
//
// "Auto-aprender preset desde un video": dado un .mp4, llama a video-understander
// (Claude multimodal) y CONSTRUYE un preset completo válido contra PresetConfigSchema,
// listo para usar en el pipeline de generación.
//
// v1: una sola pasada (entender → mapear → persistir). NO incluye loop iterativo
// de "generar test → comparar → ajustar" todavía (eso es v2 — más complejo, requiere
// invocar el pipeline desde código).
//
// El preset auto-aprendido queda en packages/presets/pending/learned-auto-{ts}.preset.json
// y se puede aprobar luego desde /admin (o promoverlo a active manualmente).

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CANONICAL_FORMATS, PresetConfigSchema, type PresetConfig } from '@video-factory/contracts';
import { understandVideo, type VideoUnderstanding } from './video-understander';
import { findFfmpegPath } from './ffmpeg-locator';
import { pickReferenceFrameIndex } from './image-gen-tools';
import { logSystemEvent } from './system-log';

const execFileAsync = promisify(execFile);

// Busca el directorio packages/presets/pending desde múltiples puntos de origen
// para que funcione tanto en Next.js runtime (cwd=apps/web) como en scripts
// standalone (cwd=root). Cae al primer path cuyo parent (packages/presets) exista.
function findPresetsPendingDir(): string {
  const candidates = [
    // Caso A: cwd es root del repo (script standalone tipo node scripts/X.cjs)
    resolve(process.cwd(), 'packages', 'presets', 'pending'),
    // Caso B: cwd es apps/web (Next.js dev/prod)
    resolve(process.cwd(), '..', '..', 'packages', 'presets', 'pending'),
    // Caso C: explícito si VIDEO_FACTORY_ROOT está seteado
    process.env['VIDEO_FACTORY_ROOT']
      ? resolve(process.env['VIDEO_FACTORY_ROOT'], 'packages', 'presets', 'pending')
      : null,
  ].filter((p): p is string => p !== null);

  for (const c of candidates) {
    const parentDir = resolve(c, '..'); // packages/presets
    if (existsSync(parentDir)) return c;
  }
  // Fallback al primero
  return candidates[0]!;
}

const PRESETS_PENDING_DIR = findPresetsPendingDir();

// === RUTA DE APRENDIZAJE (codificada): referencia representativa + densidad =====

/**
 * Downscalea un frame a 512px JPEG y lo devuelve como data-URI, para embeberlo en
 * preset.visualStyle.referenceImages (viaja con el JSON; la creación lo usa con
 * Nano Banana para anclar estilo + densidad). Si ffmpeg falla, devuelve null.
 */
async function frameToDataUri(framePath: string): Promise<string | null> {
  try {
    const ffmpeg = findFfmpegPath();
    const outPath = `${framePath}.ref512.jpg`;
    await execFileAsync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', framePath, '-vf', 'scale=512:-2', '-q:v', '5', outPath,
    ]);
    const buf = await readFile(outPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[auto-learn] frameToDataUri falló:', (e as Error).message.slice(0, 200));
    return null;
  }
}

/**
 * Si el estilo es DENSO, inyecta la densidad + los componentes recurrentes en el
 * promptTemplate, para que la generación NAZCA cargada (no minimalista). Esta es la
 * pieza de la ruta que evita aprender un estilo rico como si fuera simple.
 */
function enrichPromptWithDensity(
  basePrompt: string,
  density: VideoUnderstanding['compositionDensity'],
  keyComponents: string[],
): string {
  if (density !== 'dense' && density !== 'very-dense') return basePrompt;
  const comps =
    keyComponents.length > 0 ? ` featuring ${keyComponents.slice(0, 6).join(', ')}` : '';
  return `${basePrompt} DENSE, richly detailed, multi-component composition${comps} — many elements and characters per frame, layered depth, busy and full (NOT minimalist).`;
}

export interface AutoLearnOptions {
  videoPath: string;
  /** Nombre legible para el preset (ej. "Vitaly Skincare UGC"). Si se omite, se genera de styleId */
  displayNameOverride?: string;
  /** Owner/brand de referencia (informativo, NO requerido) */
  brandIdForContext?: string;
  /** Si true, también persiste el understanding.json al lado del preset. Default true. */
  persistUnderstanding?: boolean;
  /** Override del modelo Claude. Default 'claude-haiku-4-5'. */
  model?: string;
}

export interface AutoLearnResult {
  presetId: string;
  preset: PresetConfig;
  presetFilePath: string;
  understandingFilePath?: string;
  understanding: VideoUnderstanding;
  elapsedSec: number;
  modelUsed: string;
}

/**
 * Mapea el hookType del understanding al hookAngulo del PresetClassification.
 * El understanding tiene tipos más finos que el schema de preset, los agrupamos.
 */
function mapHookType(
  hookType: VideoUnderstanding['hookType'],
): 'objeciones' | 'curiosidad' | 'autoridad' | 'testimonio' | 'test_diagnostico' {
  switch (hookType) {
    case 'curiosity-gap':
    case 'question':
      return 'curiosidad';
    case 'bold-claim':
    case 'stat-shock':
      return 'autoridad';
    case 'story-open':
      return 'testimonio';
    case 'negative':
    case 'pattern-interrupt':
      return 'objeciones';
    default:
      return 'curiosidad';
  }
}

/**
 * Infiere la categoría narrativa a partir del personaje + suggested format.
 */
function inferCategory(u: VideoUnderstanding): {
  id: string;
  displayName: string;
  description: string;
} {
  if (u.character?.gender === 'female') {
    return {
      id: 'mujer_protagonista',
      displayName: 'Mujer protagonista',
      description: 'La narradora es una mujer que cuenta su propia historia.',
    };
  }
  if (u.character?.gender === 'male') {
    return {
      id: 'hombre_protagonista',
      displayName: 'Hombre protagonista',
      description: 'El narrador es un hombre.',
    };
  }
  if (u.suggestedPreset.format === 'ugc-testimony') {
    return {
      id: 'testimonio_real',
      displayName: 'Testimonio Real',
      description: 'Persona cuenta su experiencia con el producto.',
    };
  }
  return {
    id: 'voiceover_impersonal',
    displayName: 'Voz Over Impersonal',
    description: 'Narración sin protagonista identificable.',
  };
}

/**
 * Auto-aprende un preset completo desde un video original.
 * Workflow: understandVideo → mapear al schema → validar Zod → persistir JSON.
 */
export async function autoLearnPresetFromVideo(
  opts: AutoLearnOptions,
): Promise<AutoLearnResult> {
  // 1) Entender el video
  const u = await understandVideo({
    videoPath: opts.videoPath,
    model: opts.model,
  });

  // RUTA DE APRENDIZAJE (codificada): embeber una referencia REPRESENTATIVA (densa)
  // + enriquecer el prompt con la densidad. Es el corazón de "igualar el estilo
  // rápido": al crear, el pipeline usa esta referencia con Nano Banana (image-to-image)
  // y el prompt ya pide la densidad correcta → la escena nace con el estilo completo.
  let referenceImages: string[] = [];
  try {
    const framePaths = u.keyframes.map((k) => k.filePath);
    if (framePaths.length > 0) {
      const refIdx = await pickReferenceFrameIndex(framePaths);
      const refFrame = framePaths[refIdx] ?? framePaths[Math.floor(framePaths.length / 2)];
      if (refFrame) {
        const dataUri = await frameToDataUri(refFrame);
        if (dataUri) referenceImages = [dataUri];
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[auto-learn] embed referencia falló (sigo sin ella):', (e as Error).message.slice(0, 200));
  }
  const enrichedPromptTemplate = enrichPromptWithDensity(
    u.understanding.suggestedPreset.promptTemplate,
    u.understanding.compositionDensity,
    u.understanding.keyVisualComponents,
  );

  // 2) Construir PresetConfig completo desde el understanding
  const suggested = u.understanding.suggestedPreset;
  const formatCanonical = CANONICAL_FORMATS.find((f) => f.id === suggested.format);
  if (!formatCanonical) {
    throw new Error(
      `Format ${suggested.format} no está en CANONICAL_FORMATS. Schema desactualizado?`,
    );
  }

  const shortId = randomUUID().slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const presetId = `learned-auto-${shortId}`;
  const displayName =
    opts.displayNameOverride ??
    `🧠 Auto · ${u.understanding.styleId.replace(/-/g, ' ')}`;
  const description = `Preset auto-aprendido por Claude (${opts.model ?? 'haiku-4.5'}) desde un video. ${u.understanding.executiveSummary.slice(0, 300)}`;

  const category = inferCategory(u.understanding);

  const preset: PresetConfig = {
    id: presetId,
    displayName,
    description,
    category: {
      id: category.id,
      displayName: category.displayName,
      description: category.description,
    },
    format: {
      id: formatCanonical.id,
      displayName: formatCanonical.displayName,
      description: formatCanonical.description,
    },
    style: {
      id: u.understanding.styleId,
      displayName: u.understanding.styleId
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
    },
    classification: {
      formato:
        suggested.format === 'ugc-testimony' || suggested.format === 'ugc-broll'
          ? 'ugc'
          : suggested.format === 'vsl'
            ? 'storytelling'
            : 'educativo',
      hookAngulo: mapHookType(u.understanding.hookType),
      funnelStage: 'tofu',
      awareness: 'problem_aware',
    },
    estrategia: suggested.estrategia,
    visualEngine: suggested.visualEngine,
    visualStyle: {
      promptTemplate: enrichedPromptTemplate,
      negativePrompt: suggested.negativePrompt,
      aspectRatio: '9:16',
      // RUTA: referencia representativa embebida (data-URI) → la creación la usa con
      // Nano Banana para anclar estilo + densidad. Antes este array quedaba VACÍO.
      referenceImages,
      // M B aditivo: paleta como hint en styleBoilerplate (los hex codes ayudan
      // al image generator a mantener consistencia)
      styleBoilerplate: `${enrichedPromptTemplate.slice(0, 240)} Dominant palette: ${u.understanding.palette.join(', ')}.`,
      forbiddenStyleTerms:
        suggested.negativePrompt
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 2 && s.length < 30)
          .slice(0, 10) || undefined,
    },
    subtitles: {
      style: 'word_level_kinetic',
      font: 'Inter',
      fontSize: 64,
      color: '#FFFFFF',
      strokeColor: '#000000',
      strokeWidth: 4,
      highlightColor: u.understanding.palette[0] ?? '#FFE600',
      position: 'bottom',
      allCaps: false,
    },
    defaultDurationSeconds: suggested.defaultDurationSeconds,
    scenesPerMinute: suggested.scenesPerMinute,
    composition: {
      kenBurns: { enabled: false, zoomStart: 1, zoomEnd: 1, panX: 0, panY: 0 },
      backgroundMusic: { enabled: false, volumeDb: -20 },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 3) Validar contra Zod (defensa contra cambios de schema futuros)
  const validated = PresetConfigSchema.safeParse(preset);
  if (!validated.success) {
    throw new Error(
      `Preset auto-generado no pasa schema PresetConfigSchema: ${validated.error.message.slice(0, 600)}`,
    );
  }

  // 4) Persistir
  await mkdir(PRESETS_PENDING_DIR, { recursive: true });
  const presetFilePath = resolve(PRESETS_PENDING_DIR, `${presetId}.preset.json`);
  await writeFile(presetFilePath, JSON.stringify(validated.data, null, 2), 'utf-8');

  let understandingFilePath: string | undefined;
  if (opts.persistUnderstanding !== false) {
    understandingFilePath = resolve(
      PRESETS_PENDING_DIR,
      `${presetId}.understanding.json`,
    );
    await writeFile(
      understandingFilePath,
      JSON.stringify(u.understanding, null, 2),
      'utf-8',
    );
  }

  // M9: auto-log al system event log
  void logSystemEvent({
    kind: 'preset-created',
    data: {
      presetId,
      displayName: preset.displayName,
      format: suggested.format,
      style: u.understanding.styleId,
      visualEngine: suggested.visualEngine,
      hookType: u.understanding.hookType,
      sceneCount: u.understanding.scenes.length,
      videoPath: opts.videoPath,
      elapsedSec: Number(u.elapsedSec.toFixed(1)),
    },
    summary: `Preset auto-aprendido "${preset.displayName}" (${suggested.format}/${u.understanding.styleId}) desde video ${opts.videoPath.split(/[\\/]/).pop() ?? opts.videoPath}`,
  });

  return {
    presetId,
    preset: validated.data,
    presetFilePath,
    understandingFilePath,
    understanding: u.understanding,
    elapsedSec: u.elapsedSec,
    modelUsed: u.modelUsed,
  };
}
