// system-context.ts — M9 Pieza 1: snapshot completo del proyecto que se
// inyecta como SYSTEM PROMPT en cada llamada a Claude (M2/M5/M6/M7/M8).
//
// La idea: en lugar de hardcodear arquitectura+roles+contexto en CADA llamada,
// hay UNA función central `buildSystemContext()` que arma todo el conocimiento
// del proyecto (brands disponibles, presets, providers, decisiones recientes,
// runs últimos, capa IA actual). El caller la invoca y obtiene un string ya
// formateado para prepend al system prompt específico de cada rol.
//
// Eso garantiza:
//   1. Claude SIEMPRE tiene el mismo nivel de contexto del proyecto
//   2. Cuando cambia algo (preset nuevo, decisión, etc.), Claude lo sabe sin
//      que el caller tenga que actualizarse
//   3. Auditoría: el log de decisiones (system-log.jsonl) se incluye
//
// Caché: el context se rebuild cada vez (no cacheamos) porque el log y los
// presets pueden cambiar entre llamadas. Costo: ~10-20ms por call.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { formatRecentEventsForContext } from './system-log';
import {
  getPresetConfidenceScores,
  formatPresetConfidenceForContext,
} from '@video-factory/core';

interface BrandSummary {
  id: string;
  displayName: string;
  productCount: number;
  hasLogo: boolean;
  defaultLanguage?: string;
}

interface PresetSummary {
  id: string;
  displayName: string;
  formatId?: string;
  styleId?: string;
  visualEngine: string;
  estrategia: string;
  status: 'active' | 'pending';
}

interface RecentRun {
  id: string;
  status: string;
  presetId: string | null;
  brandId: string | null;
  estimatedCostUsd: number;
  startedAt: Date | string;
}

export interface SystemContext {
  // Identidad
  projectName: string;
  projectDescription: string;

  // Modos operativos
  modes: Array<{ id: string; name: string; description: string }>;

  // Capa de IA (M1-M8)
  iaLayers: Array<{
    id: string;
    name: string;
    purpose: string;
    location: string;
  }>;

  // Recursos disponibles
  brands: BrandSummary[];
  presets: { active: PresetSummary[]; pending: PresetSummary[] };

  // Providers configurados
  imageProviders: string[];
  animationProviders: string[];
  ttsProviders: string[];

  // Recent activity
  recentEventsFormatted: string; // ya formateado para el prompt
  recentRuns?: RecentRun[];

  // Feedback loop de aprobación humana (M7 #3): ranking de presets por
  // confidence acumulada de juicios pasados. Vacío si nadie aprobó/usó nada todavía.
  presetConfidenceFormatted: string;

  // Decisiones de diseño actuales
  designDecisions: string[];
}

/**
 * Encuentra el root del repo desde el cwd actual (apps/web o root).
 */
function findRepoRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..', '..'),
    process.env['VIDEO_FACTORY_ROOT'],
  ].filter((p): p is string => !!p);

  for (const c of candidates) {
    if (existsSync(resolve(c, 'packages', 'brands')) && existsSync(resolve(c, 'packages', 'presets'))) {
      return c;
    }
  }
  return process.cwd();
}

async function listBrands(repoRoot: string): Promise<BrandSummary[]> {
  const dir = resolve(repoRoot, 'packages', 'brands');
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    const brands: BrandSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.brand.json')) continue;
      try {
        const raw = await readFile(resolve(dir, f), 'utf-8');
        const j = JSON.parse(raw) as {
          id?: string;
          displayName?: string;
          products?: unknown[];
          logoPath?: string;
          defaultLanguage?: string;
        };
        if (j.id) {
          brands.push({
            id: j.id,
            displayName: j.displayName ?? j.id,
            productCount: Array.isArray(j.products) ? j.products.length : 0,
            hasLogo: !!j.logoPath,
            defaultLanguage: j.defaultLanguage,
          });
        }
      } catch {
        // skip brand corrupto
      }
    }
    return brands;
  } catch {
    return [];
  }
}

async function listPresets(repoRoot: string): Promise<{
  active: PresetSummary[];
  pending: PresetSummary[];
}> {
  const result = { active: [] as PresetSummary[], pending: [] as PresetSummary[] };
  for (const status of ['active', 'pending'] as const) {
    const dir =
      status === 'active'
        ? resolve(repoRoot, 'packages', 'presets')
        : resolve(repoRoot, 'packages', 'presets', 'pending');
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith('.preset.json')) continue;
        try {
          const raw = await readFile(resolve(dir, f), 'utf-8');
          const j = JSON.parse(raw) as {
            id?: string;
            displayName?: string;
            format?: { id?: string };
            style?: { id?: string };
            visualEngine?: string;
            estrategia?: string;
          };
          if (j.id) {
            result[status].push({
              id: j.id,
              displayName: j.displayName ?? j.id,
              formatId: j.format?.id,
              styleId: j.style?.id,
              visualEngine: j.visualEngine ?? 'unknown',
              estrategia: j.estrategia ?? 'unknown',
              status,
            });
          }
        } catch {
          // skip preset corrupto
        }
      }
    } catch {
      // dir no accesible
    }
  }
  return result;
}

function detectProviders(): {
  image: string[];
  animation: string[];
  tts: string[];
} {
  const image: string[] = [];
  const animation: string[] = [];
  const tts: string[] = [];

  if (process.env['OPENAI_API_KEY']) image.push('openai:gpt-image-1');
  if (process.env['GOOGLE_AI_API_KEY']) {
    image.push('gemini:nano-banana');
    image.push('google:imagen4');
  }
  if (process.env['GCP_PROJECT_ID']) {
    image.push('vertex:imagen');
    animation.push('vertex:veo');
  }
  if (process.env['HIGGSFIELD_KEY_ID']) {
    image.push('higgsfield:flux-pro-kontext');
  }
  if (process.env['KLING_ACCESS_KEY']) animation.push('kling:v2-6');
  if (process.env['FAL_API_KEY']) image.push('fal:flux-pro');
  if (process.env['ELEVENLABS_API_KEY']) tts.push('elevenlabs');
  if (process.env['OPENAI_API_KEY']) tts.push('openai:tts-1');

  return { image, animation, tts };
}

const STATIC_PROJECT_INFO = {
  name: 'Video Factory',
  description:
    'Herramienta interna para generar ads verticales 9:16 (TikTok/Reels) para marcas D2C (Vitaly, Nelo). Stack: TypeScript monorepo · Next.js 14 · Remotion · Drizzle + libsql · pnpm workspaces.',
  modes: [
    {
      id: 'crear',
      name: 'Crear',
      description: 'script de texto → video generado escena por escena (TTS + imágenes IA + sin subs renderizados).',
    },
    {
      id: 'ripear',
      name: 'Ripear',
      description:
        'video de referencia → análisis multimodal con Claude (M7-A) → video adaptado al producto propio manteniendo estructura/estilo.',
    },
    {
      id: 'aprender',
      name: 'Aprender',
      description:
        'video → preset destilado (auto-learn-preset M7-B genera preset completo desde keyframes con Claude multimodal).',
    },
  ],
  iaLayers: [
    {
      id: 'M2',
      name: 'Claude judge per imagen',
      purpose: 'Valida cada imagen generada contra prompt + product context',
      location: 'packages/blocks/preview-judge/',
    },
    {
      id: 'M5',
      name: 'Post-render judge técnico',
      purpose: 'Valida video final: coverage, duración, subtítulos, sample visual',
      location: 'packages/blocks/post-render-judge/',
    },
    {
      id: 'M6 v2',
      name: 'Editor IA loop iterativo',
      purpose: 'Conversación iterativa con 6 acciones ejecutables (extend, trim, regenerate-scene, adjust-prompt, approve, manual-fix). Max 3 iter.',
      location: 'packages/blocks/post-render-judge/src/editor-loop.ts + apps/web/lib/regenerate-single-scene.ts',
    },
    {
      id: 'M7-A',
      name: 'video-understander',
      purpose: 'Claude multimodal mira keyframes y devuelve análisis estructurado del ad',
      location: 'apps/web/lib/video-understander.ts',
    },
    {
      id: 'M7-B',
      name: 'auto-learn-preset',
      purpose: 'Genera PresetConfig completo desde video en 1 pasada. Endpoint /api/training/[id]/auto-learn + UI en /aprendizaje/[id]',
      location: 'apps/web/lib/auto-learn-preset.ts',
    },
    {
      id: 'M8',
      name: 'ClaudeChatPanel reusable',
      purpose: 'Componente UI conversacional plugeado en 5 spots: /sugerencias, /create, /rip/[id], /runs/[id]/editor, /aprendizaje/[id]',
      location: 'apps/web/components/ClaudeChatPanel.tsx + apps/web/app/api/chat/discuss/route.ts',
    },
    {
      id: 'M9',
      name: 'System Context + Auto-Log',
      purpose: 'Inyecta contexto del proyecto en TODOS los Claude callers. Auto-loggea eventos a storage/system-log.jsonl',
      location: 'apps/web/lib/system-context.ts + apps/web/lib/system-log.ts',
    },
  ],
  designDecisions: [
    'Subtítulos auto-generados DESACTIVADOS desde 25-may-2026 — el owner los hace en post (Google STT no tomaba bien las letras).',
    'Fix duración: scene-planner ahora extiende última scene hasta cubrir audio (pipeline.ts B.4.1). Evita "video corta antes que audio termina".',
    'Bottleneck per-provider con tier paid: gemini reservoir 30 IPM, vertex concurrency 4, openai concurrency 10, etc.',
    'Editor IA bloquea entrega real (run=failed) cuando severity=block-shipping. NO entrega silently.',
    'M6 v2 loop iterativo con regenerate-scene executor REAL (regenera UNA scene + re-render compositor solo).',
    'Decisión owner: UGC y personas reales → Higgsfield (TODO routing); Pixar/acuarela/animados → Kling.',
    'Anthropic API key vive en .env raíz; next.config.mjs la sobreescribe siempre en process.env (env loader override).',
  ],
} as const;

/**
 * Arma el snapshot completo del sistema. Función pura — sin side effects.
 */
export async function buildSystemContext(): Promise<SystemContext> {
  const repoRoot = findRepoRoot();
  const [brands, presets, recentEventsFormatted, presetScores] = await Promise.all([
    listBrands(repoRoot),
    listPresets(repoRoot),
    formatRecentEventsForContext(12, 2000),
    getPresetConfidenceScores().catch(() => []),
  ]);
  const providers = detectProviders();
  const presetConfidenceFormatted = formatPresetConfidenceForContext(presetScores, 10);
  return {
    projectName: STATIC_PROJECT_INFO.name,
    projectDescription: STATIC_PROJECT_INFO.description,
    modes: [...STATIC_PROJECT_INFO.modes],
    iaLayers: [...STATIC_PROJECT_INFO.iaLayers],
    brands,
    presets,
    imageProviders: providers.image,
    animationProviders: providers.animation,
    ttsProviders: providers.tts,
    recentEventsFormatted,
    presetConfidenceFormatted,
    designDecisions: [...STATIC_PROJECT_INFO.designDecisions],
  };
}

/**
 * Formatea el SystemContext como texto plano para prepend al system prompt
 * de Claude. Diseñado para ser legible por el modelo y conciso (~1500-2500 chars).
 */
export function formatSystemContextForPrompt(ctx: SystemContext): string {
  const sections: string[] = [];

  sections.push(`# ${ctx.projectName}`);
  sections.push(ctx.projectDescription);
  sections.push('');

  sections.push('## Modos operativos');
  for (const m of ctx.modes) {
    sections.push(`- **${m.name}**: ${m.description}`);
  }
  sections.push('');

  sections.push(`## Capa de IA actual (${ctx.iaLayers.length} módulos)`);
  for (const layer of ctx.iaLayers) {
    sections.push(`- **${layer.id}** ${layer.name}: ${layer.purpose}`);
  }
  sections.push('');

  if (ctx.brands.length > 0) {
    sections.push(`## Brands (${ctx.brands.length})`);
    for (const b of ctx.brands) {
      sections.push(`- **${b.id}** (${b.displayName}) — ${b.productCount} productos${b.hasLogo ? ', con logo' : ''}`);
    }
    sections.push('');
  }

  sections.push(`## Presets disponibles (${ctx.presets.active.length} activos, ${ctx.presets.pending.length} pendientes)`);
  const allPresets = [...ctx.presets.active, ...ctx.presets.pending];
  // Limitar a 15 más relevantes para no inflar el prompt
  const presetsToShow = allPresets.slice(0, 15);
  for (const p of presetsToShow) {
    const status = p.status === 'pending' ? ' [pending]' : '';
    sections.push(`- ${p.id}${status} — ${p.formatId ?? '?'}/${p.styleId ?? '?'} (${p.estrategia}, ${p.visualEngine})`);
  }
  if (allPresets.length > 15) {
    sections.push(`(... ${allPresets.length - 15} más)`);
  }
  sections.push('');

  sections.push('## Providers configurados');
  sections.push(`- Imagen: ${ctx.imageProviders.join(', ') || 'ninguno'}`);
  sections.push(`- Animación: ${ctx.animationProviders.join(', ') || 'ninguno'}`);
  sections.push(`- TTS: ${ctx.ttsProviders.join(', ') || 'ninguno'}`);
  sections.push('');

  sections.push('## Decisiones de diseño vigentes');
  for (const d of ctx.designDecisions) {
    sections.push(`- ${d}`);
  }
  sections.push('');

  if (ctx.recentEventsFormatted && ctx.recentEventsFormatted !== '(Sin eventos recientes registrados)') {
    sections.push('## Eventos recientes del sistema (auto-loggeados)');
    sections.push(ctx.recentEventsFormatted);
    sections.push('');
  }

  // Preset confidence — datos reales de qué funciona en producción según juicios pasados
  if (ctx.presetConfidenceFormatted && ctx.presetConfidenceFormatted.trim().length > 0) {
    sections.push('## Preset confidence (M7 #3 — feedback loop)');
    sections.push(ctx.presetConfidenceFormatted);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Helper de conveniencia: arma y formatea en un solo call.
 */
export async function getSystemContextForPrompt(): Promise<string> {
  const ctx = await buildSystemContext();
  return formatSystemContextForPrompt(ctx);
}
