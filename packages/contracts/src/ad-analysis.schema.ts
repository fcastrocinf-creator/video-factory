import { z } from 'zod';
import { NarratorProfileSchema } from './script.schema.js';

/**
 * Resultado del análisis multimodal de un anuncio cargado por el usuario.
 *
 * Producido por `ad-analyzer.ts` (Gemini 2.5 Pro multimodal). Lo usan después:
 *   - script-suggester: para proponer guiones similares manteniendo "línea editorial"
 *   - ad-ripper: para reproducir el anuncio adaptado al producto del usuario
 *
 * Pensado para creativos de 15-90s con narración voz-en-off. Si el anuncio
 * carece de narración, `fullNarration` puede ser string vacío.
 */
export const AdSceneAnalysisSchema = z.object({
  index: z.number().int().nonnegative(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  // Qué se ve EN PANTALLA durante la escena. Granular: personajes visibles,
  // ubicación, objetos, acciones, paleta. Ej: "primer plano de mujer 30s
  // sonriendo en cocina iluminada, sostiene un frasco ámbar con etiqueta amarilla".
  visualDescription: z.string(),
  // Qué se NARRA durante la escena (subset literal del fullNarration).
  // Puede ser string vacío si la escena es B-roll silencioso.
  narrationFragment: z.string(),
});

export type AdSceneAnalysis = z.infer<typeof AdSceneAnalysisSchema>;

export const AdProductAnalysisSchema = z.object({
  // Nombre del producto si aparece explícitamente (marca + producto). Null
  // cuando es un anuncio genérico de la categoría.
  name: z.string().nullable(),
  // Descripción del producto que se ve: forma, color, packaging, dimensiones.
  visualDescription: z.string().nullable(),
  // Beneficio principal o claim que el anuncio sostiene sobre el producto.
  mainClaim: z.string().nullable(),
  // Si parece ser un competidor del usuario (true) o no se identifica (false).
  isCompetitor: z.boolean().default(false),
});

export type AdProductAnalysis = z.infer<typeof AdProductAnalysisSchema>;

/**
 * Perfil VISUAL concreto del anuncio. Lo extrae el ad-analyzer mirando los frames
 * reales del video y describe el "look & feel" en términos accionables para los
 * generadores de imagen downstream (gpt-image-1, Imagen, Flux, etc.).
 *
 * CRÍTICO: estos campos son lo que distingue "ripeo fiel" de "ripeo genérico".
 * Sin esto, el preset construido por dynamic-preset-builder no captura si el
 * original es UGC fotorealista, infomercial vibrante, comic acuarela, motion
 * graphics, etc. — y termina forzando el estilo default del sistema.
 */
export const AdVisualStyleProfileSchema = z.object({
  // Tipo de medio dominante del anuncio. Determina la decisión más importante
  // del image-gen: ¿foto-realismo o ilustración?
  //   - 'ugc-real': cámara amateur, persona real hablando o haciendo algo
  //   - 'studio-photo': fotografía profesional (producto, lifestyle limpio)
  //   - 'stock-medical': footage médico/anatómico real (no ilustrado)
  //   - 'mixed-realistic': mezcla de UGC + stock + photo (TÍPICO en ads modernos)
  //   - 'illustration-2d': ilustración plana (comic, acuarela, vector)
  //   - 'illustration-3d': render 3D (Pixar, Blender, character animation)
  //   - 'motion-graphics': kinetic typography, animación abstracta, explainer
  //   - 'mixed-hybrid': real + ilustración intercalada (infomercials, "INSIDE YOUR FACE")
  mediaType: z.enum([
    'ugc-real',
    'studio-photo',
    'stock-medical',
    'mixed-realistic',
    'illustration-2d',
    'illustration-3d',
    'motion-graphics',
    'mixed-hybrid',
  ]),

  // Descripción del LOOK fotográfico/ilustrativo en 30-80 palabras, en INGLÉS
  // (para que los image generators la entiendan). Esta cadena se inyecta literal
  // en el promptTemplate del preset construido. Debe capturar:
  //   - Tipo de plano dominante (close-up, wide, handheld)
  //   - Iluminación (natural, key fuerte, ring light, golden hour)
  //   - Saturación y contraste
  //   - Estética concreta ("phone-shot vertical UGC", "medical encyclopedia illustration", "infomercial high-contrast")
  // Ejemplo bueno: "Vertical 9:16 amateur smartphone footage, handheld selfie style,
  // natural indoor lighting, slightly underexposed, real woman 30-45 talking to camera,
  // unfiltered skin texture, casual home setting."
  lookDescription: z.string(),

  // Paleta hex dominante extraída de los frames (3-6 colores). Ayuda al
  // generator a respetar la atmósfera cromática del original.
  dominantPalette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),

  // Si el anuncio usa overlays de texto sobre las escenas (típico en TikTok/Reels
  // ads), describir el estilo. Si NO hay overlays, null.
  textOverlayStyle: z
    .object({
      // Caja de color sólido detrás (típico TikTok "verde fluor"), gradient,
      // outline, plain. Si NO hay caja, null.
      backgroundStyle: z
        .enum(['solid-box', 'gradient', 'outline-only', 'plain', 'shadow'])
        .nullable()
        .default(null),
      // Color hex del background o del texto si plain. Ej "#00FF00" para verde fluor.
      primaryColorHex: z.string().nullable().default(null),
      // Texto en MAYÚSCULAS, Title Case, mixed. Refleja el tono.
      textCase: z.enum(['UPPERCASE', 'Title Case', 'lowercase', 'mixed']).default('UPPERCASE'),
      // Posición típica de los overlays.
      position: z.enum(['top', 'center', 'bottom', 'mixed']).default('bottom'),
      // Familia tipográfica aproximada (sans-serif bold típico TikTok, serif elegante, etc.)
      fontStyle: z.string().default('sans-serif bold'),
    })
    .nullable()
    .default(null),

  // Si la mayoría de los frames muestran personas REALES (no ilustradas),
  // describir el tipo de personajes (gender, edad, etnia, vestuario, ambiente).
  // Esto guía al generator cuando deba meter humanos en escena.
  // Si el anuncio es 100% ilustrado o sin personas, null.
  realCharactersDescription: z.string().nullable().default(null),

  // Tags adicionales del aesthetic, libres pero útiles para enriquecer el prompt.
  // Ej: ["TikTok urgent", "infomercial", "before-after format", "split-screen comparison"]
  aestheticTags: z.array(z.string()).default([]),
});

export type AdVisualStyleProfile = z.infer<typeof AdVisualStyleProfileSchema>;

export const AdAnalysisSchema = z.object({
  // ISO 639-1 del idioma de la narración (ej "en", "es", "pt").
  language: z.string(),
  totalDurationSeconds: z.number().positive(),
  // Transcript completo de la narración, sin timestamps. Si no hay narración,
  // string vacío.
  fullNarration: z.string(),
  // Perfil inferido del narrador (gender, edad, ubicación visual). Si el
  // anuncio no tiene narrador visible/audible, narratorPresent=false.
  narratorProfile: NarratorProfileSchema.optional(),
  // Escenas detectadas con timestamps. Idealmente entre 10-30 escenas.
  scenes: z.array(AdSceneAnalysisSchema).min(1),
  product: AdProductAnalysisSchema,
  // Estructura narrativa + tono editorial + ángulo psicológico. Ej:
  // "Hook con dolor ('Cansada de despertar hinchada?') → revelación de causa
  //  oculta → presentación de solución natural → testimonios de resultados →
  //  CTA suave con urgencia social. Tono: amiga cercana confiable, no agresiva.
  //  Hook-type: pain-agitation."
  editorialLine: z.string(),
  // Tipo de hook usado en los primeros 3s.
  hookType: z.enum([
    'shock',
    'curiosidad',
    'autoridad',
    'pain-agitation',
    'testimonio',
    'pregunta-directa',
    'beneficio-directo',
    'humor',
    'misterio',
    'otro',
  ]),
  // CTA si existe (call-to-action explícito al final). Ej: "ordena en
  // farmacias.cl con 20% descuento por 24 horas". Null si no hay CTA.
  cta: z.string().nullable(),
  // Resumen ejecutivo de 1-2 oraciones del anuncio. Útil para mostrar al usuario.
  summary: z.string(),
  // Perfil VISUAL concreto. Lo que captura "esto es UGC + stock" vs "esto es
  // acuarela animada" vs "esto es 3D Pixar". Determina cómo el preset construido
  // se ve. .optional() para retrocompatibilidad con análisis viejos en DB.
  visualStyleProfile: AdVisualStyleProfileSchema.optional(),
});

export type AdAnalysis = z.infer<typeof AdAnalysisSchema>;

/**
 * Propuesta de script generada por script-suggester sobre la base de un AdAnalysis.
 * El usuario puede aprobar, regenerar o pedir refinamiento.
 */
export const ScriptProposalSchema = z.object({
  id: z.string(),
  title: z.string(), // título corto descriptivo, ej "Versión testimonio personal"
  approach: z.string(), // explicación corta del ángulo elegido
  durationSeconds: z.number().positive(), // estimado
  script: z.string(), // texto del guion
  // Por qué este script "rima" con el editorial line del original
  fidelityNote: z.string(),
});

export type ScriptProposal = z.infer<typeof ScriptProposalSchema>;
