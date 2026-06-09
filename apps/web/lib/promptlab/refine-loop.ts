// runVisualRefineLoop — el PRIMITIVO único del Laboratorio de Prompts.
//
// Bucle genérico: generar → juzgar (visión) → seleccionar-mejor → ¿aprobar? →
// refinar. Desacoplado de Scene/keyframe/disco (las dependencias entran como
// callbacks). Reusa la lógica probada de refineSceneUntilConverged
// (rip-fidelity-aligner) pero parametrizada para servir RIPEAR y CREAR.
//
// Garantías:
//  - MEJOR-INTENTO siempre: nunca se pierde el progreso (se devuelve el mejor visto).
//  - ANTI-LOOP: tope de intentos + parada por estancamiento (score no sube minDelta).
//  - FAIL-CLOSED: si la IA nunca pudo evaluar, no se aprueba (notVerified) y se dice.
//  - FAIL-LOUD: stopReason explica SIEMPRE por qué se detuvo.

import type { JudgeVerdict, RefineIteration, RefineResult, StopReason } from './types';

export interface RefineLoopCallbacks {
  /** Genera una imagen desde el prompt. Puede persistirla y devolver su ruta. */
  generate: (prompt: string, attempt: number) => Promise<{ buffer: Buffer; imagePath?: string }>;
  /** Juzga la imagen contra el objetivo. Debe ser FAIL-CLOSED (notVerified si no pudo). */
  judge: (image: Buffer, attempt: number) => Promise<JudgeVerdict>;
  /** Propone un prompt mejorado a partir del veredicto. */
  refine: (prompt: string, verdict: JudgeVerdict, attempt: number) => Promise<string>;
}

export interface RefineLoopOptions {
  basePrompt: string;
  /** Tope de intentos (presupuesto). Default 4. */
  maxAttempts?: number;
  /** Mejora mínima de score entre intentos para no considerar estancamiento. Default 3. */
  minDelta?: number;
  /** Callback por iteración (para trayectoria en vivo). */
  onIteration?: (it: RefineIteration) => void | Promise<void>;
  /**
   * Si true, cuando la GENERACIÓN (o el juez) lanza una excepción, se corta el
   * bucle conservando el mejor (en vez de seguir reintentando). Lo usa el ripeo:
   * un fallo de generación suele ser cuota agotada y reintentar sólo quema más.
   * Default false.
   */
  stopOnGenerateError?: boolean;
}

/** ¿`a` es mejor candidato que `b`? Prioriza VERIFICADOS; entre iguales, mayor score. */
function isBetter(a: RefineIteration, b: RefineIteration): boolean {
  if (a.notVerified !== b.notVerified) return !a.notVerified; // verificado > no-verificado
  return a.score > b.score;
}

export async function runVisualRefineLoop(
  cb: RefineLoopCallbacks,
  opts: RefineLoopOptions,
): Promise<RefineResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const minDelta = opts.minDelta ?? 3;

  const iterations: RefineIteration[] = [];
  let prompt = opts.basePrompt;
  let best: RefineIteration | null = null;
  let everVerified = false;
  let stagnation = 0;
  let stopReason: StopReason = 'exhausto-presupuesto';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let it: RefineIteration;

    try {
      const gen = await cb.generate(prompt, attempt);
      const verdict: JudgeVerdict = await cb.judge(gen.buffer, attempt);
      it = {
        iteration: attempt,
        prompt,
        score: verdict.score,
        approved: verdict.approved && !verdict.notVerified,
        notVerified: verdict.notVerified,
        hint: verdict.hint,
        failedCriteria: verdict.failedCriteria,
        imagePath: gen.imagePath,
      };
      iterations.push(it);
      await opts.onIteration?.(it);

      if (!verdict.notVerified) everVerified = true;
      if (!best || isBetter(it, best)) best = it;

      if (it.approved) {
        stopReason = 'aprobado';
        break;
      }

      // Defecto irrecuperable reportado por el juez: parar y conservar el mejor.
      if (verdict.fatal) {
        stopReason = 'fatal';
        break;
      }

      // Estancamiento: si el score no sube `minDelta` respecto a la iteración previa.
      const prev = iterations[iterations.length - 2];
      if (prev && it.score - prev.score < minDelta) stagnation++;
      else stagnation = 0;
      if (stagnation >= 2 && attempt < maxAttempts) {
        stopReason = 'estancado';
        break;
      }

      if (attempt === maxAttempts) {
        stopReason = 'exhausto-presupuesto';
        break;
      }

      // Refinar el prompt para el siguiente intento.
      prompt = await cb.refine(prompt, verdict, attempt);
    } catch (e) {
      // Intento fallido (generación / juez / refinador lanzó). NO abortamos el
      // progreso: registramos el fallo y seguimos hasta agotar intentos.
      it = {
        iteration: attempt,
        prompt,
        score: 0,
        approved: false,
        notVerified: true,
        hint: `error en el intento: ${(e as Error).message.slice(0, 200)}`,
        failedCriteria: [],
      };
      iterations.push(it);
      await opts.onIteration?.(it);
      if (opts.stopOnGenerateError) {
        // El ripeo corta ante un fallo de generación (cuota): conserva el mejor.
        stopReason = best ? 'exhausto-presupuesto' : 'fatal';
        break;
      }
      if (attempt === maxAttempts) {
        stopReason = best ? 'exhausto-presupuesto' : 'fatal';
        break;
      }
    }
  }

  const approved = stopReason === 'aprobado';
  let notVerified = false;
  if (!approved && !everVerified) {
    notVerified = true;
    stopReason = 'no-verificado';
  }

  return {
    approved,
    notVerified,
    bestPrompt: best?.prompt ?? opts.basePrompt,
    bestScore: best?.score ?? 0,
    bestImagePath: best?.imagePath,
    iterations,
    stopReason,
  };
}
