// judge-final.ts — función principal del post-render judge.
//
// Workflow:
//   1. Coverage check: cada scene tiene imagePath en disk? videoPath?
//   2. Duration check: audio dura ~igual que sum(scene.duration)?
//   3. Visual sample: tomar N scenes (primera, medio, última, + criticas)
//      y validarlas con preview-judge (Claude Haiku) — reutiliza M2
//   4. Subtitle judge: si se pasan segments, validar text quality
//   5. Aggregator: combinar issues, calcular pass general
//
// NO requiere ffmpeg ni extracción de frames (eso es M5 v2). Usa solo los
// artefactos del workDir + la API de Claude.

import { ok, err, type Result } from 'neverthrow';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { judgeImage } from '@video-factory/block-preview-judge';
import { judgeSubtitles } from './subtitle-judge.js';
import { detectBurnedInText } from './burned-text-detector.js';
import {
  type FinalRenderInput,
  type FinalJudgeOptions,
  type FinalRenderReport,
  type FinalIssue,
} from './types.js';

const DEFAULT_DURATION_TOLERANCE_SEC = 1.5;
const DEFAULT_VISUAL_SAMPLE_SIZE = 3;

export async function judgeFinalRender(
  input: FinalRenderInput,
  options: FinalJudgeOptions = {},
): Promise<Result<FinalRenderReport, { type: string; message: string }>> {
  const issues: FinalIssue[] = [];
  const tolerance = options.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC;
  const sampleSize = options.visualSampleSize ?? DEFAULT_VISUAL_SAMPLE_SIZE;
  const useClaudeJudge = options.useClaudeJudge ?? true;

  // ============================================================
  // STEP 1 — Coverage check
  // ============================================================
  let scenesWithVideo = 0;
  let scenesWithStaticImageOnly = 0;
  let scenesMissingVisual = 0;

  for (const scene of input.scenes) {
    const hasVideo = !!scene.videoPath && existsSync(scene.videoPath);
    const hasImage = !!scene.imagePath && existsSync(scene.imagePath);
    if (hasVideo) {
      scenesWithVideo++;
    } else if (hasImage) {
      scenesWithStaticImageOnly++;
      // Si el usuario desactivó la animación a propósito, la estática es el
      // resultado deseado: NO la marcamos como issue (evita la falsa alarma de
      // "fallback masivo de animación" en el editor IA).
      if (!input.animationDisabled) {
        issues.push({
          severity: 'info',
          category: 'missing-animation',
          sceneIndex: scene.index,
          description: `Scene ${scene.index} no se animó (fallback a estática). Texto: "${scene.text.slice(0, 60)}"`,
          suggestion:
            'Verificar quota del provider (Kling balance / Veo daily limits). Si es recurrente, considerar provider extra.',
        });
      }
    } else {
      scenesMissingVisual++;
      issues.push({
        severity: 'critical',
        category: 'missing-visual',
        sceneIndex: scene.index,
        description: `Scene ${scene.index} NO tiene imagen ni video en disk (imagePath=${scene.imagePath ?? 'undefined'}, videoPath=${scene.videoPath ?? 'undefined'})`,
        suggestion:
          'Regenerar esta scene desde image-gen-multi. Puede ser bug del pipeline (provider call sin write).',
      });
    }
  }

  // ============================================================
  // STEP 2 — Duration check
  // ============================================================
  const scenePlanDurationSec =
    input.scenes.length > 0
      ? Math.max(...input.scenes.map((s) => s.endTimeSeconds))
      : 0;

  let audioDurationSec = 0;
  if (typeof input.audioDurationSec === 'number' && input.audioDurationSec > 0) {
    // M5 v2 (fix 1-jun-2026): el caller (pipeline) ya conoce la duración REAL del
    // audio (TTS / ffprobe bundled). La usamos en vez de estimar por tamaño de
    // archivo, que daba falsos "duration-mismatch" críticos con MP3 VBR o bitrate
    // distinto de 128kbps.
    audioDurationSec = input.audioDurationSec;
  } else if (input.audioPath && existsSync(input.audioPath)) {
    // Fallback (sin duración real disponible): aproximación cruda por tamaño.
    const audioStat = await stat(input.audioPath);
    audioDurationSec = audioStat.size / 16000; // approx para 128kbps
  }

  // ============================================================
  // STEP 2.5 — Per-scene timing sanity check (25-may-2026 owner feedback)
  // ============================================================
  // Heurística: español neutro lee ~14-18 chars/sec (incluyendo pausas).
  // Si una scene tiene text.length / duration > 22 chars/sec → texto muy
  // comprimido para la duración (la voz cuenta más rápido de lo razonable y
  // la imagen se ve "tarde" — bug que el owner reportó).
  // Si <8 chars/sec → texto muy disperso (silencio largo, escena vacía visual).
  const READING_SPEED_MAX = 22; // chars/sec
  const READING_SPEED_MIN = 8;
  for (const scene of input.scenes) {
    const duration = scene.endTimeSeconds - scene.startTimeSeconds;
    if (duration <= 0 || scene.text.length < 5) continue;
    const speed = scene.text.length / duration;
    if (speed > READING_SPEED_MAX) {
      issues.push({
        severity: 'warning',
        category: 'duration-mismatch',
        sceneIndex: scene.index,
        description: `Scene ${scene.index} tiene ${scene.text.length} chars en ${duration.toFixed(1)}s (${speed.toFixed(1)} chars/sec — demasiado comprimido). La voz va a sonar acelerada o la imagen va a verse tarde mientras la voz sigue hablando.`,
        suggestion: `Extender scene ${scene.index} a ~${(scene.text.length / 16).toFixed(1)}s para dar tiempo natural a leerla.`,
      });
    } else if (speed < READING_SPEED_MIN && duration > 2) {
      issues.push({
        severity: 'info',
        category: 'duration-mismatch',
        sceneIndex: scene.index,
        description: `Scene ${scene.index} tiene solo ${scene.text.length} chars en ${duration.toFixed(1)}s (${speed.toFixed(1)} chars/sec — texto disperso). Posible silencio largo o escena vacía.`,
      });
    }
  }

  let durationMismatchSec: number | undefined;
  if (audioDurationSec > 0 && scenePlanDurationSec > 0) {
    durationMismatchSec = Math.abs(audioDurationSec - scenePlanDurationSec);
    if (durationMismatchSec > tolerance) {
      // ESCALATION (25-may-2026 post-Test 7 owner feedback): un duration
      // mismatch grande (>3s) NO es warning — es CRITICAL. Causa el bug
      // "video se corta y queda negro con audio sonando". El pipeline tiene
      // un normalize step pre-compositor (pipeline.ts B.4.1) que debería
      // prevenirlo; si igual M5 lo detecta acá, hay algo mal — escalar.
      const isCritical = durationMismatchSec > 3.0;
      issues.push({
        severity: isCritical ? 'critical' : 'warning',
        category: 'duration-mismatch',
        sceneIndex: null,
        description: `Audio (~${audioDurationSec.toFixed(1)}s) y scene plan (${scenePlanDurationSec.toFixed(1)}s) difieren en ${durationMismatchSec.toFixed(1)}s. Tolerance: ±${tolerance}s.${isCritical ? ' CRITICAL — esto causa "video corta antes que audio termina".' : ''}`,
        suggestion:
          audioDurationSec > scenePlanDurationSec
            ? 'El audio sobra → la última scene debe extenderse o el video va a tener negro al final. El normalize step de pipeline B.4.1 debe haber capturado esto — verificar que se aplicó. Solución: rerun después de revisar scene-planner output.'
            : 'Las scenes suman más que el audio → scenes vacías o gaps. Verificar scene-planner.',
      });
    }
  }

  // ============================================================
  // STEP 3 — Visual quality sample (Claude judge)
  // ============================================================
  let visualSampleAvgScore: number | undefined;
  let visualSampleFailures = 0;
  let actualSampleSize = 0;

  if (useClaudeJudge && input.scenes.length > 0) {
    // Sample: primera, medio, última. Excluye las que no tienen imagen.
    const validScenes = input.scenes.filter(
      (s) => s.imagePath && existsSync(s.imagePath),
    );
    if (validScenes.length > 0) {
      const indices = new Set<number>();
      indices.add(0);
      if (validScenes.length > 2) indices.add(Math.floor(validScenes.length / 2));
      if (validScenes.length > 1) indices.add(validScenes.length - 1);
      // Padding hasta sampleSize si hay scenes suficientes
      while (indices.size < sampleSize && indices.size < validScenes.length) {
        const candidate = Math.floor(Math.random() * validScenes.length);
        indices.add(candidate);
      }
      const sampled = [...indices].map((i) => validScenes[i]!);

      let scoreSum = 0;
      for (const scene of sampled) {
        const buffer = await readFile(scene.imagePath!);
        const judgeResult = await judgeImage(
          {
            imageBuffer: buffer,
            imageMimeType: 'image/png',
            prompt: scene.imagePrompt ?? scene.text,
            sceneNarration: scene.text,
            brandContext: input.brandContext,
            expectedStyle: input.brandContext?.styleSummary,
          },
          { model: 'claude-haiku-4-5' },
        );
        if (judgeResult.isErr()) {
          // Claude falló para esta scene — no contamos como issue del video,
          // pero loggeamos para visibilidad.
          continue;
        }
        const report = judgeResult.value;
        scoreSum += report.scoreVisual;
        actualSampleSize++;
        if (!report.pass) {
          visualSampleFailures++;
          issues.push({
            severity: 'warning',
            category: 'visual-quality',
            sceneIndex: scene.index,
            description: `Scene ${scene.index} reprobó re-validación post-render. Score visual: ${report.scoreVisual}. ${report.rationale.slice(0, 200)}`,
            suggestion:
              report.suggestions[0] ?? 'Regenerar scene con prompt refinado.',
          });
        }

        // STEP 3.5 — Burned-in text detection (25-may-2026)
        // Sobre las MISMAS scenes sampleadas, corremos el detector de texto
        // glitchy. Bug típico: gpt-image-1/Imagen ignoran "NO text overlay"
        // y meten gibberish ("DDCDBA"), aspect-ratio leak ("9/16"), o
        // wrong-language ("BEFORE" en ad ES). Si severity>=medium, issue
        // crítico → M6 emite regenerate-scene automático.
        try {
          const btResult = await detectBurnedInText({
            imageBuffer: buffer,
            imageMimeType: 'image/png',
            expectedLanguage: input.brandContext?.language ?? 'es',
          });
          if (btResult.isOk()) {
            const bt = btResult.value;
            if (bt.hasBurnedInText && (bt.severity === 'medium' || bt.severity === 'high')) {
              const samples = bt.detectedTextSamples.slice(0, 3).join(', ');
              issues.push({
                severity: bt.severity === 'high' ? 'critical' : 'warning',
                category: 'visual-quality',
                sceneIndex: scene.index,
                description:
                  `Scene ${scene.index} tiene texto burned-in ${bt.isGlitchy ? 'GLITCHY' : ''}${bt.isWrongLanguage ? ' en IDIOMA INCORRECTO' : ''}: ` +
                  `"${samples}". ${bt.reasoning.slice(0, 150)}`,
                suggestion:
                  `Regenerar scene con prompt reforzado: agregar al final "CRITICAL: absolutely NO text, captions, labels, numbers, or written words ` +
                  `anywhere in the image. Pure visual composition only. Text rendering is done in post-production."`,
              });
            }
          }
          // Si btResult.isErr() → silencioso. No queremos romper M5 por un fallo del detector auxiliar.
        } catch {
          // best-effort
        }
      }
      if (actualSampleSize > 0) {
        visualSampleAvgScore = scoreSum / actualSampleSize;
      }
    }
  }

  // ============================================================
  // STEP 4 — Subtitle judge (si se pasan segments)
  // ============================================================
  let subtitleSampleSize: number | undefined;
  let subtitleIssuesCount: number | undefined;
  if (useClaudeJudge && input.subtitleSegments && input.subtitleSegments.length > 0) {
    const subResult = await judgeSubtitles({
      segments: input.subtitleSegments,
      expectedLanguage: 'es',
    });
    if (subResult.isOk()) {
      const subReport = subResult.value;
      subtitleSampleSize = subReport.totalSegments;
      subtitleIssuesCount = subReport.issuesCount;
      for (const issue of subReport.issues) {
        issues.push({
          severity:
            issue.severity === 'critical'
              ? 'critical'
              : issue.severity === 'major'
                ? 'warning'
                : 'info',
          category: 'subtitle-quality',
          sceneIndex: null,
          description: `Subtítulo seg.${issue.segmentIndex} (${issue.kind}): "${issue.text.slice(0, 80)}" — ${issue.description}`,
          suggestion: issue.suggestion,
        });
      }
    }
  }

  // ============================================================
  // STEP 5 — Aggregator
  // ============================================================
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const pass = criticalCount === 0 && warningCount <= 2;

  const rationale = pass
    ? `Post-render check OK. ${input.scenes.length} scenes (${scenesWithVideo} animadas, ${scenesWithStaticImageOnly} estáticas, ${scenesMissingVisual} faltantes). ${warningCount} warnings menores.`
    : `Post-render FALLÓ. ${criticalCount} critical, ${warningCount} warnings. Issues: ${issues.slice(0, 3).map((i) => `[${i.severity}/${i.category}]`).join(', ')}`;

  return ok({
    pass,
    totalScenes: input.scenes.length,
    scenesWithVideo,
    scenesWithStaticImageOnly,
    scenesMissingVisual,
    animationDisabled: input.animationDisabled,
    audioDurationSec,
    scenePlanDurationSec,
    durationMismatchSec,
    visualSampleSize: actualSampleSize,
    visualSampleAvgScore,
    visualSampleFailures,
    subtitleSampleSize,
    subtitleIssuesCount,
    issues,
    rationale,
  });
}
