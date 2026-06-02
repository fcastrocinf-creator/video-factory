// format-audit.ts — AUDITOR DE APRENDIZAJE DE FORMATO (panel multi-agente CON VISIÓN).
//
// El "norte" del owner: cuando se RIPEA/APRENDE un formato nuevo o se RENDERIZA un
// resultado, un panel de agentes especialistas MIRA los keyframes (del render y/o
// del original) y detecta lo que está mal o falta — recorte/composición, voces,
// producto/legibilidad, captions/anotación, fidelidad. Misma lógica que deepAudit:
//   1. Orquestador: elige qué especialistas correr según el material disponible.
//   2. Especialistas (adversariales) CON VISIÓN: unifiedJudge multimodal sobre los
//      keyframes (buildImageMessageContent) + contexto del formato → hallazgos.
//   3. Verificador adversarial: refuta high/critical → mata falsos positivos.
//   4. IA superior: sintetiza (dedup, ranking, próximo paso).
//   5. Persiste hallazgos (findings.jsonl, subsistema 'aprendizaje') + informe scoped
//      + los refleja como Evento en la KB. NUNCA auto-aplica (solo PROPONE).
//
// REUSA deepAudit (schemas + verificador + síntesis), unifiedJudge (visión),
// frame-extractor (keyframes) y findings (persistencia). Cero motores paralelos.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unifiedJudge, buildImageMessageContent, type ClaudeMessageContent } from '../unified-judge';
import { extractKeyframes } from '../frame-extractor';
import { buildMotionMap, formatMotionMapForPrompt } from '../motion-map';
import { getCodeVersion, recordEvent, type KbSubsistema } from './record';
import {
  recordHallazgo,
  writeFormatAuditReport,
  type Hallazgo,
  type FormatAuditReport,
  type FormatAuditReportHallazgo,
} from './findings';
import {
  SpecialistOutputSchema,
  defaultRunVerifier,
  defaultRunSynthesis,
  type SpecialistOutput,
  type HallazgoDraft,
  type Verificacion,
  type Sintesis,
} from './deep-audit';

// ─── Especialistas del formato (adversariales) + qué material usa cada uno ─────

type FrameKind = 'render' | 'original';

interface SpecialistConfig {
  /** Mandato adversarial corto, específico de la dimensión. */
  brief: string;
  /** Qué keyframes necesita: del render generado, del original, o ambos. */
  usa: FrameKind[];
}

export const FORMAT_SPECIALISTS: Record<string, SpecialistConfig> = {
  'composicion-recorte': {
    usa: ['render'],
    brief:
      'Evalúa la COMPOSICIÓN y los RECORTES (cutouts/overlays). Busca: figuras recortadas translúcidas o con halo/fleco de color, bordes sucios, recorte que se ve "pegado" o como estampado sobre el sujeto (no en primer plano), escala/posición antinatural, overlay que tapa algo importante, o que "grita IA". Cada hallazgo con su fix concreto.',
  },
  'animacion-movimiento': {
    usa: ['original'],
    brief:
      'Analiza la ESTRUCTURA DE ANIMACIÓN del formato con el "Mapa de movimiento" del contexto + los frames. Por cada tramo ANIMADO, identifica QUÉ/QUIÉN se mueve (experto que habla/gesticula, usuaria que prueba el producto, producto, b-roll); marca los tramos ESTÁTICOS (imágenes fijas). El objetivo es REPRODUCIR esa mezcla animado/estático. Hallazgo cuando: la reproducción pierde el movimiento (ej. el experto queda como foto fija donde el original lo anima), o anima algo que debía ser estático. Indica qué tramos deben animarse y de quién.',
  },
  'voces-diarizacion': {
    usa: ['original'],
    brief:
      'Analiza las VOCES/HABLANTES del formato usando el contexto (transcripción/entendimiento) y los frames del original. Determina cuántos hablantes DISTINTOS hay y su rol (autoridad/experto, usuaria que prueba, voz en off) y género estimado. Si el original tiene 2+ voces y la generación las colapsa a una sola, ES un hallazgo de alto impacto. Indica el reparto detectado.',
  },
  'producto-legibilidad': {
    usa: ['render'],
    brief:
      'Evalúa el PRODUCTO y su legibilidad. Busca: producto ausente en un ad que debería venderlo, producto poco visible o muy pequeño, etiqueta/marca/claim ILEGIBLE en pantalla de móvil (sobre todo el texto pequeño), packaging poco realista o mal integrado (luz/escala/sombra). Si falta el producto o no se lee la etiqueta, es un hallazgo.',
  },
  'captions-anotacion': {
    usa: ['render'],
    brief:
      'Evalúa CAPTIONS y ANOTACIONES. Busca: subtítulos sin contorno, muy pequeños o ilegibles, sin el resaltado karaoke (palabra activa) cuando el formato lo pide; anotaciones (círculos/flechas) que caen en vacío o no señalan lo que el texto menciona; cualquier overlay incoherente o amateur.',
  },
  fidelidad: {
    usa: ['render', 'original'],
    brief:
      'Compara el RENDER con el ORIGINAL. ¿Reproduce fielmente el formato (estructura, encuadres, densidad de composición, estilo de captions, overlays, ritmo)? Señala lo que se ve "de IA"/amateur frente al original y las diferencias que más rompen la fidelidad del formato aprendido.',
  },
};

const ROLE_PREAMBLE = (especialista: string, brief: string) =>
  `Eres un AUDITOR ESPECIALISTA en "${especialista}" de ads UGC verticales 9:16 (TikTok/Reels) para marcas D2C. Mandato ADVERSARIAL: asume que HAY problemas y encuéntralos mirando las imágenes.

${brief}

Reglas estrictas:
- Apóyate SOLO en lo que ves en los frames y en el contexto provisto. Si una afirmación es hipótesis sin evidencia visual, baja la confianza (<0.5).
- NO inventes problemas. Si no ves defectos en tu dimensión, devuelve pocos o cero hallazgos — es válido y honesto.
- Un fix concreto por hallazgo (NUNCA se aplica solo; lo revisa el owner).
- Severidad honesta: "critical" solo si rompe el ad o lo vuelve inservible para vender.
- Texto en español neutro (con "tú"). Responde SOLO JSON, sin markdown.

Formato: {"resumen":"...","hallazgos":[{"titulo":"...","severidad":"low|medium|high|critical","descripcion":"...","evidencia":"qué se ve que lo sostiene","fixPropuesto":"...","confianza":0.0-1.0}]}`;

// ─── Especialista por defecto: unifiedJudge multimodal sobre los keyframes ──────

async function defaultRunFormatSpecialist(args: {
  especialista: string;
  brief: string;
  frames: { buf: Buffer; label: string }[];
  contextText: string;
  model: string;
}): Promise<SpecialistOutput | null> {
  const content: ClaudeMessageContent[] = [];
  content.push({
    type: 'text',
    text: `## Contexto del formato\n${args.contextText || '(sin contexto extra)'}\n\n## Frames a analizar (en orden):`,
  });
  for (const f of args.frames) {
    content.push(...buildImageMessageContent(f.buf, `\n${f.label}`, 'image/png'));
  }
  content.push({
    type: 'text',
    text: '\n\nAnaliza SOLO tu dimensión sobre estos frames y devuelve el JSON.',
  });

  const r = await unifiedJudge({
    roleSystemPrompt: ROLE_PREAMBLE(args.especialista, args.brief),
    userContent: content,
    schema: SpecialistOutputSchema,
    model: args.model,
    maxTokens: 2200,
    temperature: 0.2,
    timeoutMs: 120_000,
  });
  return r.isOk() ? r.value : null;
}

// ─── Carga de keyframes (de video con ffmpeg, o de paths ya extraídos) ─────────

async function loadFrames(
  videoPath: string | undefined,
  keyframePaths: string[] | undefined,
  kind: FrameKind,
): Promise<{ buf: Buffer; label: string }[]> {
  let entries: { filePath: string; label: string }[] = [];
  if (keyframePaths && keyframePaths.length > 0) {
    entries = keyframePaths.map((p, i) => ({
      filePath: p,
      label: `[${kind} frame ${i + 1}/${keyframePaths.length}]`,
    }));
  } else if (videoPath) {
    const kfs = await extractKeyframes({
      videoPath,
      outputDir: `${videoPath}.fa-keyframes`,
      widthPx: 720,
    });
    entries = kfs.map((k) => ({
      filePath: k.filePath,
      label: `[${kind} t=${k.sourceTimeSec.toFixed(1)}s]`,
    }));
  }
  const out: { buf: Buffer; label: string }[] = [];
  for (const e of entries) {
    try {
      out.push({ buf: await readFile(e.filePath), label: e.label });
    } catch {
      // frame ilegible → se omite
    }
  }
  return out;
}

// ─── Inyección de dependencias (para test sin IA / sin ffmpeg) ─────────────────

export interface FormatAuditDeps {
  runFormatSpecialist?: (args: {
    especialista: string;
    brief: string;
    frames: { buf: Buffer; label: string }[];
    contextText: string;
    model: string;
  }) => Promise<SpecialistOutput | null>;
  runVerifier?: (args: {
    subsistema: string;
    draft: HallazgoDraft;
    model: string;
  }) => Promise<Verificacion | null>;
  runSynthesis?: (args: { hallazgos: Hallazgo[]; model: string }) => Promise<Sintesis | null>;
}

// ─── API pública ───────────────────────────────────────────────────────────────

export interface FormatAuditInput {
  /** Clave única del formato/run auditado (runId / presetId / etiqueta). */
  scope: string;
  /** Nombre legible para el owner (ej. "Rip: ad del médico"). */
  label: string;
  /** MP4 del render generado (se extraen keyframes). */
  renderVideoPath?: string;
  /** MP4 del original/referencia (para fidelidad y voces). */
  originalVideoPath?: string;
  /** Keyframes del render ya extraídos (alternativa a renderVideoPath). */
  renderKeyframePaths?: string[];
  /** Keyframes del original ya extraídos. */
  originalKeyframePaths?: string[];
  /** Texto de contexto: entendimiento del original, preset, narración/transcripción. */
  contextText?: string;
  /** Override de qué especialistas correr. Default: todos los disponibles. */
  specialists?: string[];
  /** 'rapido' = Haiku (default); 'profundo' = Sonnet. */
  depth?: 'rapido' | 'profundo';
  /** Tope de verificaciones adversariales (high/critical). Default 8. */
  maxVerificaciones?: number;
  /** Inyección para tests — NO usar en producción. */
  deps?: FormatAuditDeps;
}

export interface FormatAuditResult {
  auditId: string;
  scope: string;
  label: string;
  ts: string;
  codeVersion: string;
  depth: 'rapido' | 'profundo';
  especialistasAuditados: string[];
  especialistasSalteados: string[];
  hallazgos: Hallazgo[];
  descartados: number;
  sintesis: Sintesis | null;
  llamadas: number;
  errores: string[];
}

/** ¿Hay credenciales para correr el auditor con IA real? (gating del disparo auto). */
export function formatAuditEnabled(): boolean {
  const k = process.env['ANTHROPIC_API_KEY'];
  return !!k && !k.startsWith('ROTATE_');
}

/**
 * Audita un formato/render con el panel multi-agente con visión. Reusa el patrón
 * de deepAudit. NUNCA aplica fixes (solo propone). Best-effort en persistencia.
 */
export async function runFormatAudit(input: FormatAuditInput): Promise<FormatAuditResult> {
  const ts = new Date().toISOString();
  const auditId = `format-audit/${ts.slice(0, 10)}/${randomUUID().slice(0, 8)}`;
  const codeVersion = getCodeVersion();
  const depth = input.depth ?? 'rapido';
  const model = depth === 'profundo' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
  const errores: string[] = [];
  let llamadas = 0;

  const runSpecialist = input.deps?.runFormatSpecialist ?? defaultRunFormatSpecialist;
  const runVerifier = input.deps?.runVerifier ?? defaultRunVerifier;
  const runSynthesis = input.deps?.runSynthesis ?? defaultRunSynthesis;

  // 1) Resolver keyframes (render y original).
  const renderFrames = await loadFrames(
    input.renderVideoPath,
    input.renderKeyframePaths,
    'render',
  ).catch((e: Error) => {
    errores.push(`keyframes render: ${e.message}`);
    return [] as { buf: Buffer; label: string }[];
  });
  const originalFrames = await loadFrames(
    input.originalVideoPath,
    input.originalKeyframePaths,
    'original',
  ).catch((e: Error) => {
    errores.push(`keyframes original: ${e.message}`);
    return [] as { buf: Buffer; label: string }[];
  });
  let contextText = input.contextText ?? '';
  // Mapa de movimiento (animado vs estático) del original — alimenta al especialista
  // de animación (y al resto como contexto). Determinista, sin IA. Best-effort.
  const motionSrc = input.originalVideoPath ?? input.renderVideoPath;
  if (motionSrc) {
    try {
      const map = await buildMotionMap({ videoPath: motionSrc });
      contextText = `${formatMotionMapForPrompt(map)}\n\n${contextText}`.trim();
    } catch (e) {
      errores.push(`motion-map: ${(e as Error).message}`);
    }
  }

  // 2) Orquestador: especialistas con material suficiente.
  const requested = input.specialists ?? Object.keys(FORMAT_SPECIALISTS);
  const auditados: string[] = [];
  const salteados: string[] = [];
  const drafts: Array<{ especialista: string; draft: HallazgoDraft }> = [];

  for (const esp of requested) {
    const cfg = FORMAT_SPECIALISTS[esp];
    if (!cfg) {
      salteados.push(esp);
      continue;
    }
    const frames: { buf: Buffer; label: string }[] = [];
    if (cfg.usa.includes('render')) frames.push(...renderFrames);
    if (cfg.usa.includes('original')) frames.push(...originalFrames);
    // Sin frames Y sin contexto → no hay nada que analizar.
    if (frames.length === 0 && !contextText) {
      salteados.push(esp);
      continue;
    }
    auditados.push(esp);
    try {
      const out = await runSpecialist({ especialista: esp, brief: cfg.brief, frames, contextText, model });
      llamadas += 1;
      if (out) for (const d of out.hallazgos) drafts.push({ especialista: esp, draft: d });
    } catch (e) {
      errores.push(`especialista ${esp}: ${(e as Error).message}`);
    }
  }

  // 3) Verificación adversarial de high/critical + persistencia de hallazgos.
  const maxVer = input.maxVerificaciones ?? 8;
  const persistidos: Hallazgo[] = [];
  const reporteHallazgos: FormatAuditReportHallazgo[] = [];
  let descartados = 0;
  let verCount = 0;

  for (const { especialista, draft } of drafts) {
    let estado: Hallazgo['estado'] = 'abierto';
    let verificacion: Hallazgo['verificacion'];
    const needsVerify =
      (draft.severidad === 'high' || draft.severidad === 'critical') && verCount < maxVer;
    if (needsVerify) {
      verCount += 1;
      try {
        const v = await runVerifier({ subsistema: especialista, draft, model });
        llamadas += 1;
        if (v) {
          verificacion = { veredicto: v.veredicto, razon: v.razon };
          if (v.veredicto === 'falso-positivo') {
            descartados += 1;
            await recordHallazgo({
              auditId,
              codeVersion,
              subsistema: 'aprendizaje',
              severidad: draft.severidad,
              estado: 'falso-positivo',
              titulo: `[${especialista}] ${draft.titulo}`,
              descripcion: draft.descripcion,
              evidencia: draft.evidencia,
              fixPropuesto: draft.fixPropuesto,
              confianza: draft.confianza,
              verificacion,
            });
            continue;
          }
          estado = v.veredicto === 'confirmado' ? 'confirmado' : 'abierto';
        }
      } catch (e) {
        errores.push(`verificador (${especialista}): ${(e as Error).message}`);
      }
    }

    const h = await recordHallazgo({
      auditId,
      codeVersion,
      subsistema: 'aprendizaje',
      severidad: draft.severidad,
      estado,
      titulo: `[${especialista}] ${draft.titulo}`,
      descripcion: draft.descripcion,
      evidencia: draft.evidencia,
      fixPropuesto: draft.fixPropuesto,
      confianza: draft.confianza,
      verificacion,
    });
    persistidos.push(h);
    reporteHallazgos.push({
      especialista,
      severidad: draft.severidad,
      estado,
      titulo: draft.titulo,
      descripcion: draft.descripcion,
      fixPropuesto: draft.fixPropuesto,
      confianza: draft.confianza,
    });

    // Reflejar a la KB como Evento (igual que deepAudit) — entra al grafo y las
    // próximas auditorías lo ven. Subsistema 'aprendizaje'.
    void recordEvent({
      vault: 'dev',
      subsistema: 'aprendizaje' as KbSubsistema,
      tipo: 'hallazgo-auditoria',
      entidad: {},
      severidad: draft.severidad,
      estado,
      titulo: `[${especialista}] ${draft.titulo}`,
      contenido: `${draft.descripcion}\n\n**Evidencia:** ${draft.evidencia}\n\n**Fix propuesto:** ${draft.fixPropuesto}`,
      fuente: `formatAudit:${auditId} (${input.scope})`,
      confianza: draft.confianza,
      tags: ['hallazgo-formato', especialista, draft.severidad],
    });
  }

  // 4) Síntesis (IA superior) sobre lo que sobrevivió.
  let sintesis: Sintesis | null = null;
  if (persistidos.length > 0) {
    try {
      sintesis = await runSynthesis({ hallazgos: persistidos, model });
      llamadas += 1;
    } catch (e) {
      errores.push(`síntesis: ${(e as Error).message}`);
    }
  }

  // 5) Persistir el informe scoped (para la vista del Consejo / run).
  const report: FormatAuditReport = {
    scope: input.scope,
    label: input.label,
    ts,
    codeVersion,
    especialistasAuditados: auditados,
    totalHallazgos: persistidos.length,
    descartados,
    sintesis: sintesis
      ? {
          resumenEjecutivo: sintesis.resumenEjecutivo,
          topHallazgos: sintesis.topHallazgos,
          proximoPaso: sintesis.proximoPaso,
        }
      : null,
    hallazgos: reporteHallazgos,
  };
  await writeFormatAuditReport(report);

  return {
    auditId,
    scope: input.scope,
    label: input.label,
    ts,
    codeVersion,
    depth,
    especialistasAuditados: auditados,
    especialistasSalteados: salteados,
    hallazgos: persistidos,
    descartados,
    sintesis,
    llamadas,
    errores,
  };
}
