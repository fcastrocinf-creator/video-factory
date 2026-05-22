// Validator v3 — Multi-pass con cuestionario estructurado + critique adversarial.
//
// El problema del validator v2: le pedíamos un "veredicto" general y Gemini
// frecuentemente glossaba sobre errores sutiles (4 dedos en una mano que el ojo
// humano nota pero el modelo no cuenta cuidadosamente).
//
// Solución v3: Forzamos respuestas a un CUESTIONARIO ESTRUCTURADO con preguntas
// específicas que no se pueden esquivar:
//   "¿Cuántos dedos tiene la mano 1?" → número entero
//   "¿Los pies son más pequeños que la cabeza?" → yes/no
//   "¿El texto es legible y tiene sentido?" → yes/no/no-text
// Luego un agregador determinístico convierte respuestas en verdict.
//
// + Adversarial critique: una segunda pasada con prompt "encuentra defectos que
// el primer revisor pudo haber pasado por alto".

import { GeminiVisionClient, GeminiVisionApiError } from './gemini-vision-client.js';

const DEFAULT_MODEL = 'gemini-2.5-pro';

export interface ValidationV3Input {
  text: string;
  imagePrompt: string;
  imageBuffer: Buffer;
  styleBase?: string;
  narratorProfile?: {
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: string;
    characterCard?: string;
    narratorPresent?: boolean;
  };
  // FAST MODE — skip las pasadas adicionales (anatomy voting 2 calls + adversarial 1 call).
  // Solo deja el cuestionario estructurado. Útil para acelerar generación cuando se
  // confía en el provider primario. Trade-off: menos catches sutiles de anatomía.
  fastMode?: boolean;
}

export type V3Verdict = 'pass' | 'regenerate' | 'fatal';

export interface V3StructuredAnswers {
  // PEOPLE
  humans_visible: number; // 0 = no people, 1+ = number of people
  // HANDS — per visible hand, exact digit count + occlusion awareness
  hand_1_visible: boolean;
  hand_1_digits_count: number; // EXACT count of digits VISIBLE in image. Including thumb.
  hand_1_fully_unoccluded: boolean; // true if hand is in clear view (no object blocking it). false if gripping/holding something that hides fingers.
  hand_1_anatomy_ok: boolean; // are the VISIBLE digits anatomically correct? (separate, natural proportions, correct angle)
  hand_2_visible: boolean;
  hand_2_digits_count: number;
  hand_2_fully_unoccluded: boolean;
  hand_2_anatomy_ok: boolean;
  // FEET — per visible foot
  foot_1_visible: boolean;
  foot_1_toes_count: number;
  foot_1_size_vs_head: 'smaller' | 'similar' | 'larger' | 'no-head-visible';
  foot_2_visible: boolean;
  foot_2_toes_count: number;
  // BODY PROPORTIONS
  body_proportions_realistic: boolean; // head ~1/7 to 1/8 of body, etc.
  body_symmetry_ok: boolean; // no extra limbs, no missing limbs
  // FACE
  face_visible: boolean;
  face_symmetry_ok: boolean; // eyes same level, same size, no third eye
  face_features_complete: boolean; // both eyes, nose, mouth all present and normal
  // TEXT
  text_present: boolean;
  text_legible_and_meaningful: boolean; // false if gibberish or wrong language
  text_description: string; // what does the text say
  // SCENE
  scene_has_numbers: boolean; // calendar, age display, dates, etc.
  numbers_logical: boolean; // sequential if calendar, etc.
  numbers_description: string;
  // PHYSICS
  objects_obey_gravity: boolean;
  shadows_consistent_with_light: boolean;
  perspective_consistent: boolean;
  // CHARACTER MATCH (if narrator profile given)
  character_matches_profile: 'matches' | 'mismatches' | 'no-character-visible';
  character_mismatch_reason: string;
  // SEMANTIC
  image_matches_narration: boolean;
  semantic_match_score: number; // 0-100
  // ELEMENT LOGICAL COHERENCE — cada elemento visual debe REPRESENTAR PLAUSIBLEMENTE
  // lo que la narración dice que es. Ej: "marcas de presión de zapato" deben verse
  // como indentaciones suaves de piel comprimida — NO como símbolos abstractos
  // (infinity loops, geometric patterns, runas). "Hojas medicinales" deben verse
  // como hojas reconocibles — no como manchas abstractas.
  elements_logically_coherent: boolean;
  // Si elements_logically_coherent=false, descripción específica del elemento que
  // no representa plausiblemente lo que debería: "Red marks on foot look like
  // infinity loops, not natural shoe pressure marks".
  illogical_elements_description: string;
  // BODY PART FUSION — dos partes del cuerpo que se mezclan en formas imposibles.
  // Ej: dos pies que comparten dedos, manos que se funden, piernas que se mezclan.
  body_parts_fused: boolean;
  body_parts_fused_description: string;
  // STYLE
  style_consistent: boolean;
  style_notes: string;
}

export interface V3ValidationResult {
  verdict: V3Verdict;
  score: number; // 0-100, aggregated
  issues: string[]; // human-readable list of issues found
  refinementHint: string | null;
  reasoning: string;
  structuredAnswers: V3StructuredAnswers | null;
  adversarialCritique?: string;
  // Veredictos de cada especialista (cuando se ejecutó el panel completo).
  specialistVerdicts?: SpecialistVerdict[];
}

// Veredicto uniforme de un especialista (narrative-fit, real-world, ai-artifact).
export interface SpecialistVerdict {
  name: 'narrative-fit' | 'real-world' | 'ai-artifact';
  score: number;
  verdict: 'approve' | 'reject';
  issues: string[];
  refinementHint: string | null;
}

const STRUCTURED_SYSTEM_INSTRUCTION = `You are a FORENSIC evaluator of AI-generated images. Your job is to answer a STRUCTURED QUESTIONNAIRE about the image — NOT give a general verdict. Each question must be answered with observational precision.

IMPORTANT: Respond in ENGLISH only. All string fields in your JSON output must be in English.

CRITICAL CONTEXT ABOUT CHARACTERS:
The narrator profile (when provided) describes ONLY the narrator — typically one specific person who speaks in the script (e.g., a doctor). But scenes often show OTHER people too (the patient being addressed, family members, generic figures). When evaluating character_matches_profile:
- The narration text and image prompt of the scene tell you WHICH character should appear
- If the prompt describes the narrator (matches the character card traits), set character_matches_profile to "matches" or "mismatches" based on what you see
- If the prompt describes a DIFFERENT person (e.g., "a woman experiencing morning fatigue" when the narrator is a male doctor), set character_matches_profile to "no-character-visible" because the visible person is NOT supposed to be the narrator
- Use the prompt text + narration text to figure out which character is in this specific scene

ABSOLUTE RULES:

1. COUNT BY ENUMERATION — DO NOT GUESS.
   For each visible hand, locate and silently enumerate each visible digit by name and position:
     - "I see a thumb at position X"
     - "I see an index finger at position Y"
     - "I see a middle finger at position Z"
     - ... etc.
   Only after enumerating, set hand_X_digits_count to the COUNT of digits you enumerated.
   For each visible foot, do the same: enumerate the big toe, then each smaller toe one by one. Only after, set the count.
   This enumeration step is mandatory. If you skip it and just glance, you will undercount.

2. JUDGE OCCLUSION: set hand_X_fully_unoccluded=true ONLY when the entire hand is in clear view (open palm, all fingers spread, no object covering). Set false when the hand is gripping an object, partially behind another object, or fingers wrap around something hiding some.

3. JUDGE ANATOMY OF VISIBLE PORTIONS — BE PRECISE, NOT PARANOID.
   Set hand_X_anatomy_ok=FALSE ONLY when you can identify a SPECIFIC, NAMED defect visible in the image. Examples of valid reasons to mark false:
   - "Two fingers are fused into a single blob"
   - "The thumb is impossibly long, reaching past the fingertips"
   - "An extra digit/finger is clearly visible"
   - "A finger has an impossible 90-degree backward bend"
   - "Fingertips end in bulbous spheres instead of nails"
   - "A finger appears to merge into the palm"
   If you cannot name a specific defect in plain English, mark anatomy_ok=TRUE.
   Set anatomy_ok=TRUE for:
   - Hands you can mostly see but partially occluded by objects — judge only the visible portion
   - Slight stylistic variations (illustrated hands don't need to be hyper-realistic)
   - When unsure, default to TRUE
4. BE LITERAL WITH PROPORTIONS. "feet_size_vs_head": mentally measure foot size and compare with head size visible in image.
5. TEXT IS TEXT ONLY IF LEGIBLE AND MEANINGFUL. Random letters, nonsense syllables, invented words = NOT legible/meaningful even if they look like text.
6. SEQUENTIAL NUMBERS: if there is a calendar or numeric list, numbers must go 1, 2, 3, 4... If 9 appears twice, or a number is out of order, numbers_logical=false.

7. LOGICAL ELEMENT COHERENCE — CRUCIAL CHECK.
   Each visual element in the image must PLAUSIBLY represent what it is supposed to depict according to the narration/prompt. AI generators often produce elements that LOOK like generic shapes/patterns but don't match what they're supposed to be.

   Set elements_logically_coherent=FALSE when you see:
   - "Pressure marks from tight shoes" rendered as ABSTRACT SHAPES (infinity loops ∞, geometric patterns, runes) instead of natural skin indentations
   - "Swelling" rendered as glowing/glowing-red abstract auras instead of natural puffy skin
   - "Lymphatic system" rendered as totally abstract patterns when it should look like vessels
   - "Medicinal herbs" rendered as unrecognizable blobs instead of actual plant leaves
   - "Calendar" rendered as random rectangles instead of grid with day cells
   - "Pills" rendered as featureless ovoid blobs without typical pill characteristics
   - "Wounds/marks/spots" that have GEOMETRIC IMPOSSIBLE shapes instead of natural organic shapes
   - "Mortar and pestle" rendered as random pot when it should be a specific medicinal grinder

   In illogical_elements_description, describe SPECIFICALLY what is wrong: name the element and what it looks like vs what it should look like.

   Set elements_logically_coherent=TRUE when all visual elements are recognizable representations of what they're supposed to depict, even if stylized.

8. BODY PART FUSION — separate check from per-hand/per-foot.
   When TWO hands or TWO feet are visible in the same image, do they exist as SEPARATE bodies, or do they overlap/fuse in impossible ways (e.g., toes from one foot blending into toes of another, ankles merging)?

   Set body_parts_fused=TRUE only when you see CLEAR fusion (an anatomical impossibility where body parts share material that should be separate).
   Set body_parts_fused=FALSE when parts are merely close, overlapping in normal perspective, or one in front of the other.

DEVOLVE EXCLUSIVAMENTE este JSON exacto, sin texto adicional:

{
  "humans_visible": <number>,
  "hand_1_visible": <bool>,
  "hand_1_digits_count": <integer count of VISIBLE digits>,
  "hand_1_fully_unoccluded": <bool: true if hand is in clear view, false if gripping an object or other body part hides some fingers>,
  "hand_1_anatomy_ok": <bool: are visible digits anatomically correct in shape/proportion>,
  "hand_2_visible": <bool>,
  "hand_2_digits_count": <integer>,
  "hand_2_fully_unoccluded": <bool>,
  "hand_2_anatomy_ok": <bool>,
  "foot_1_visible": <bool>,
  "foot_1_toes_count": <integer>,
  "foot_1_size_vs_head": "smaller" | "similar" | "larger" | "no-head-visible",
  "foot_2_visible": <bool>,
  "foot_2_toes_count": <integer>,
  "body_proportions_realistic": <bool>,
  "body_symmetry_ok": <bool>,
  "face_visible": <bool>,
  "face_symmetry_ok": <bool>,
  "face_features_complete": <bool>,
  "text_present": <bool>,
  "text_legible_and_meaningful": <bool>,
  "text_description": "<what text says, or empty>",
  "scene_has_numbers": <bool>,
  "numbers_logical": <bool>,
  "numbers_description": "<what numbers, or empty>",
  "objects_obey_gravity": <bool>,
  "shadows_consistent_with_light": <bool>,
  "perspective_consistent": <bool>,
  "character_matches_profile": "matches" | "mismatches" | "no-character-visible",
  "character_mismatch_reason": "<reason if mismatch, else empty>",
  "image_matches_narration": <bool>,
  "semantic_match_score": <integer 0-100>,
  "elements_logically_coherent": <bool>,
  "illogical_elements_description": "<specific element and what's wrong, or empty>",
  "body_parts_fused": <bool>,
  "body_parts_fused_description": "<which parts fuse and how, or empty>",
  "style_consistent": <bool>,
  "style_notes": "<brief>"
}`;

const ADVERSARIAL_SYSTEM_INSTRUCTION = `You are an ADVERSARIAL REVIEWER, a hyper-detail-oriented critic trained to find AI-gen errors that lenient reviewers miss.

IMPORTANT: Respond in ENGLISH only.

Another reviewer already evaluated this image and gave a preliminary verdict. Your job is to review the image AGAIN with adversarial spirit: find any subtle LOGICAL defect that indicates imperfect AI generation.

CRITICAL DISTINCTION — what counts as a "critical issue" (rejects image) vs "minor issue" (cosmetic, does NOT reject):

CRITICAL ISSUES (verdict = reject) — only these:
- WRONG DIGIT COUNT on a FULLY visible hand: 4 or 6 or 7 fingers when whole hand is in view
- DISTORTED/FUSED VISIBLE DIGITS: fingers melted together, bulbous tips, impossibly long/short fingers
- IMPOSSIBLE ANATOMY: extra limbs (third arm), missing limbs that should be visible, limbs growing from wrong place
- BROKEN PROPORTIONS: feet VISIBLY larger than head, head extremely small for body
- FACE DEFECTS: extra eye, eyes at clearly different heights AND sizes, missing eye when face is in view, mouth in wrong place
- GIBBERISH TEXT prominently displayed on signs/labels/products
- REPEATED/OUT-OF-ORDER NUMBERS in calendars/sequences when clearly meant to be sequential
- WRONG GENDER/ETHNICITY when the script identifies a specific narrator
- SEMANTIC MISMATCH: image shows totally different subject than what the narration describes

MINOR ISSUES (verdict = approve, mention in minorIssues but do NOT reject) — be LENIENT:
- Wardrobe details (casual top vs formal top, color of clothing)
- Eyewear positioning (arm of glasses going over hair vs behind ear)
- Button placement, ribbon position, accessory orientation
- Watch/jewelry minor weirdness
- Slight asymmetry in non-essential features (hair part location, ear visibility)
- Color shading variations
- Background details out of focus
- Style variations (slightly more cartoonish vs more realistic)
- Slight differences from the exact wording of the character card

RULE OF THUMB: would a casual viewer notice this when watching a 2-second cut in a TikTok video? If no → minor. If yes (like "that hand has 6 fingers!" or "the text is gibberish!") → critical.

Defects to actively search for:
1. FINGERS: count them. Each hand should have 5 (1 thumb + 4 fingers). DO NOT trust the previous reviewer — count YOURSELF.
2. TOES: count each visible toe. 5 per foot.
3. PROPORTIONS: feet larger than head, hands the size of the face, tiny head on big body.
4. FACIAL SYMMETRY: eyes at different heights, different sizes, third "eye-like" feature.
5. GIBBERISH TEXT: even if letters form, do they form REAL words? If it says "ímrnn" or "wlse caso" = gibberish.
6. REPEATED OR OUT-OF-ORDER NUMBERS in calendars/lists.
7. EXTRA LIMBS or LIMBS THAT FUSE INTO OTHER LIMBS.
8. WRONG NARRATOR GENDER (script says male doctor, image shows woman).

Return EXCLUSIVELY JSON with this shape:
{
  "criticalIssuesFound": [
    "<specific description of the critical defect>",
    ...
  ],
  "minorIssues": [
    "<minor imperfections that do not disqualify>"
  ],
  "adversarialScore": <integer 0-100, where 100 = flawless image>,
  "verdict": "approve" | "reject",
  "refinementHint": "<if reject, CONCRETE and actionable instruction to regenerate; if approve, null>"
}

verdict="reject" ONLY when criticalIssuesFound contains AT LEAST ONE issue from the CRITICAL list. Otherwise verdict="approve" — premium ads need to ship; we cannot loop forever on cosmetic variations.`;

export class SceneValidatorV3 {
  private readonly client: GeminiVisionClient | null;
  private readonly model: string;

  constructor(opts: { client?: GeminiVisionClient; model?: string } = {}) {
    const apiKey = process.env['GOOGLE_AI_API_KEY'];
    this.client = opts.client ?? (apiKey ? new GeminiVisionClient({ apiKey }) : null);
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async validate(input: ValidationV3Input): Promise<V3ValidationResult> {
    if (!this.client) {
      throw new Error('SceneValidatorV3: GOOGLE_AI_API_KEY no configurada.');
    }

    // PANEL DE ESPECIALISTAS EN PARALELO — 7 llamadas Gemini concurrentes.
    // Wall-clock: max(structured, anatomy×2, narrative-fit, real-world, ai-artifact) ≈ 5-6s.
    //
    // Composición del panel:
    //   1× cuestionario estructurado (high-recall machine-readable checks)
    //   2× anatomy specialist (consensus voting expandido: hands+feet+eyes+ears+teeth+hair+limbs+neck+body)
    //   1× narrative-fit specialist (focal point, scale, sujeto, contradicciones con narración)
    //   1× real-world coherence specialist (física, escala entre objetos, anacronismos, "esto no va aquí")
    //   1× ai-artifact specialist (fusiones, simetrías imposibles, blobs, gibberish)
    //
    // Aggregación:
    //   - Cualquier especialista verdict="reject" con razón clara → REGENERATE (con refinement hint combinado)
    //   - Si solo el estructurado falla pero los otros aprueban → confiar en los especialistas (approve si score ≥ minPassScore)
    //   - En fastMode: skip adversarial pero MANTENER todos los especialistas (eran el bottleneck antes; ahora corren paralelos)
    const structuredPrompt = this.buildStructuredPrompt(input);
    const [
      structuredOutcome,
      anatomyOutcome,
      narrativeOutcome,
      realWorldOutcome,
      aiArtifactOutcome,
    ] = await Promise.all([
      this.client
        .generateJson<V3StructuredAnswers>({
          imageBuffer: input.imageBuffer,
          mimeType: 'image/png',
          prompt: structuredPrompt,
          systemInstruction: STRUCTURED_SYSTEM_INSTRUCTION,
          model: this.model,
        })
        .then((value) => ({ ok: true as const, value }))
        .catch((e: unknown) => ({ ok: false as const, error: e })),
      this.anatomyVotingPass(input.imageBuffer)
        .then((value) => ({ ok: true as const, value }))
        .catch((e: unknown) => ({ ok: false as const, error: e })),
      this.narrativeFitPass(input.imageBuffer, input.text, input.imagePrompt)
        .then((value) => ({ ok: true as const, value }))
        .catch((e: unknown) => ({ ok: false as const, error: e })),
      this.realWorldCoherencePass(input.imageBuffer, input.text)
        .then((value) => ({ ok: true as const, value }))
        .catch((e: unknown) => ({ ok: false as const, error: e })),
      this.aiArtifactPass(input.imageBuffer)
        .then((value) => ({ ok: true as const, value }))
        .catch((e: unknown) => ({ ok: false as const, error: e })),
    ]);

    if (!structuredOutcome.ok) {
      const message =
        structuredOutcome.error instanceof GeminiVisionApiError
          ? structuredOutcome.error.message
          : (structuredOutcome.error as Error)?.message ?? String(structuredOutcome.error);
      return {
        verdict: 'pass',
        score: 0,
        issues: [`structured-validator-error: ${message}`],
        refinementHint: null,
        reasoning: 'Falla del cuestionario estructurado, no se bloquea el pipeline.',
        structuredAnswers: null,
      };
    }
    const answers = structuredOutcome.value;

    // Análisis determinístico del cuestionario
    const detResult = analyzeStructuredAnswers(answers, input);

    // Anatomy vote: aplicar SOLO si structured detectó humanos + hands/feet visibles
    // (evita falsos positivos en paisajes / objetos puros).
    if (
      anatomyOutcome.ok &&
      answers.humans_visible > 0 &&
      (answers.hand_1_visible || answers.foot_1_visible || answers.face_visible)
    ) {
      const av = anatomyOutcome.value;
      if (!av.handsOk || !av.feetOk || av.reasons.length > 0) {
        detResult.issues.push(...av.reasons.map((r) => `[anatomy-panel] ${r}`));
        detResult.refinementHint =
          (detResult.refinementHint ? detResult.refinementHint + ' ' : '') +
          `Fix anatomical defects detected by independent specialists: ${av.reasons.slice(0, 4).join('; ')}.`;
        detResult.score = Math.max(0, detResult.score - 20);
        detResult.severity = 'critical';
      }
    }

    // Veredictos de los nuevos especialistas (narrative-fit, real-world, ai-artifact)
    const specialistVerdicts: SpecialistVerdict[] = [];
    const collectSpecialist = (
      outcome:
        | { ok: true; value: SpecialistVerdict }
        | { ok: false; error: unknown },
    ): void => {
      if (outcome.ok) specialistVerdicts.push(outcome.value);
    };
    collectSpecialist(narrativeOutcome);
    collectSpecialist(realWorldOutcome);
    collectSpecialist(aiArtifactOutcome);

    // Aggregar veredictos: cualquier specialist con verdict="reject" cuenta como crítico.
    // Hints de refinamiento de specialists que rechazaron se combinan.
    const rejectedSpecialists = specialistVerdicts.filter((s) => s.verdict === 'reject');
    if (rejectedSpecialists.length > 0) {
      for (const s of rejectedSpecialists) {
        detResult.issues.push(...s.issues.map((i) => `[${s.name}] ${i}`));
        if (s.refinementHint) {
          detResult.refinementHint =
            (detResult.refinementHint ? detResult.refinementHint + ' ' : '') +
            `[${s.name}] ${s.refinementHint}`;
        }
      }
      // Score blend: el más bajo gana (cualquier defecto crítico arrastra)
      const minSpecialistScore = Math.min(...specialistVerdicts.map((s) => s.score));
      detResult.score = Math.min(detResult.score, minSpecialistScore);
      detResult.severity = 'critical';
    } else if (specialistVerdicts.length > 0) {
      // Todos aprobaron: el score final es el MÍNIMO entre structured y specialists.
      // Esto previene que un "approve marginal" (score 60) cuele cuando otro especialista
      // está más conservador.
      const minSpecialistScore = Math.min(...specialistVerdicts.map((s) => s.score));
      detResult.score = Math.min(detResult.score, minSpecialistScore);
    }

    // Si llegamos a critical, retornar sin gastar adversarial.
    if (detResult.severity === 'critical') {
      return {
        verdict: 'regenerate',
        score: detResult.score,
        issues: detResult.issues,
        refinementHint: detResult.refinementHint,
        reasoning: `Panel de especialistas detectó fallas críticas: ${[
          ...specialistVerdicts.filter((s) => s.verdict === 'reject').map((s) => s.name),
          detResult.issues.find((i) => i.includes('[anatomy-panel]')) ? 'anatomy' : null,
        ].filter(Boolean).join(', ')}`,
        structuredAnswers: answers,
        specialistVerdicts,
      };
    }

    // PASS 2: Adversarial — solo se gasta cuando el resultado es AMBIGUO (score 70-79).
    // Si todo está claramente OK (≥80) o claramente mal (≤69), no aporta.
    // En fastMode también skip.
    const ambiguous = detResult.score >= 70 && detResult.score < 80;
    if (input.fastMode || !ambiguous) {
      const passed = detResult.severity === 'none' && detResult.score >= 75;
      return {
        verdict: passed ? 'pass' : 'regenerate',
        score: detResult.score,
        issues: detResult.issues,
        refinementHint: detResult.refinementHint,
        reasoning: `Panel completo + structured. Score=${detResult.score}. ${passed ? 'Pass.' : 'Score insuficiente o issues menores.'}`,
        structuredAnswers: answers,
        specialistVerdicts,
      };
    }
    let adversarialResult: AdversarialResult;
    try {
      const handsExpected = (answers.hand_1_visible || answers.hand_2_visible) ? 'YES — at least one hand is visible in this image' : 'no hands visible';
      const adversarialPrompt = `PREVIOUS EVALUATION: the structured reviewer scored ${detResult.score} and found these issues: ${detResult.issues.join(', ') || '(none)'}.
Hands visible per structured reviewer: ${handsExpected}.

Now apply your adversarial gaze. This image will appear in a premium published ad — visible AI-gen errors are unacceptable.

EXTRA SKEPTICISM CHECKLIST (the previous reviewer may have missed these — they are AI's weakest areas):
1. HANDS: if hands are visible, re-count digits MENTALLY: thumb, 1, 2, 3, 4. Are there exactly 4 fingers + 1 thumb per fully-visible hand? Look for: extra digits, fused digits, impossibly long thumb, thumb on wrong side, missing digit blending into another.
2. FACE: third eye, mismatched eye sizes, mouth in wrong position.
3. TEXT: re-read every visible word. Are they REAL words or random letter strings (e.g., "Vrexliy", "ainot")?
4. NUMBERS: if there's a calendar or numeric display, are the numbers in correct sequential order without repeats?
5. ANATOMY OF PARTIAL FIGURES: even if you can see only part of a body, check whether visible parts have correct proportions.

Narrated text for context: "${input.text}"
${input.narratorProfile?.characterCard ? `\nThe character (if visible) should match: "${input.narratorProfile.characterCard}". Focus on fundamental traits (gender, ethnicity, age) — not minor wardrobe details.` : ''}

Report ANY defect that meets the CRITICAL list. Be lenient on minor cosmetic variations.`;

      adversarialResult = await this.client.generateJson<AdversarialResult>({
        imageBuffer: input.imageBuffer,
        mimeType: 'image/png',
        prompt: adversarialPrompt,
        systemInstruction: ADVERSARIAL_SYSTEM_INSTRUCTION,
        model: this.model,
      });
    } catch (e) {
      // Si adversarial falla, devolvemos lo del panel de especialistas
      const sev = detResult.severity as 'none' | 'minor' | 'critical';
      return {
        verdict: sev === 'none' && detResult.score >= 75 ? 'pass' : 'regenerate',
        score: detResult.score,
        issues: detResult.issues,
        refinementHint: detResult.refinementHint,
        reasoning: `Adversarial falló: ${(e as Error).message}. Usando panel de especialistas.`,
        structuredAnswers: answers,
        specialistVerdicts,
      };
    }

    // AGGREGATE — combinamos structured + panel + adversarial
    const adversarialIssues = adversarialResult.criticalIssuesFound ?? [];
    const allIssues = [...detResult.issues, ...adversarialIssues];
    const aggregatedScore = Math.min(
      detResult.score,
      adversarialResult.adversarialScore ?? 50,
    );

    // Verdict: pass solo si TODO el ensemble aprueba y score >= 75
    const allApprove =
      detResult.severity === 'none' &&
      adversarialResult.verdict === 'approve' &&
      specialistVerdicts.every((s) => s.verdict === 'approve') &&
      aggregatedScore >= 75;
    const verdict: V3Verdict = allApprove ? 'pass' : 'regenerate';

    const refinementHint = adversarialResult.refinementHint ?? detResult.refinementHint;

    return {
      verdict,
      score: aggregatedScore,
      issues: allIssues,
      refinementHint,
      reasoning:
        verdict === 'pass'
          ? `Ensemble aprobó: structured=${detResult.score}, adversarial=${adversarialResult.adversarialScore}, specialists=[${specialistVerdicts.map((s) => `${s.name}:${s.score}`).join(',')}]`
          : `Rechazado por ensemble. Structured: ${detResult.issues.slice(0, 2).join(', ') || 'ok'}. Adversarial: ${adversarialIssues.slice(0, 2).join(', ') || 'rejected'}.`,
      structuredAnswers: answers,
      adversarialCritique: adversarialResult.criticalIssuesFound?.join(' | '),
      specialistVerdicts,
    };
  }

  private async anatomyVotingPass(imageBuffer: Buffer): Promise<{ handsOk: boolean; feetOk: boolean; reasons: string[] }> {
    if (!this.client) throw new Error('client unavailable');
    // Anatomía EXPANDIDA: ahora cubre hands, feet, eyes, ears, teeth, hair,
    // joints, limbs. Dos llamadas independientes que votan; consensus failure
    // = critical. El "specialist panel" más grande corre en runComprehensivePanel.
    const specialistPrompt = `You are a FULL-BODY ANATOMY SPECIALIST. Examine this image for anatomical errors across ALL visible body parts. Be PRECISE — only flag DEFINITIVE defects, not occlusion or stylistic choices.

GLOBAL RULES:
1. PART NOT VISIBLE → perfect=true (nothing to check).
2. PART PARTIALLY OCCLUDED → perfect=true UNLESS the visible portion has a clear defect.
3. STYLIZED ILLUSTRATION (watercolor, comic, cartoon) → judge stylistic anatomy lenient; flag only when DEFINITIVELY broken (extra fingers, fused, melted features).
4. CLOSE-UPS → body proportions = true automatically (cannot assess).
5. When in doubt → perfect=true. We want HIGH PRECISION (no false positives), HIGH RECALL on clear defects only.

PER-PART CHECKLIST:

HANDS (fully visible only):
  Count digits: 1 thumb + 4 fingers = 5 per hand
  Verify: separated, natural lengths (pinky shortest, middle longest), no fusion, no impossible bends, no extra digits.

FEET (fully visible only):
  Count toes: 1 big toe + 4 smaller = 5 per foot
  Verify: separated, big toe in correct position, no fusion.

EYES (face visible):
  Count: exactly 2 eyes on faces (humans/anthropomorphic characters)
  Verify: same vertical level, similar size, no third eye, no impossible eye-on-cheek placement, both pupils where expected.

EARS (face/head visible):
  Count: 0 ears (if hidden by hair/hat) OR 2 ears (matching pose)
  Verify: positioned on sides of head, not protruding from cheek/neck/forehead.

TEETH (mouth open enough to see):
  Verify: normal count (no excessive rows, no impossible gaps), aligned, normal shape (no melting).

HAIR:
  Verify: distinct hairline (no fusion with face/shoulders/background), natural strands (not melted into solid mass), realistic flow.

LIMBS (full or partial body):
  Count: 2 arms + 2 legs for humans (matching pose; if one is occluded by perspective, that's OK).
  Verify: joints in normal positions (shoulders, elbows, wrists, hips, knees, ankles), no tube-bend, no extra/missing limb, no limbs growing from wrong place (e.g., arm from hip).

NECK / HEAD:
  Verify: single head, neck connects to torso naturally, not impossibly long/short or detached.

BODY PROPORTIONS (full body visible):
  Verify: head ~1/7 to 1/8 of body height, feet smaller than head, no comically distorted scale.

Return EXCLUSIVELY this JSON in English:
{
  "hands_perfect": <bool>,
  "hands_reason": "<empty or specific defect>",
  "feet_perfect": <bool>,
  "feet_reason": "<empty or specific defect>",
  "eyes_perfect": <bool>,
  "eyes_reason": "<empty or specific defect>",
  "ears_perfect": <bool>,
  "ears_reason": "<empty or specific defect>",
  "teeth_perfect": <bool>,
  "teeth_reason": "<empty or specific defect or not-visible>",
  "hair_perfect": <bool>,
  "hair_reason": "<empty or specific defect>",
  "limbs_perfect": <bool>,
  "limbs_reason": "<empty or specific defect>",
  "neck_head_perfect": <bool>,
  "neck_head_reason": "<empty or specific defect>",
  "body_proportions_perfect": <bool>,
  "body_reason": "<empty or specific defect; for close-ups: 'body not fully visible — close-up composition, OK by default'>"
}`;

    type AnatomySpecialistResult = {
      hands_perfect: boolean; hands_reason: string;
      feet_perfect: boolean; feet_reason: string;
      eyes_perfect?: boolean; eyes_reason?: string;
      ears_perfect?: boolean; ears_reason?: string;
      teeth_perfect?: boolean; teeth_reason?: string;
      hair_perfect?: boolean; hair_reason?: string;
      limbs_perfect?: boolean; limbs_reason?: string;
      neck_head_perfect?: boolean; neck_head_reason?: string;
      body_proportions_perfect: boolean; body_reason: string;
    };

    const callOnce = () =>
      this.client!.generateJson<AnatomySpecialistResult>({
        imageBuffer,
        mimeType: 'image/png',
        prompt: 'Apply your full-body anatomy specialist drill. Return JSON only.',
        systemInstruction: specialistPrompt,
        model: this.model,
      });

    // 2 llamadas en paralelo (voting independiente)
    const [r1, r2] = await Promise.all([callOnce(), callOnce()]);

    // Consensus rule: SOLO marcar falla cuando AMBOS evaluadores dicen perfect=false.
    // Esto evita falsos positivos (un evaluador ruidoso) y mantiene high precision.
    const reasons: string[] = [];
    const consensusFalse = <K extends keyof AnatomySpecialistResult>(
      ok: K,
      reason: K,
      label: string,
    ): boolean => {
      const a = r1[ok] as boolean | undefined;
      const b = r2[ok] as boolean | undefined;
      if (a === false && b === false) {
        const msg = (r1[reason] as string | undefined) || (r2[reason] as string | undefined) || `${label} issue`;
        reasons.push(`${label}: ${msg}`);
        return true;
      }
      return false;
    };

    const handsFail = consensusFalse('hands_perfect', 'hands_reason', 'hands');
    const feetFail = consensusFalse('feet_perfect', 'feet_reason', 'feet');
    consensusFalse('eyes_perfect', 'eyes_reason', 'eyes');
    consensusFalse('ears_perfect', 'ears_reason', 'ears');
    consensusFalse('teeth_perfect', 'teeth_reason', 'teeth');
    consensusFalse('hair_perfect', 'hair_reason', 'hair');
    consensusFalse('limbs_perfect', 'limbs_reason', 'limbs');
    consensusFalse('neck_head_perfect', 'neck_head_reason', 'neck/head');
    const bodyFail = consensusFalse('body_proportions_perfect', 'body_reason', 'body proportions');

    return {
      handsOk: !handsFail && !bodyFail,
      feetOk: !feetFail && !bodyFail,
      reasons,
    };
  }

  // ===========================================================================
  // PASS 1.6 — NARRATIVE FIT SPECIALIST
  // Juzga si la imagen CUENTA la historia que el narrador dice: focal point,
  // composición, escala, sujeto correcto. Esta es la pieza "esto no va aquí"
  // que el cuestionario estructurado puede pasar por alto.
  // ===========================================================================
  private async narrativeFitPass(
    imageBuffer: Buffer,
    sceneText: string,
    imagePrompt: string,
  ): Promise<SpecialistVerdict> {
    if (!this.client) throw new Error('client unavailable');
    const systemInstruction = `You are a STORY-TELLING REVIEWER for vertical short-form video ads. Judge whether THIS image — as a whole — faithfully serves the narrated text. NOT just "does the image relate to the text" — does it CONVEY the specific moment of the story.

CHECK THESE QUESTIONS, IN ORDER:
1. SUBJECT MATCH: is the visible main subject what the narration is describing right now? If the narration says "her face is puffy" and the image shows full body with face tiny, that's a MISMATCH (focal point wrong).
2. FOCAL POINT: where does the eye go in this image? Is that what the narrator is highlighting? If the narration emphasizes a hand gesture but the image emphasizes the background, MISMATCH.
3. SCALE: are key elements at appropriate size? A product mentioned by name should not be a tiny dot in the corner. A character described in detail should not be in distant background.
4. COMPOSITION: does the framing match the scene's weight (close-up for intimate, wide for context)? Vertical 9:16 frame must be USED — not wasted with empty top/bottom thirds.
5. MOOD: does the visual mood match the narration tone? Tired/swollen → muted warm. Triumphant → bright open. Anxious → tight close-up.
6. CONTRADICTION: does anything VISUALLY CONTRADICT the narration? Narration says "before" but image shows result, narration says "tired" but face is smiling, narration says "swollen feet" but feet look normal.

BE LENIENT for: stylistic choices (watercolor vs photo), background variations, minor framing differences.
BE STRICT for: focal point misses, scale wrong (product invisible), contradictions, off-topic subject.

Return EXCLUSIVELY this JSON in English:
{
  "score": <integer 0-100>,
  "subject_matches": <bool>,
  "focal_point_correct": <bool>,
  "scale_appropriate": <bool>,
  "composition_uses_frame": <bool>,
  "mood_matches": <bool>,
  "contradicts_narration": <bool>,
  "issues": ["<specific issue text>", ...],
  "verdict": "approve" | "reject",
  "refinement_hint": "<concrete actionable fix as a NEW image prompt direction, or empty if approve>"
}
verdict="reject" ONLY when at least one critical signal is true: subject_matches=false OR contradicts_narration=true OR score<55. Else "approve".`;

    const userPrompt = `NARRATION (this is what is being spoken DURING this image):
"${sceneText}"

ORIGINAL IMAGE PROMPT (what the AI was asked to draw):
"${imagePrompt.slice(0, 400)}..."

Judge the image. Return JSON only.`;

    type R = {
      score: number;
      subject_matches: boolean;
      focal_point_correct: boolean;
      scale_appropriate: boolean;
      composition_uses_frame: boolean;
      mood_matches: boolean;
      contradicts_narration: boolean;
      issues: string[];
      verdict: 'approve' | 'reject';
      refinement_hint: string;
    };
    const r = await this.client.generateJson<R>({
      imageBuffer,
      mimeType: 'image/png',
      prompt: userPrompt,
      systemInstruction,
      model: this.model,
    });
    return {
      name: 'narrative-fit',
      score: r.score,
      verdict: r.verdict === 'reject' ? 'reject' : 'approve',
      issues: r.issues ?? [],
      refinementHint: r.refinement_hint ?? null,
    };
  }

  // ===========================================================================
  // PASS 1.7 — REAL-WORLD COHERENCE SPECIALIST
  // Física, escala, contexto, anacronismos. "Esto no tiene sentido aquí".
  // ===========================================================================
  private async realWorldCoherencePass(
    imageBuffer: Buffer,
    sceneText: string,
  ): Promise<SpecialistVerdict> {
    if (!this.client) throw new Error('client unavailable');
    const systemInstruction = `You are a REAL-WORLD LOGIC CHECKER. Your job is to flag elements that DON'T BELONG or DON'T MAKE SENSE in the image — the kind a human would point at and say "that doesn't fit here".

CHECK THESE 6 CATEGORIES:
1. PHYSICS: are objects on solid ground, or floating without explanation? Defying gravity? Water flowing uphill? An object resting on nothing?
2. SCALE COHERENCE BETWEEN OBJECTS: is the chair appropriately sized for a person? Is the bottle the right size for the hand holding it? Is the calendar wall-sized when it should be desk-sized?
3. ERA / CONTEXT: anachronism present? Smartphone in a 1800s scene? Modern object in a traditional Japanese temple? Out-of-time element?
4. PLACEMENT LOGIC: is each object in a reasonable location? A book floating in air outside a shelf, a kettle hovering over the stove with nothing supporting it, a chair tipped at impossible angle.
5. INTER-OBJECT COHERENCE: do objects make sense together? Apple sitting on bookshelf is fine. Apple inside locked safe with no opening = weird.
6. SPATIAL LOGIC: does light source match shadows? Is perspective consistent (one vanishing point per plane)? Are reflections plausible?

IMPORTANT — be context-aware:
- Stylized illustrations (watercolor, comic) can take liberties — flag only when CLEARLY broken physics, not artistic style.
- Symbolic compositions (hourglass next to face, abstract anatomy diagram) are OK — they're metaphorical.
- Anachronisms only matter when the scene is anchored to a specific era.

Return EXCLUSIVELY this JSON in English:
{
  "score": <integer 0-100>,
  "physics_ok": <bool>,
  "scale_coherent": <bool>,
  "era_consistent": <bool>,
  "placement_logical": <bool>,
  "objects_coherent_together": <bool>,
  "spatial_logic_ok": <bool>,
  "issues": ["<specific 'X doesn't belong because Y'>", ...],
  "verdict": "approve" | "reject",
  "refinement_hint": "<actionable fix or empty>"
}
verdict="reject" ONLY when AT LEAST ONE category fails with a CLEAR violation (not stylistic).`;

    const userPrompt = `NARRATION CONTEXT (for understanding the scene intent):
"${sceneText}"

Apply your real-world logic check. Return JSON only.`;

    type R = {
      score: number;
      physics_ok: boolean;
      scale_coherent: boolean;
      era_consistent: boolean;
      placement_logical: boolean;
      objects_coherent_together: boolean;
      spatial_logic_ok: boolean;
      issues: string[];
      verdict: 'approve' | 'reject';
      refinement_hint: string;
    };
    const r = await this.client.generateJson<R>({
      imageBuffer,
      mimeType: 'image/png',
      prompt: userPrompt,
      systemInstruction,
      model: this.model,
    });
    return {
      name: 'real-world',
      score: r.score,
      verdict: r.verdict === 'reject' ? 'reject' : 'approve',
      issues: r.issues ?? [],
      refinementHint: r.refinement_hint ?? null,
    };
  }

  // ===========================================================================
  // PASS 1.8 — AI ARTIFACT DETECTOR
  // Patrones típicos de imágenes mal generadas: fusiones, simetrías imposibles,
  // blobs abstractos donde debería haber objetos reales, gibberish text.
  // ===========================================================================
  private async aiArtifactPass(imageBuffer: Buffer): Promise<SpecialistVerdict> {
    if (!this.client) throw new Error('client unavailable');
    const systemInstruction = `You are an AI-GENERATION ARTIFACT DETECTOR. Identify defects that betray the image as "AI-generated and broken" — the kind a careful viewer would notice and judge as low quality.

CHECK THESE 7 ARTIFACT TYPES:
1. MELTED / DRIPPING FORMS: solid objects (table, bottle, fabric) with drippy/wax-like edges that defy material physics.
2. FUSED OBJECTS: two distinct objects that share material in impossible ways (two cups blending, a hand fused with a face, fingers melting into a phone).
3. REPEATING / DUPLICATE BACKGROUND: same face/object appearing 2+ times in background where it shouldn't (clone artifact).
4. IMPOSSIBLE SYMMETRY: features that are mirror-perfect when reality has natural asymmetry (eyes perfectly identical, hair flowing the same on both sides like a stamp).
5. ABSTRACT BLOBS WHERE REAL OBJECTS BELONG: pills shown as featureless ovoids, calendar as colored rectangles with no grid, leaves as amorphous blobs, lymph nodes as random circles, etc. Things the prompt asked for as RECOGNIZABLE but rendered as generic shapes.
6. GIBBERISH TEXT: signs/labels/calendars showing letter-like shapes that DON'T form real words (e.g., "Vrexliy", "ímrnn"). Calendars with non-sequential or repeating numbers.
7. EDGE FAILURES: object outlines fading into the background, broken silhouettes, missing limbs that should be there per the pose.

BE STRICT — these are the artifacts users notice and judge as "amateur AI image".
BE LENIENT for: artistic style (impressionist brushstrokes are NOT melting), legitimate symmetry (a perfectly composed product shot), abstract art when prompt called for it.

Return EXCLUSIVELY this JSON in English:
{
  "score": <integer 0-100>,
  "melted_forms": <bool>,
  "fused_objects": <bool>,
  "duplicate_background": <bool>,
  "impossible_symmetry": <bool>,
  "abstract_blobs_instead_of_objects": <bool>,
  "gibberish_text": <bool>,
  "edge_failures": <bool>,
  "issues": ["<specific artifact: where and what>", ...],
  "verdict": "approve" | "reject",
  "refinement_hint": "<actionable fix or empty>"
}
verdict="reject" when AT LEAST ONE artifact type is CLEARLY present.`;

    type R = {
      score: number;
      melted_forms: boolean;
      fused_objects: boolean;
      duplicate_background: boolean;
      impossible_symmetry: boolean;
      abstract_blobs_instead_of_objects: boolean;
      gibberish_text: boolean;
      edge_failures: boolean;
      issues: string[];
      verdict: 'approve' | 'reject';
      refinement_hint: string;
    };
    const r = await this.client.generateJson<R>({
      imageBuffer,
      mimeType: 'image/png',
      prompt: 'Apply your AI artifact detector. Return JSON only.',
      systemInstruction,
      model: this.model,
    });
    return {
      name: 'ai-artifact',
      score: r.score,
      verdict: r.verdict === 'reject' ? 'reject' : 'approve',
      issues: r.issues ?? [],
      refinementHint: r.refinement_hint ?? null,
    };
  }

  private buildStructuredPrompt(input: ValidationV3Input): string {
    return `EVALUÁ ESTA IMAGEN respondiendo el cuestionario estructurado en JSON.

Texto que se narra en esta escena:
"${input.text}"

Prompt usado para generar la imagen:
"${input.imagePrompt.slice(0, 500)}..."

${input.narratorProfile?.characterCard ? `El personaje del narrador (si aparece en esta escena) debería coincidir con esta descripción:\n"${input.narratorProfile.characterCard}"\n` : ''}
${input.styleBase ? `Estilo visual esperado: ${input.styleBase}\n` : ''}

Aplicá las REGLAS ABSOLUTAS del system instruction. Contá explícitamente, no estimes.`;
  }
}

// ===========================================================================
// Análisis determinístico del cuestionario
// ===========================================================================

interface DeterministicResult {
  severity: 'none' | 'minor' | 'critical';
  score: number;
  issues: string[];
  refinementHint: string | null;
}

function analyzeStructuredAnswers(a: V3StructuredAnswers, input: ValidationV3Input): DeterministicResult {
  const issues: string[] = [];
  const refinementHints: string[] = [];
  let score = 100;
  let critical = false;

  // HANDS — distinguir entre "anatomía mala" (error) y "oclusión natural" (ok)
  if (a.hand_1_visible) {
    if (a.hand_1_fully_unoccluded && a.hand_1_digits_count !== 5) {
      // Mano completamente visible pero con conteo incorrecto = ERROR ANATÓMICO
      issues.push(`hand_1 has ${a.hand_1_digits_count} digits (must be 5) — hand is fully visible so this is anatomically wrong`);
      refinementHints.push(
        'Each fully-visible hand MUST show exactly 5 separate digits: 1 thumb on the side, plus 4 fingers. Draw the hand from an angle where all 5 are visible and clearly distinct, not fused.',
      );
      critical = true;
      score -= 35;
    }
    if (!a.hand_1_anatomy_ok) {
      // Anatomía mal independiente de oclusión
      issues.push('hand_1 anatomy issue (fusion, distortion, wrong digit proportions)');
      refinementHints.push('Redraw hand with anatomically correct proportions: each finger separate, joints natural, correct lengths.');
      critical = true;
      score -= 25;
    }
  }
  if (a.hand_2_visible) {
    if (a.hand_2_fully_unoccluded && a.hand_2_digits_count !== 5) {
      issues.push(`hand_2 has ${a.hand_2_digits_count} digits (must be 5) — hand is fully visible`);
      refinementHints.push(
        'The second hand also MUST show exactly 5 separate digits when fully visible.',
      );
      critical = true;
      score -= 35;
    }
    if (!a.hand_2_anatomy_ok) {
      issues.push('hand_2 anatomy issue');
      critical = true;
      score -= 25;
    }
  }

  // FEET
  if (a.foot_1_visible) {
    if (a.foot_1_toes_count !== 5) {
      issues.push(`foot_1 has ${a.foot_1_toes_count} toes (must be 5)`);
      refinementHints.push('Each visible foot MUST show exactly 5 toes (big toe + 4 smaller toes). Separate and distinct.');
      critical = true;
      score -= 30;
    }
    if (a.foot_1_size_vs_head === 'larger') {
      issues.push('foot_1 is LARGER than the head — body proportions broken');
      refinementHints.push(
        'CRITICAL: Feet must be SMALLER than the head. Redraw with realistic human proportions where the head is ~1/7 of body height and feet are ~1/7 of body height (so head and foot are similar size, NEVER feet larger than head).',
      );
      critical = true;
      score -= 30;
    }
  }
  if (a.foot_2_visible && a.foot_2_toes_count !== 5) {
    issues.push(`foot_2 has ${a.foot_2_toes_count} toes (must be 5)`);
    critical = true;
    score -= 30;
  }

  // BODY PROPORTIONS
  if (!a.body_proportions_realistic && a.humans_visible > 0) {
    issues.push('body proportions are not realistic');
    refinementHints.push(
      'Body proportions must be realistic: head is approximately 1/7 to 1/8 of the total body height, shoulders are 2-3 head widths wide, arms reach mid-thigh when extended.',
    );
    score -= 25;
    critical = true;
  }
  if (!a.body_symmetry_ok && a.humans_visible > 0) {
    issues.push('body symmetry issue (extra/missing limbs or distortion)');
    score -= 30;
    critical = true;
  }

  // FACE
  if (a.face_visible) {
    if (!a.face_symmetry_ok) {
      issues.push('face symmetry issue (eyes asymmetric, mouth crooked, etc.)');
      refinementHints.push('Face must be symmetric: both eyes same size and same vertical level, nose centered, mouth aligned.');
      score -= 25;
      critical = true;
    }
    if (!a.face_features_complete) {
      issues.push('face features incomplete (missing eye, mouth, etc.)');
      score -= 30;
      critical = true;
    }
  }

  // TEXT
  if (a.text_present && !a.text_legible_and_meaningful) {
    issues.push(`text in image is gibberish or illegible: "${a.text_description.slice(0, 50)}"`);
    refinementHints.push(
      'Remove or simplify text in the image. AI generation cannot reliably produce coherent text. Either remove text entirely, or use ONLY a single short brand word like "VITALY" with no secondary text.',
    );
    score -= 20;
  }

  // NUMBERS
  if (a.scene_has_numbers && !a.numbers_logical) {
    issues.push(`numbers in scene are illogical: "${a.numbers_description.slice(0, 80)}"`);
    refinementHints.push(
      'If the scene needs to show numbers (dates, calendar), draw them schematically without specific numeric labels. AI cannot reliably produce sequential numbers.',
    );
    score -= 20;
  }

  // PHYSICS
  if (!a.objects_obey_gravity) {
    issues.push('objects floating without support / defying gravity');
    score -= 15;
  }
  if (!a.shadows_consistent_with_light) {
    issues.push('shadows inconsistent with light source');
    score -= 10;
  }
  if (!a.perspective_consistent) {
    issues.push('perspective broken / multiple vanishing points');
    score -= 15;
  }

  // CHARACTER MATCH — solo aplica cuando la ESCENA muestra al narrador.
  // El narratorProfile describe SOLO al narrador (ej. Dr. Sato). Pero hay escenas
  // que muestran OTROS personajes (ej. la paciente). Detectamos cuál es cuál
  // mirando el imagePrompt: si menciona al narrador (gender keywords + character
  // traits), entonces validamos match. Si no, esta escena muestra a otro
  // personaje y no aplica el narratorProfile.
  const promptLc = input.imagePrompt.toLowerCase();
  const narratorMentioned =
    input.narratorProfile?.narratorPresent &&
    input.narratorProfile.characterCard &&
    (() => {
      const card = input.narratorProfile!.characterCard!.toLowerCase();
      const cardKeywords = card.match(/\b(japanese|asian|latino|european|african|monk|doctor|dr\.|specialist|elder|wise|man|woman|male|female|señor|señora|mujer|hombre)\b/g) ?? [];
      return cardKeywords.some((kw) => promptLc.includes(kw));
    })();

  if (a.character_matches_profile === 'mismatches' && narratorMentioned) {
    const reason = (a.character_mismatch_reason ?? '').toLowerCase();
    const fundamentalMismatch =
      reason.includes('gender') ||
      reason.includes('woman') ||
      reason.includes('man') ||
      reason.includes('female') ||
      reason.includes('male') ||
      reason.includes('ethnic') ||
      reason.includes('age') ||
      reason.includes('asian') ||
      reason.includes('latino') ||
      reason.includes('european') ||
      reason.includes('african');
    if (fundamentalMismatch) {
      issues.push(`fundamental character mismatch: ${a.character_mismatch_reason}`);
      refinementHints.push(
        `The character must match: "${input.narratorProfile?.characterCard ?? '(no characterCard)'}". Currently fundamental traits (gender/ethnicity/age) do not match.`,
      );
      score -= 30;
      critical = true;
    } else {
      // Wardrobe/styling: mention but don't block
      issues.push(`minor character variation: ${a.character_mismatch_reason}`);
      score -= 8;
    }
  }

  // SEMANTIC — en fastMode es más permisivo (no forza regen por mismatch ambiguo).
  // En modo normal: critical si no match. Es la causa #1 de retries que NO mejoran
  // (Gemini Vision puede ser muy estricto con escenas metafóricas/conceptuales).
  if (!a.image_matches_narration) {
    issues.push('image does not match the narrated text semantically');
    refinementHints.push(
      `The image must visually represent what is being narrated: "${input.text}". Currently the image shows something disconnected.`,
    );
    if (input.fastMode) {
      // fastMode: solo penaliza score, no forza regen
      score -= 15;
    } else {
      score -= 30;
      critical = true;
    }
  } else if (a.semantic_match_score < 70) {
    issues.push(`weak semantic match (score=${a.semantic_match_score})`);
    score -= input.fastMode ? 5 : 15;
  }

  // LOGICAL ELEMENT COHERENCE — element representa lo que se supone
  if (a.elements_logically_coherent === false) {
    const desc = a.illogical_elements_description ?? 'unspecified illogical element';
    issues.push(`illogical visual element: ${desc}`);
    refinementHints.push(
      `Element must look like what it represents in REAL LIFE. ${desc}. Redraw with realistic, recognizable form of this element. Avoid abstract shapes, geometric patterns, or invented symbols when the prompt asks for a real-world thing.`,
    );
    score -= 30;
    critical = true;
  }

  // BODY PART FUSION — anatomical impossibility entre múltiples partes
  if (a.body_parts_fused === true) {
    const desc = a.body_parts_fused_description ?? 'two body parts fuse together';
    issues.push(`body part fusion: ${desc}`);
    refinementHints.push(
      `${desc}. Each body part must be drawn as a SEPARATE, distinct anatomical entity. Two feet should not share toes; two hands should not blend together.`,
    );
    score -= 30;
    critical = true;
  }

  // STYLE
  if (!a.style_consistent) {
    issues.push(`style inconsistency: ${a.style_notes}`);
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));
  const severity: 'none' | 'minor' | 'critical' = critical
    ? 'critical'
    : issues.length > 0
      ? 'minor'
      : 'none';

  return {
    severity,
    score,
    issues,
    refinementHint: refinementHints.length > 0 ? refinementHints.join(' ') : null,
  };
}

interface AdversarialResult {
  criticalIssuesFound: string[];
  minorIssues: string[];
  adversarialScore: number;
  verdict: 'approve' | 'reject';
  refinementHint: string | null;
}
