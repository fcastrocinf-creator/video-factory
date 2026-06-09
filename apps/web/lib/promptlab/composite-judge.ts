// composite-judge.ts — el juez COMPUESTO fail-closed del Laboratorio.
//
// Un solo veredicto 0-100 según el modo:
//   RIPEAR: similitud visual vs keyframe (compareImagesWithVision).
//   CREAR:  cumplimiento de intención vs rúbrica (intentJudge).
// FAIL-CLOSED: si el juez crítico no pudo evaluar (excepción/cuota) → notVerified,
// nunca un "pass" silencioso (cierra el fail-open histórico de scene-reviewer).

import { compareImagesWithVision } from '../image-gen-tools';
import { judgeIntentCompliance } from './intent-judge';
import type { JudgeVerdict, VisualTarget } from './types';

export async function compositeJudge(target: VisualTarget, imageBuffer: Buffer): Promise<JudgeVerdict> {
  if (target.mode === 'ripear' && target.referenceImagePath) {
    let cmp: Awaited<ReturnType<typeof compareImagesWithVision>>;
    try {
      cmp = await compareImagesWithVision(target.referenceImagePath, imageBuffer);
    } catch (e) {
      return {
        score: 0,
        byDimension: {},
        approved: false,
        notVerified: true, // FAIL-CLOSED
        hint: `no se pudo comparar contra la referencia (${(e as Error).message.slice(0, 120)})`,
        failedCriteria: [],
        evidence: [],
      };
    }
    const approved = cmp.score >= target.threshold;
    return {
      score: cmp.score,
      byDimension: { ...cmp.details },
      approved,
      notVerified: false,
      hint: cmp.hint,
      failedCriteria: approved ? [] : ['similitud'],
      evidence: [
        `similitud ${cmp.score}/100`,
        `paleta ${cmp.details.palette} · composición ${cmp.details.composition} · personaje ${cmp.details.character} · mood ${cmp.details.mood}`,
      ],
    };
  }

  // CREAR: cumplimiento de intención vs rúbrica (ya es fail-closed internamente).
  return judgeIntentCompliance(imageBuffer, target.rubric, target.threshold);
}
