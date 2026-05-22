import { z } from 'zod';

export const ElevenLabsVoiceConfigSchema = z.object({
  voiceId: z.string(),
  modelId: z.string().default('eleven_multilingual_v2'),
  stability: z.number().min(0).max(1),
  similarity: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  speakerBoost: z.boolean().default(true),
  speedMultiplier: z.number().default(1.0),
  // Metadata para la voice library: permite seleccionar la voz adecuada según
  // el perfil del narrador inferido del guion.
  gender: z.enum(['male', 'female', 'neutral']).default('neutral'),
  ageRange: z.string().default('30-45'),
  // Label legible para mostrar en la UI ("Vitaly · Amiga chismosa")
  label: z.string().default(''),
});

export type ElevenLabsVoiceConfig = z.infer<typeof ElevenLabsVoiceConfigSchema>;

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // Ruta a una imagen de referencia del producto (packshot). Si está, scene-planner
  // y el image generator la pueden citar literalmente en los prompts ("el producto
  // se ve como en la imagen de referencia") y el compositor puede overlay-arla.
  referenceImagePath: z.string().optional(),
  // Dimensiones físicas legibles ("12cm de alto, frasco gotero ámbar"). Lo usa
  // scene-planner para describir el producto con precisión visual.
  dimensions: z.string().optional(),
});

export type Product = z.infer<typeof ProductSchema>;

// Ingredients = biblioteca visual + textual de la marca. Permite que la IA
// reconozca y use los activos sin que el usuario tenga que repetirlos en cada
// guion. Se persiste en disco junto al brand.json y se carga automáticamente
// en cada generación.
export const BrandIngredientsSchema = z.object({
  // Path al logo principal de la marca (PNG/SVG idealmente con fondo transparente).
  logoPath: z.string().optional(),
  // Descripción del logo para que la IA sepa qué representa (ej: "Logo Vitaly:
  // texto amarillo sobre fondo blanco, tipografía sans-serif redondeada").
  logoDescription: z.string().optional(),
  // Cuando colocar el logo en el video. 'last-scene' = solo en la última escena;
  // 'all-scenes' = overlay constante; 'product-scenes' = cuando aparece el
  // producto; 'never' = no overlay automático.
  logoPlacement: z
    .enum(['last-scene', 'all-scenes', 'product-scenes', 'never'])
    .default('last-scene'),
  // Frases / elementos que SIEMPRE deben aparecer en algún momento del video.
  // Ej: "Disponible en Farmacias Salcobrand", "30 días de garantía".
  mustInclude: z.array(z.string()).default([]),
  // Elementos que NUNCA deben aparecer (claims médicos absolutos, comparaciones
  // con la competencia, etc.).
  mustAvoid: z.array(z.string()).default([]),
  // Paleta de colores con nombre semántico para que la IA pueda citar
  // ("usa el amarillo Vitaly #FFE600 en el subtítulo").
  colorPalette: z
    .array(
      z.object({
        name: z.string(),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        usage: z.string().optional(),
      }),
    )
    .default([]),
  // Activos adicionales: empaque, mockups, fotos de uso. Cada uno con descripción
  // para que la IA sepa cuándo invocarlo.
  assets: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        kind: z.enum(['product-shot', 'packaging', 'mockup', 'lifestyle', 'icon', 'other']),
        description: z.string(),
      }),
    )
    .default([]),
});

export type BrandIngredients = z.infer<typeof BrandIngredientsSchema>;

export const BrandConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),

  products: z.array(ProductSchema),

  defaultVoice: ElevenLabsVoiceConfigSchema,
  // Voice library opcional: voces alternas que el sistema puede elegir cuando
  // el narratorProfile inferido del guion no matchee con defaultVoice
  // (ej. guion con narrador masculino pero defaultVoice es femenina).
  voiceLibrary: z.array(ElevenLabsVoiceConfigSchema).default([]),

  language: z.string(),

  brandColors: z.array(z.string()).default([]),

  toneRules: z
    .object({
      avoid: z.array(z.string()).default([]),
      prefer: z.array(z.string()).default([]),
    })
    .default({ avoid: [], prefer: [] }),

  logoPath: z.string().optional(),

  // NUEVO: biblioteca visual + reglas de la marca para que la IA la use al
  // generar prompts. Si está vacío, el pipeline funciona como antes.
  ingredients: BrandIngredientsSchema.default({
    mustInclude: [],
    mustAvoid: [],
    colorPalette: [],
    assets: [],
    logoPlacement: 'last-scene',
  }),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BrandConfig = z.infer<typeof BrandConfigSchema>;
