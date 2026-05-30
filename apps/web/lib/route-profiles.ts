// route-profiles.ts — "Una ruta buena para cada tipo de video."
//
// Cada TIPO de video (UGC realista, animado 3D/Pixar, ilustrado acuarela, etc.)
// necesita un tratamiento DISTINTO en el pipeline: qué tan estricto es el
// validator de anatomía, cómo se anima, qué providers convienen. Antes esa
// lógica estaba implícita y dispersa; acá la hacemos EXPLÍCITA como datos.
//
// El "acá es diferente" deja de ser improvisado: el pipeline resuelve el perfil
// de ruta del preset y aplica el tratamiento correcto. El "arquitecto IA" (chat)
// lee estos perfiles para razonar sobre la herramienta y proponer ajustes.
//
// GATED + retrocompatible: el perfil `default` replica el comportamiento histórico
// (anatomía estricta), así que cualquier estilo que no matchee un perfil específico
// se comporta EXACTAMENTE como antes.

/** Qué tan estricto es el validator con la anatomía humana. */
export type AnatomyMode =
  // Humano real: 5 dedos por mano / 5 por pie / proporciones humanas son CRÍTICAS.
  // Un humano fotorrealista con 6 dedos espanta → se regenera.
  | 'strict'
  // Criaturas de dibujo / personajes estilizados: dedos, toes y proporciones son
  // DECISIONES DE ESTILO (muchos personajes animados tienen 3-4 dedos a propósito).
  // No se regenera por "conteo de dedos"; el panel de especialistas (ai-artifact:
  // fusiones, melted, blobs / narrative-fit / coherencia) sigue activo y sí rechaza
  // lo que de verdad se ve mal.
  | 'lenient';

/** Cómo se da movimiento a las escenas. */
export type AnimationMode =
  | 'real' // image-to-video real (Higgsfield/Kling/Veo) — UGC, realismo
  | 'ken-burns'; // pan/zoom sobre la imagen — ilustrado/animado estático

export interface RouteProfile {
  id: string;
  displayName: string;
  /** Para el arquitecto IA: explicación humana de por qué esta ruta es distinta. */
  rationale: string;
  /** Cómo se detecta este perfil a partir del preset/estilo. */
  match: {
    styleKeywords?: string[];
    formatIds?: string[];
    styleIds?: string[];
  };
  validator: {
    anatomyMode: AnatomyMode;
    note: string;
  };
  animation: AnimationMode;
  // RUTA: intensidad de movimiento al animar. Estilos animados/épicos → 'powerful'
  // (acción dramática, no sutil); talking-head/UGC → 'subtle' (respiración, micro-
  // cámara); 'moderate' = balance. Lo descubrimos en la frutinovela: el movimiento
  // sutil era tibio para escenas épicas.
  motionIntensity?: 'powerful' | 'moderate' | 'subtle';
}

// Orden = prioridad de match (el primero que matchea gana). Los más ESPECÍFICOS
// van primero (cartoon/ilustrado antes que el genérico).
const PROFILES: RouteProfile[] = [
  {
    id: 'cartoon-3d',
    displayName: 'Animado 3D / Pixar / Frutinovela',
    rationale:
      'Personajes y criaturas de dibujo 3D (estilo Pixar). Dedos, toes y proporciones son ' +
      'decisiones de estilo, NO errores. El validator de anatomía humana no aplica; sí aplican ' +
      'los chequeos de fusiones/melted/blobs, coherencia narrativa y consistencia de estilo.',
    match: {
      styleKeywords: [
        'pixar',
        '3d animated',
        '3d-animated',
        'animated character',
        'anthropomorphic',
        'cartoon',
        'frutinovela',
        'claymation',
        'cgi character',
      ],
      formatIds: ['b-roll-animated'],
    },
    validator: {
      anatomyMode: 'lenient',
      note: 'Criaturas cartoon: anatomía relajada (dedos/proporciones = estilo). Se mantiene el rechazo de fusiones/melted/gibberish.',
    },
    animation: 'ken-burns',
    motionIntensity: 'powerful',
  },
  {
    id: 'illustrated',
    displayName: 'Ilustrado (Acuarela / Comic / Sepia / Ghibli)',
    rationale:
      'Ilustración a mano (acuarela, comic, sepia, Ghibli). El foco es textura, paleta y ' +
      'pincelada, no la anatomía hiperrealista. Anatomía relajada; Ken Burns para el movimiento.',
    match: {
      styleKeywords: [
        'watercolor',
        'acuarela',
        'comic',
        'sepia',
        'ghibli',
        'illustrated',
        'hand-drawn',
        'hand drawn',
        'painted',
        'digital painting',
        'storybook',
        'ilustrado',
      ],
    },
    validator: {
      anatomyMode: 'lenient',
      note: 'Ilustración: foco en textura/paleta. Anatomía relajada; el panel de coherencia y estilo sigue activo.',
    },
    animation: 'ken-burns',
  },
  {
    id: 'ugc-real',
    displayName: 'UGC / Realista',
    rationale:
      'Persona real, look de smartphone (UGC) o fotorrealista. Acá la anatomía humana SÍ ' +
      'importa: un humano con 6 dedos o pies más grandes que la cabeza arruina el ad. Anatomía ' +
      'estricta + animación real (Higgsfield/Kling) para naturalidad facial.',
    match: {
      styleKeywords: [
        'ugc',
        'realista',
        'fotorealista',
        'photorealistic',
        'photoreal',
        'real woman',
        'real man',
        'real person',
        'smartphone',
        'selfie',
        'dslr',
        'amateur',
        'natural lighting',
      ],
      formatIds: ['ugc-testimonial', 'ugc-unboxing', 'ugc-problema-solucion'],
    },
    validator: {
      anatomyMode: 'strict',
      note: 'Humano real: anatomía estricta (5 dedos importa de verdad).',
    },
    animation: 'real',
    motionIntensity: 'subtle',
  },
];

/** Perfil por defecto = comportamiento histórico (estricto). Cero cambios si nada matchea. */
export const DEFAULT_ROUTE_PROFILE: RouteProfile = {
  id: 'default',
  displayName: 'Estándar',
  rationale:
    'Ruta genérica cuando el estilo no matchea un perfil específico. Mantiene el ' +
    'comportamiento histórico: anatomía estricta + animación real.',
  match: {},
  validator: {
    anatomyMode: 'strict',
    note: 'Comportamiento histórico — anatomía estricta.',
  },
  animation: 'real',
};

export interface RouteResolveInput {
  styleBase?: string | null;
  formatId?: string | null;
  styleId?: string | null;
}

/**
 * Resuelve el perfil de ruta para un preset/estilo. Primero por formatId/styleId
 * exacto, luego por keywords en el styleBase. Si nada matchea → DEFAULT (estricto).
 */
export function resolveRouteProfile(input: RouteResolveInput): RouteProfile {
  const formatId = (input.formatId ?? '').toLowerCase();
  const styleId = (input.styleId ?? '').toLowerCase();
  const hay = `${input.styleBase ?? ''} ${formatId} ${styleId}`.toLowerCase();

  for (const p of PROFILES) {
    const fmtHit = p.match.formatIds?.some((f) => f.toLowerCase() === formatId);
    const styHit = p.match.styleIds?.some((s) => s.toLowerCase() === styleId);
    const kwHit = p.match.styleKeywords?.some((k) => hay.includes(k.toLowerCase()));
    if (fmtHit || styHit || kwHit) return p;
  }
  return DEFAULT_ROUTE_PROFILE;
}

/** Todos los perfiles (incluido default) — para el arquitecto IA / UI / debugging. */
export function allRouteProfiles(): RouteProfile[] {
  return [...PROFILES, DEFAULT_ROUTE_PROFILE];
}

/** Resumen legible de todos los perfiles — lo inyecta el chat "arquitecto IA". */
export function describeRouteProfiles(): string {
  return allRouteProfiles()
    .map(
      (p) =>
        `- ${p.displayName} (id=${p.id}): anatomía=${p.validator.anatomyMode}, animación=${p.animation}${p.motionIntensity ? `, movimiento=${p.motionIntensity}` : ''}. ${p.rationale}`,
    )
    .join('\n');
}
