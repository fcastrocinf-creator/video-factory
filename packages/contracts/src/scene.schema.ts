import { z } from 'zod';
import { NarratorProfileSchema, SpeakerProfileSchema } from './script.schema.js';

// Capas de texto que se renderizan ENCIMA de la imagen base en Remotion.
// Resuelven el problema estructural de que Imagen 4 no genera texto coherente
// (labels gibberish, calendarios con números rotos). En vez de pedirle a Imagen
// que dibuje el texto, generamos la imagen LIMPIA (sin texto) y overlay-amos
// el texto como capa vectorial controlada.
export const TextOverlaySchema = z.object({
  // Tipo determina el estilo visual y la posición default.
  // - "product-label": nombre de marca en serif elegante, centrado bajo/sobre objeto
  // - "day-counter": "DÍA 10" estilo timestamp grande
  // - "metric-callout": un número grande con caption ("25%", "30 días")
  // - "subtitle-banner": banner inferior con texto descriptivo
  kind: z.enum(['product-label', 'day-counter', 'metric-callout', 'subtitle-banner']),
  // El texto a renderizar. Para product-label típicamente "VITALY GOTAS",
  // para day-counter "DÍA 10", etc.
  text: z.string(),
  // Posición opcional override. Si null, se usa el default del kind.
  position: z.enum(['top', 'center', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
  // Color hex opcional override. Si null, se usa el color de brand del preset.
  color: z.string().optional(),
  // Tamaño relativo (1.0 = default). 0.7 = más chico, 1.5 = más grande.
  scale: z.number().min(0.3).max(3).default(1),
});

export type TextOverlay = z.infer<typeof TextOverlaySchema>;

// === COMPOSITE LAYOUTS ===
//
// Cuando una escena del original es un split-screen / collage (típico en ads
// TikTok que muestran "antes/después", "4 testimonios juntos", "diagrama +
// reacción"), generar UNA imagen que reproduzca todo el grid es desastre: el
// modelo borrosea los paneles, mete gibberish text en cada uno, y la composición
// queda caótica.
//
// La solución arquitectónica: cada PANEL del grid es una sub-escena INDEPENDIENTE.
// El generator hace 1 imagen por panel (clean, enfocada), el reviewer valida
// cada una por separado, y Remotion las junta en grid pixel-perfect en post-
// producción con texto vectorial encima de cada panel.

export const CompositeLayoutSchema = z.enum([
  'single', // default — 1 imagen ocupa toda la escena
  'grid-2x2', // 2×2 igual tamaño, 4 paneles
  'grid-2x2-with-bottom', // 2×2 arriba + 1 panel ancho abajo (5 paneles)
  'grid-3x2', // 3 filas × 2 columnas, 6 paneles (típico de "6 mujeres antes/después")
  'before-after', // 2 paneles verticales: izq = antes, der = después
  'side-by-side', // 2 paneles horizontales arriba/abajo
  'pip', // picture-in-picture: 1 grande + 1 chico esquina
]);
export type CompositeLayout = z.infer<typeof CompositeLayoutSchema>;

// Cada panel de un composite layout es una sub-escena. Tiene su propio prompt,
// imagen generada, validator verdict, y opcionalmente su propio textOverlay.
export const SubSceneSchema = z.object({
  // Identifica posición del panel dentro del layout.
  //   grid-2x2 → 'top-left', 'top-right', 'bottom-left', 'bottom-right'
  //   grid-2x2-with-bottom → above + 'bottom-wide'
  //   grid-3x2 → 'top-left', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-right'
  //   before-after → 'left' (antes), 'right' (después)
  //   side-by-side → 'top', 'bottom'
  //   pip → 'main', 'pip'
  panel: z.string(),
  // Prompt específico para este panel. Mucho más simple y enfocado que un
  // collage entero ("woman with puffy face in car" vs "split-screen showing 4
  // women with various face states + anatomical diagram below").
  imagePrompt: z.string(),
  // Path de la imagen generada para este panel.
  imagePath: z.string().optional(),
  // TextOverlay propio del panel (vectorial sobre el panel en Remotion).
  // Para el caso del grid-2x2-with-bottom típico: top-left="ANTES",
  // top-right="DESPUÉS", bottom-wide="VITALY".
  textOverlay: TextOverlaySchema.optional(),
});
export type SubScene = z.infer<typeof SubSceneSchema>;

// === MOTOR DE COMPOSICIÓN LIBRE (FREEFORM) ===
//
// SubScene + CompositeLayout resuelven grids regulares (2×2, 3×2, etc.). Pero
// las ediciones complejas reales de los ads — overlays en esquinas, picture-in-
// picture de tamaño arbitrario, piezas rotadas, capas que entran y salen en
// momentos distintos — NO encajan en plantillas fijas.
//
// CompositeElement es la unidad del motor de composición LIBRE: cada pieza se
// posiciona con coordenadas arbitrarias (en % del frame), con su propia capa
// (zIndex), rotación, opacidad y timing. Una escena con `composition` poblada
// se renderiza con el componente FreeformComposite de Remotion, que reproduce
// cualquier edición compleja.
//
// Es además la estructura que:
//   - el EDITOR MANUAL manipula (mover/redimensionar/rotar piezas)
//   - el LOOP DE APRENDIZAJE usa para registrar correcciones IA→humano
export const CompositeElementSchema = z.object({
  // ID estable del elemento — el editor manual y el loop de aprendizaje lo
  // referencian para trackear ajustes a lo largo del tiempo.
  id: z.string(),
  // Tipo de pieza: imagen, clip de video, texto vectorial, o ANOTACIÓN (forma
  // señaladora: círculo/flecha).
  kind: z.enum(['image', 'video', 'text', 'annotation']),
  // Prompt usado para generar la pieza (kind image|video). Permite regenerarla.
  imagePrompt: z.string().optional(),
  // Paths de la pieza generada (poblados por el aligner).
  imagePath: z.string().optional(),
  videoPath: z.string().optional(),
  // Contenido textual cuando kind='text'. Se renderiza como texto vectorial.
  text: z.string().optional(),
  // Color del texto (kind='text'). Opcional; default blanco. Para captions
  // amarillos estilo UGC/CapCut sin tocar el color por defecto del resto.
  textColor: z.string().optional(),
  // GEOMETRÍA LIBRE: caja del elemento en porcentaje del frame 9:16 (0-100).
  // xPct/yPct = esquina superior izquierda. Habilita cualquier collage / overlay
  // / PiP / disposición irregular — esta es la diferencia clave vs. los layouts
  // rígidos de CompositeLayout.
  rect: z.object({
    xPct: z.number(),
    yPct: z.number(),
    widthPct: z.number().positive(),
    heightPct: z.number().positive(),
  }),
  // Rotación en grados. Los collages estilo CapCut suelen rotar piezas levemente.
  rotationDeg: z.number().default(0),
  // Opacidad 0-1.
  opacity: z.number().min(0).max(1).default(1),
  // Orden de apilamiento. Mayor zIndex = más al frente.
  zIndex: z.number().int().default(0),
  // Cómo se ajusta el contenido dentro de su caja.
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  // Radio de esquina en % del lado menor (collages suelen redondear bordes).
  cornerRadiusPct: z.number().min(0).max(50).default(0),
  // Timing OPCIONAL relativo al inicio de la escena (segundos). Si ambos son
  // undefined, la pieza dura toda la escena.
  startSeconds: z.number().nonnegative().optional(),
  endSeconds: z.number().nonnegative().optional(),
  // TextOverlay vectorial propio (para piezas image/video que necesitan label).
  textOverlay: TextOverlaySchema.optional(),
  // RECORTE por chroma key: si está, al componer se elimina el fondo del color
  // indicado (típicamente verde) → el sujeto queda recortado sobre las capas de
  // abajo (overlay "figura sin fondo"). El sujeto debe generarse sobre ese color
  // sólido. Primitivo para superponer una figura (ej. médica) sobre otro clip,
  // como en las ediciones CapCut.
  chromaKey: z
    .object({
      color: z.enum(['green', 'blue']).default('green'),
      similarity: z.number().min(0).max(1).default(0.4),
    })
    .optional(),
  // ANOTACIÓN (cuando kind='annotation'): forma señaladora dibujada sobre las
  // capas (círculo y/o flecha), como el círculo+flecha rojos de los ads. El
  // círculo usa el `rect` del elemento; la flecha sale de from{X,Y}Pct.
  annotation: z
    .object({
      shape: z.enum(['circle', 'arrow', 'circle-arrow']).default('circle-arrow'),
      color: z.string().default('#FF3B30'),
      fromXPct: z.number().optional(),
      fromYPct: z.number().optional(),
    })
    .optional(),
  // true si un humano ajustó esta pieza en el editor manual. El loop de
  // aprendizaje (Fase 4) usa este flag para registrar la corrección IA→humano.
  manuallyAdjusted: z.boolean().default(false),
});
export type CompositeElement = z.infer<typeof CompositeElementSchema>;

// Una escena = un visual estático (con Ken Burns) o animado (clip Veo) que cubre
// un rango específico de la línea de tiempo del audio. Cuando una pipeline usa
// estrategia=multi_escena, generamos N escenas en vez de un solo fondo.
export const SceneSchema = z.object({
  index: z.number().int().nonnegative(),
  // Texto del guión que se narra durante esta escena (puede ser concatenación
  // de varios segmentos cortos del parsedScript).
  text: z.string(),
  // Timestamps dentro del audio total.
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
  // Prompt usado para generar la imagen/video de esta escena. Crítico para
  // poder regenerar una escena en el futuro ("cambiame el segundo 0:35").
  imagePrompt: z.string(),
  // Resultados de generación (poblados después).
  imagePath: z.string().optional(),
  videoPath: z.string().optional(),
  // Capas de texto a renderizar sobre la imagen base en Remotion. Cuando una
  // escena requiere texto (etiqueta de producto, fecha, métrica), scene-planner
  // los marca acá y AJUSTA el imagePrompt para que Imagen genere imagen LIMPIA
  // (sin texto). Remotion renderiza el texto como capa vectorial sobre la imagen.
  textOverlays: z.array(TextOverlaySchema).default([]).optional(),
  // Layout composite. 'single' (default) = una imagen para toda la escena.
  // Si != 'single', subScenes describe cada panel del grid.
  compositeLayout: CompositeLayoutSchema.default('single').optional(),
  // Sub-escenas cuando compositeLayout != 'single'. Cada una se genera y valida
  // independientemente; Remotion las junta en el layout especificado.
  subScenes: z.array(SubSceneSchema).default([]).optional(),
  // Composición LIBRE. Cuando está poblada (length > 0), la escena se renderiza
  // con el motor FreeformComposite — cada CompositeElement en su posición
  // arbitraria — en vez de usar compositeLayout/subScenes. Es la estructura para
  // ediciones complejas, la que el editor manual manipula, y sobre la que el
  // loop de aprendizaje registra las correcciones humanas.
  composition: z.array(CompositeElementSchema).default([]).optional(),
  // v3.2 #145 (29-may-2026): ¿el personaje en pantalla HABLA esta línea en
  // primera persona (lip-sync) o es VOICE-OVER / B-ROLL (narración off-screen,
  // boca NO sincroniza con el texto)?
  //   - true  → el personaje DICE este texto → la animación mueve la boca
  //     sincronizada (talking-head, testimonial, diálogo en 1ª persona).
  //   - false → voice-over/B-roll → el personaje NO mueve la boca con el texto,
  //     solo gestos/expresión ambiente (DEFAULT — la mayoría de ads D2C son VO).
  // El scene-planner lo decide por escena. El motion prompt ramifica con esto.
  speaking: z.boolean().default(false).optional(),
  // Multi-voz ("Estilo CapCut"): qué hablante (SpeakerProfile.id) dice esta escena.
  // Si está, el TTS sintetiza esta línea con la voz de ese hablante; si no, usa la
  // voz única (narratorProfile) — retro-compatible.
  speakerId: z.string().optional(),
  // v3.2 #145: override MANUAL de duración de la escena en segundos. Cuando el
  // owner recorta una escena a mano ("cortá en el segundo 2.3"), se guarda acá.
  // Si está, el compositor usa ESTO en vez de (endTimeSeconds - startTimeSeconds).
  // null/undefined = usar el auto-trim normal.
  manualDurationSeconds: z.number().positive().optional().nullable(),
  // Cap 3 (mixeo/overlay): si está, tras generar la imagen BASE se corre un EDIT
  // image-to-image (Nano Banana) que SUMA un efecto sobre la base SIN cambiar
  // identidad/pose/encuadre (ej. "flujo linfático glowing sobre el abdomen"). El
  // scene-planner lo setea para escenas componentType='overlay-on-body'.
  editStep: z
    .object({
      effectPrompt: z.string(),
      region: z.string().optional(),
    })
    .optional(),
  // Cap 1 (ruteo por componente): tipo de componente visual, usado para rutear
  // al mejor provider de imagen. Lo deriva el scene-planner del shotType/prompt.
  componentType: z
    .enum(['cgi-macro', 'real-ugc-human', 'overlay-on-body', 'other'])
    .default('other')
    .optional(),
  // Cap 2 (identidad): ¿esta escena muestra al personaje recurrente? Si sí, se
  // ancla su identidad (misma persona) vía referencia image-to-image.
  featuresCharacter: z.boolean().default(false).optional(),
});

export type Scene = z.infer<typeof SceneSchema>;

export const SceneTrackSchema = z.object({
  scenes: z.array(SceneSchema).min(1),
  totalDurationSeconds: z.number().positive(),
  // Estilo visual común aplicado a todas las escenas (heredado del preset).
  styleBase: z.string(),
  // Perfil inferido del narrador. Usado por scene-validator para validar
  // coherencia y por la UI/TTS para selección de voz.
  narratorProfile: NarratorProfileSchema.optional(),
  // Multi-voz: hablantes del ad (opcional, retro-compat). Cada Scene referencia uno
  // por speakerId. Si no hay speakers[], todo usa narratorProfile (una sola voz).
  speakers: z.array(SpeakerProfileSchema).optional(),
});

export type SceneTrack = z.infer<typeof SceneTrackSchema>;
