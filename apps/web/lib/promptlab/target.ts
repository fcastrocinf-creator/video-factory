// target.ts — entrypoint DUAL: normaliza la entrada a un VisualTarget único.
//   CREAR:  intención NL → rúbrica + prompt v1 (buildRubricFromIntention).
//   RIPEAR: keyframe de referencia → objetivo de similitud.

import { buildRubricFromIntention } from './rubric';
import type { VisualTarget } from './types';

const DEFAULT_THRESHOLD_CREAR = 82;
const DEFAULT_THRESHOLD_RIPEAR = 88;

export async function buildTargetFromIntention(args: {
  intention: string;
  brandId?: string;
  threshold?: number;
}): Promise<VisualTarget> {
  const { rubric, basePrompt } = await buildRubricFromIntention(args.intention);
  return {
    mode: 'crear',
    intention: args.intention,
    rubric,
    basePrompt,
    threshold: args.threshold ?? DEFAULT_THRESHOLD_CREAR,
    brandId: args.brandId,
  };
}

export async function buildTargetFromReference(args: {
  referenceImagePath: string;
  intention?: string;
  brandId?: string;
  threshold?: number;
}): Promise<VisualTarget> {
  const intention =
    args.intention?.trim() ||
    'Recrear fielmente la composición, encuadre, estilo, paleta y mood de la imagen de referencia.';
  return {
    mode: 'ripear',
    intention,
    referenceImagePath: args.referenceImagePath,
    rubric: [],
    basePrompt: intention,
    threshold: args.threshold ?? DEFAULT_THRESHOLD_RIPEAR,
    brandId: args.brandId,
  };
}
