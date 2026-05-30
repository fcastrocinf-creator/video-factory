import { z } from 'zod';

export const PresetClassificationSchema = z.object({
  formato: z.enum(['ugc', 'educativo', 'storytelling', 'personaje_avatar']),
  hookAngulo: z.enum([
    'objeciones',
    'curiosidad',
    'autoridad',
    'testimonio',
    'test_diagnostico',
  ]),
  funnelStage: z.enum(['tofu', 'mofu', 'bofu']),
  awareness: z.enum(['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware']),
});

export type PresetClassification = z.infer<typeof PresetClassificationSchema>;

// Animation-layer config opcional para presets que generan video (no estáticos).
// Patrón derivado del workflow del especialista Pixar/Kling: cada prompt de
// animación garantiza tres capas simultáneas (acción física + interno
// emocional/anatómico + cámara cinematográfica) para evitar videos estáticos
// o caóticos. Cuando `enforceThreeLayers` está en true, el scene-animator
// valida que el prompt termine con la fórmula "Three layers: A + B + camera X".
export const PresetAnimationLayersSchema = z.object({
  enforceThreeLayers: z.boolean().default(false),
  // Pool de movimientos de cámara válidos para auto-completar la 3ª capa.
  // Ejemplos canónicos: "push", "pull", "orbit", "track", "drift", "intimate push".
  defaultCameraMoves: z.array(z.string()).default([]),
});

export type PresetAnimationLayers = z.infer<typeof PresetAnimationLayersSchema>;

export const PresetVisualStyleSchema = z.object({
  promptTemplate: z.string(),
  negativePrompt: z.string(),
  aspectRatio: z.literal('9:16'),
  referenceImages: z.array(z.string()).default([]),

  // OPCIONAL — sticky prefix invariante prependeable a todo prompt de imagen
  // del preset. Capturado del patrón de plantillas del especialista: cada ad
  // del mismo estilo arranca con la MISMA línea de descripción visual.
  // Si está presente, los blocks pueden anteponerlo al promptTemplate por
  // escena. Si está ausente, el promptTemplate se usa íntegro como hoy.
  // Aditivo y backward-compatible.
  styleBoilerplate: z.string().optional(),

  // OPCIONAL — lista de términos que SIEMPRE deben aparecer en el negative
  // prompt cuando se genera con este preset. Permite al scene-planner sumar
  // estos términos al negativePrompt base sin duplicarlos manualmente.
  // Ejemplo (fotorrealista): ["illustration", "watercolor", "cartoon", "3d render"].
  // Ejemplo (Pixar): ["claymation", "realistic photograph", "vintage cartoon"].
  forbiddenStyleTerms: z.array(z.string()).optional(),

  // OPCIONAL — config de capas para presets que generan video (B-ROLL animado,
  // UGC con movimiento, etc). Para presets estáticos (b-roll-static) dejarlo
  // ausente. Ver `PresetAnimationLayersSchema` arriba.
  animationLayers: PresetAnimationLayersSchema.optional(),
});

export type PresetVisualStyle = z.infer<typeof PresetVisualStyleSchema>;

export const PresetSubtitlesSchema = z.object({
  style: z.enum(['hook_banner', 'word_level_kinetic', 'minimal_elegant']),
  font: z.string().default('Inter'),
  fontSize: z.number().default(64),
  color: z.string().default('#FFFFFF'),
  strokeColor: z.string().default('#000000'),
  strokeWidth: z.number().default(4),
  highlightColor: z.string().default('#FFE600'),
  position: z.enum(['top', 'center', 'bottom']),
  allCaps: z.boolean().default(true),
});

export type PresetSubtitles = z.infer<typeof PresetSubtitlesSchema>;

export const PresetVoiceOverrideSchema = z.object({
  voiceId: z.string(),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean(),
});

export type PresetVoiceOverride = z.infer<typeof PresetVoiceOverrideSchema>;

export const PresetCompositionSchema = z.object({
  kenBurns: z.object({
    enabled: z.boolean().default(true),
    zoomStart: z.number().default(1.0),
    zoomEnd: z.number().default(1.15),
    panX: z.number().default(0),
    panY: z.number().default(0),
  }),
  backgroundMusic: z.object({
    enabled: z.boolean().default(false),
    volumeDb: z.number().default(-20),
  }),
});

export type PresetComposition = z.infer<typeof PresetCompositionSchema>;

// CATEGORÍA narrativa = "qué quiero contar / desde qué ángulo".
// Es la primera decisión del usuario. Independiente del estilo visual.
// Ejemplos:
//   - "doctor_autoridad": un experto/médico habla con autoridad
//   - "mujer_empoderada": narradora protagonista que vivió el problema
//   - "voiceover_impersonal": narración sin personaje identificable
//   - "testimonio_real": persona real contando su experiencia
export const PresetCategorySchema = z.object({
  id: z.string(), // ej: "doctor_autoridad"
  displayName: z.string(), // ej: "Doctor (Autoridad)"
  description: z.string().default(''),
});

export type PresetCategory = z.infer<typeof PresetCategorySchema>;

// FORMATO = "cómo se entrega visualmente". Capa intermedia entre categoría
// (qué se cuenta) y estilo (cómo se ve). El catálogo es EXTENSIBLE — agregar
// un nuevo formato es solo añadir un valor al enum + entrada en CANONICAL_FORMATS.
//
// Canónicos actuales:
//   B-ROLL                  - imágenes/clips ilustrativos sin testimoniante hablando
//     · b-roll-static       (sin animación)
//     · b-roll-animated     (con movimiento)
//   UGC                     - estética amateur móvil
//     · ugc-broll           (handheld sin talking-head)
//     · ugc-testimony       (persona hablando a cámara amateur)
//   LARGO / EXPLAINER       - formatos narrativos específicos
//     · vsl                 (Video Sales Letter — formato persuasivo largo, 3-10 min)
//     · voiceover-animated  (motion graphics / explainer animado, no fotorrealista)
//
// Para agregar (ej. demo-tutorial, reaction, stop-motion): añadir id al enum,
// entry a CANONICAL_FORMATS y crear presets que lo usen.
export const PresetFormatKindSchema = z.enum([
  'b-roll-static',
  'b-roll-animated',
  'ugc-broll',
  'ugc-testimony',
  'vsl',
  'voiceover-animated',
]);
export type PresetFormatKind = z.infer<typeof PresetFormatKindSchema>;

export const PresetFormatSchema = z.object({
  id: PresetFormatKindSchema,
  displayName: z.string(),
  description: z.string().default(''),
});
export type PresetFormat = z.infer<typeof PresetFormatSchema>;

// Helper: el catálogo canónico de formatos. Se usa para que la UI siempre
// muestre todos los formatos como opciones disponibles (filtrando por los que
// efectivamente tienen un preset asociado).
export const CANONICAL_FORMATS: PresetFormat[] = [
  {
    id: 'b-roll-static',
    displayName: 'B-ROLL Estático',
    description: 'Gráficas sin animación: imágenes estáticas tipo carrusel ilustrado.',
  },
  {
    id: 'b-roll-animated',
    displayName: 'B-ROLL Animado',
    description:
      'Gráficas con movimiento: micro-videos con cámara/objetos en movimiento (Veo/Higgsfield).',
  },
  {
    id: 'ugc-broll',
    displayName: 'UGC B-ROLL',
    description:
      'Cámara amateur sin testimoniante: handheld, lifestyle, primeros planos cotidianos.',
  },
  {
    id: 'ugc-testimony',
    displayName: 'UGC Testimonio',
    description:
      'Persona hablando a cámara (selfie/talking-head amateur). Idealmente con Veo Talking Head.',
  },
  {
    id: 'vsl',
    displayName: 'VSL (Video Sales Letter)',
    description:
      'Formato largo persuasivo (3-10 min): hook → problema → mecanismo → producto → testimonios → CTA. Mix de B-roll + lifestyle.',
  },
  {
    id: 'voiceover-animated',
    displayName: 'Voice Over Animado',
    description:
      'Motion graphics / explainer animado (no fotorrealista): kinetic typography, ilustración animada, diagramas dinámicos.',
  },
];

// ESTILO VISUAL = "cómo se ve". Sub-decisión dentro de cada (categoría, formato).
// Ejemplos: pixar_3d | comic_sepia | fotorealista | ugc_real | watercolor
export const PresetStyleSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

export type PresetStyle = z.infer<typeof PresetStyleSchema>;

export const PresetConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),

  // Taxonomía en cascada Marca → Categoría → Formato → Estilo.
  // Si alguno falta, el preset queda parcialmente "huérfano" y solo se accede por id.
  category: PresetCategorySchema.optional(),
  format: PresetFormatSchema.optional(),
  style: PresetStyleSchema.optional(),

  classification: PresetClassificationSchema,

  estrategia: z.enum(['plano_fijo', 'multi_escena']),

  visualEngine: z.enum(['imagen4', 'veo-lite', 'veo-fast', 'veo-standard', 'higgsfield']),

  visualStyle: PresetVisualStyleSchema,

  subtitles: PresetSubtitlesSchema,

  voiceOverride: PresetVoiceOverrideSchema.optional(),

  defaultDurationSeconds: z.number(),
  scenesPerMinute: z.number(),

  composition: PresetCompositionSchema,

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PresetConfig = z.infer<typeof PresetConfigSchema>;
