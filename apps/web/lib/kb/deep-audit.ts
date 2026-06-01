// Base de Conocimiento — Fase 2: AUDITORÍA PROFUNDA (ON-DEMAND).
// CONOCIMIENTO.md §6. Pipeline estructurado (más confiable y barato que "chat
// libre entre agentes"):
//   1. Orquestador: elige subsistemas a auditar (scope, o los que cambiaron).
//   2. Especialistas: 1 por subsistema, mandato ADVERSARIAL, reciben un contexto
//      CHICO a medida (buildContextFor) → hallazgos.
//   3. Verificador adversarial: intenta REFUTAR cada hallazgo high/critical →
//      mata falsos positivos (curación señal/ruido).
//   4. IA superior: sintetiza (dedup, ranking, próximo paso). NUNCA auto-aplica.
//   5. Persiste hallazgos en findings.jsonl + los refleja como Evento en la KB.
//
// COSTO: solo corre cuando el owner lo dispara (endpoint). Scoped + cacheado por
// codeVersion (§8). Inyección de dependencias (`deps`) para testear SIN gastar IA.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { unifiedJudge } from '../unified-judge';
import { buildContextFor, kbStats, query } from './query';
import { getCodeVersion, recordEvent, type KbSubsistema } from './record';
import {
  recordHallazgo,
  readLastAudit,
  writeLastAudit,
  writeLastAuditReport,
  type Hallazgo,
  type LastAuditMap,
} from './findings';

// ─── Esquemas robustos: TRUNCAN en vez de rechazar (evita perder el output por
//     longitud — el bug histórico del validator-chat-ia). Enums/números con
//     .catch() para no caer todo el array por un campo fuera de rango. ──────────

const SEVERIDADES = ['low', 'medium', 'high', 'critical'] as const;
const cap = (n: number) => z.string().default('').transform((s) => (s.length > n ? s.slice(0, n) : s));
const conf = () =>
  z
    .number()
    .catch(0.5)
    .transform((v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5));

const HallazgoDraftSchema = z.object({
  titulo: cap(160),
  severidad: z.enum(SEVERIDADES).catch('medium'),
  descripcion: cap(1200),
  evidencia: cap(800),
  fixPropuesto: cap(800),
  confianza: conf(),
});
type HallazgoDraft = z.infer<typeof HallazgoDraftSchema>;

const SpecialistOutputSchema = z.object({
  resumen: cap(600),
  hallazgos: z.array(HallazgoDraftSchema).max(12).default([]),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

const VerificacionSchema = z.object({
  veredicto: z.enum(['confirmado', 'falso-positivo', 'incierto']).catch('incierto'),
  razon: cap(600),
});
export type Verificacion = z.infer<typeof VerificacionSchema>;

const SintesisSchema = z.object({
  resumenEjecutivo: cap(1500),
  topHallazgos: z
    .array(z.object({ titulo: cap(160), severidad: cap(20), porQueImporta: cap(300) }))
    .max(10)
    .default([]),
  proximoPaso: cap(400),
});
export type Sintesis = z.infer<typeof SintesisSchema>;

// ─── Briefs de dominio por subsistema (adversariales, cortos) ────────────────

const GENERIC_BRIEF =
  'Busca patrones de fallo, anomalías o riesgos en la actividad registrada de este subsistema.';

const SUBSYSTEM_BRIEFS: Record<string, string> = {
  pipeline:
    'Audita la orquestación del pipeline de video: runs que fallan, costos anómalos, escenas que se regeneran de más, timeouts, pasos que se saltan en silencio.',
  validator:
    'Audita el VALIDATOR (chat IA): veredictos perdidos por longitud/schema, falsos "wrong", escenas que NO se corrigen pese al feedback, regeneración de escenas ya aprobadas (invariante #1 del owner).',
  chat:
    'Audita el Copilot/chat: respuestas pobres o evasivas, fuga de datos internos (proveedores/claves), VOSEO (debe ser español neutro con "tú"), loops, no entender al usuario no técnico.',
  aprendizaje:
    'Audita el aprendizaje de presets: presets de baja confianza, learns que no convergen, juicios negativos recurrentes sobre un mismo preset/estilo.',
  compositor:
    'Audita el render/compositor: errores de render, audio y escena desalineados, Ken Burns o micro-escenas activados sin que el usuario los pidiera (deben ser opt-in).',
  seguridad:
    'Audita seguridad: endpoints sin auth, fuga de claves o datos sensibles, inputs sin validar, operaciones destructivas sin consentimiento.',
  'image-gen':
    'Audita la generación de imágenes: rechazos de proveedor recurrentes, texto quemado (burned-in), collage/grid cuando se pidió un solo cuadro, cascada de proveedores que no salta.',
  animacion:
    'Audita la animación (image-to-video): clips que no se generan (cuota), animación que deforma/re-encuadra, desalineación con la imagen estática.',
  ux: 'Audita la experiencia: fricción para un usuario no técnico, textos confusos o en voseo, afordancias faltantes.',
};

// ─── Inyección de dependencias (para test sin IA) ────────────────────────────

export interface DeepAuditDeps {
  runSpecialist?: (args: {
    subsistema: string;
    brief: string;
    context: string;
    model: string;
  }) => Promise<SpecialistOutput | null>;
  runVerifier?: (args: {
    subsistema: string;
    draft: HallazgoDraft;
    model: string;
  }) => Promise<Verificacion | null>;
  runSynthesis?: (args: { hallazgos: Hallazgo[]; model: string }) => Promise<Sintesis | null>;
}

// ─── Implementaciones por defecto (Claude real vía unifiedJudge) ─────────────

async function defaultRunSpecialist(args: {
  subsistema: string;
  brief: string;
  context: string;
  model: string;
}): Promise<SpecialistOutput | null> {
  const role = `Eres un AUDITOR ESPECIALISTA del subsistema "${args.subsistema}" de Video Factory. Mandato ADVERSARIAL: asume que HAY problemas y encuéntralos. ${args.brief}

Trabajas con la evidencia de la Base de Conocimiento que te paso (actividad REALMENTE registrada) + tu conocimiento del sistema. Reglas estrictas:
- Cada hallazgo DEBE apoyarse en la evidencia provista. Si es una hipótesis sin evidencia directa, baja la confianza (<0.5).
- NO inventes datos ni problemas. Si la evidencia no muestra problemas, devuelve pocos o cero hallazgos — es válido y honesto.
- Propón un fix concreto por hallazgo (NUNCA se aplica solo; lo revisa el owner).
- Severidad honesta: "critical" solo si rompe la experiencia o pierde trabajo del owner.
- Texto en español neutro. Responde SOLO JSON, sin markdown.

Formato: {"resumen":"...","hallazgos":[{"titulo":"...","severidad":"low|medium|high|critical","descripcion":"...","evidencia":"qué dato lo sostiene","fixPropuesto":"...","confianza":0.0-1.0}]}`;
  const user = `## Evidencia de la KB (subsistema "${args.subsistema}")\n${args.context || '(sin eventos registrados para este subsistema)'}\n\nAudita a fondo y devuelve el JSON.`;
  const r = await unifiedJudge({
    roleSystemPrompt: role,
    userContent: user,
    schema: SpecialistOutputSchema,
    model: args.model,
    maxTokens: 2200,
    temperature: 0.2,
    timeoutMs: 90_000,
  });
  return r.isOk() ? r.value : null;
}

async function defaultRunVerifier(args: {
  subsistema: string;
  draft: HallazgoDraft;
  model: string;
}): Promise<Verificacion | null> {
  const role = `Eres un VERIFICADOR ADVERSARIAL. Tu trabajo es intentar REFUTAR el hallazgo de un auditor para matar falsos positivos. Sé escéptico: si la evidencia citada no lo sostiene, declara 'falso-positivo'. Si lo sostiene claramente, 'confirmado'. Si no hay forma de saber, 'incierto'. Responde SOLO JSON, sin markdown: {"veredicto":"confirmado|falso-positivo|incierto","razon":"..."}`;
  const user = `Hallazgo a refutar (subsistema "${args.subsistema}", severidad ${args.draft.severidad}):
TÍTULO: ${args.draft.titulo}
DESCRIPCIÓN: ${args.draft.descripcion}
EVIDENCIA QUE CITA: ${args.draft.evidencia || '(no citó evidencia concreta)'}

¿Se sostiene con evidencia real o es especulación? Devuelve el JSON.`;
  const r = await unifiedJudge({
    roleSystemPrompt: role,
    userContent: user,
    schema: VerificacionSchema,
    model: args.model,
    maxTokens: 600,
    temperature: 0,
    timeoutMs: 60_000,
    skipProjectContext: true,
  });
  return r.isOk() ? r.value : null;
}

async function defaultRunSynthesis(args: {
  hallazgos: Hallazgo[];
  model: string;
}): Promise<Sintesis | null> {
  const lines = args.hallazgos
    .map((h) => `- [${h.severidad}] (${h.subsistema}) ${h.titulo} — ${h.descripcion.slice(0, 200)}`)
    .join('\n');
  const role = `Eres la IA SUPERIOR que coordina la auditoría. Sintetiza los hallazgos verificados: deduplica conceptualmente, rankea por IMPACTO REAL para el owner (no técnico) y propone un próximo paso accionable. NO inventes hallazgos nuevos. Español neutro, claro, sin jerga. Responde SOLO JSON, sin markdown: {"resumenEjecutivo":"...","topHallazgos":[{"titulo":"...","severidad":"...","porQueImporta":"..."}],"proximoPaso":"..."}`;
  const user = `Hallazgos verificados (${args.hallazgos.length}):\n${lines}\n\nSintetiza para el owner. Devuelve el JSON.`;
  const r = await unifiedJudge({
    roleSystemPrompt: role,
    userContent: user,
    schema: SintesisSchema,
    model: args.model,
    maxTokens: 1600,
    temperature: 0.3,
    timeoutMs: 90_000,
  });
  return r.isOk() ? r.value : null;
}

// ─── deepAudit ────────────────────────────────────────────────────────────────

export interface DeepAuditOptions {
  /** Subsistemas a auditar. Default: los que tienen actividad registrada. */
  subsistemas?: string[];
  /** 'rapido' = Haiku (barato); 'profundo' = Sonnet (más fino). Default 'rapido'. */
  depth?: 'rapido' | 'profundo';
  /** Ignora el caché por codeVersion (re-audita aunque no haya cambios). */
  force?: boolean;
  /** Tope de verificaciones adversariales (high/critical). Default 8. */
  maxVerificaciones?: number;
  /** Inyección para tests — NO usar en producción. */
  deps?: DeepAuditDeps;
}

export interface AuditReport {
  auditId: string;
  ts: string;
  codeVersion: string;
  depth: 'rapido' | 'profundo';
  subsistemasAuditados: string[];
  subsistemasSalteados: string[];
  hallazgos: Hallazgo[];
  descartados: number;
  sintesis: Sintesis | null;
  llamadas: number;
  errores: string[];
}

export async function deepAudit(opts: DeepAuditOptions = {}): Promise<AuditReport> {
  const ts = new Date().toISOString();
  const auditId = `audit/${ts.slice(0, 10)}/${randomUUID().slice(0, 8)}`;
  const codeVersion = getCodeVersion();
  const depth = opts.depth ?? 'rapido';
  const model = depth === 'profundo' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
  const errores: string[] = [];
  let llamadas = 0;

  // 1. Resolver subsistemas (scope o los que tienen actividad registrada).
  const stats = await kbStats();
  const conDatos = Object.keys(stats.porSubsistema);
  let subsistemas =
    opts.subsistemas && opts.subsistemas.length > 0 ? [...opts.subsistemas] : conDatos;

  if (subsistemas.length === 0) {
    return {
      auditId,
      ts,
      codeVersion,
      depth,
      subsistemasAuditados: [],
      subsistemasSalteados: [],
      hallazgos: [],
      descartados: 0,
      sintesis: null,
      llamadas: 0,
      errores: ['KB vacía: no hay actividad registrada para auditar todavía.'],
    };
  }

  // 2. Caché por codeVersion (ahorro §8): saltar subsistemas sin cambios de
  //    código NI eventos nuevos desde el último audit.
  const lastAudit = await readLastAudit();
  const salteados: string[] = [];
  if (!opts.force) {
    const filtrados: string[] = [];
    for (const s of subsistemas) {
      const last = lastAudit[s];
      if (last && last.codeVersion === codeVersion) {
        const nuevos = await query({ subsistema: s as KbSubsistema, desde: last.ts, limit: 1 });
        if (nuevos.length === 0) {
          salteados.push(s);
          continue;
        }
      }
      filtrados.push(s);
    }
    subsistemas = filtrados;
  }

  const runSpecialist = opts.deps?.runSpecialist ?? defaultRunSpecialist;
  const runVerifier = opts.deps?.runVerifier ?? defaultRunVerifier;
  const runSynthesis = opts.deps?.runSynthesis ?? defaultRunSynthesis;

  // 3. Especialistas (1 por subsistema).
  const drafts: Array<{ subsistema: string; draft: HallazgoDraft }> = [];
  for (const s of subsistemas) {
    const brief = SUBSYSTEM_BRIEFS[s] ?? GENERIC_BRIEF;
    const context = await buildContextFor({ subsistema: s as KbSubsistema }, 3500).catch(() => '');
    try {
      const out = await runSpecialist({ subsistema: s, brief, context, model });
      llamadas += 1;
      if (out) for (const d of out.hallazgos) drafts.push({ subsistema: s, draft: d });
    } catch (e) {
      errores.push(`especialista ${s}: ${(e as Error).message}`);
    }
  }

  // 4. Verificación adversarial de high/critical (cap por budget) + persistencia.
  const maxVer = opts.maxVerificaciones ?? 8;
  const persistidos: Hallazgo[] = [];
  let descartados = 0;
  let verCount = 0;
  for (const { subsistema, draft } of drafts) {
    let estado: Hallazgo['estado'] = 'abierto';
    let verificacion: Hallazgo['verificacion'];
    const needsVerify =
      (draft.severidad === 'high' || draft.severidad === 'critical') && verCount < maxVer;
    if (needsVerify) {
      verCount += 1;
      try {
        const v = await runVerifier({ subsistema, draft, model });
        llamadas += 1;
        if (v) {
          verificacion = { veredicto: v.veredicto, razon: v.razon };
          if (v.veredicto === 'falso-positivo') {
            descartados += 1;
            // Persistimos igual (bucle de resultado) pero NO entra como activo ni a la KB.
            await recordHallazgo({
              auditId,
              codeVersion,
              subsistema,
              severidad: draft.severidad,
              estado: 'falso-positivo',
              titulo: draft.titulo,
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
        errores.push(`verificador (${subsistema}): ${(e as Error).message}`);
      }
    }
    const h = await recordHallazgo({
      auditId,
      codeVersion,
      subsistema,
      severidad: draft.severidad,
      estado,
      titulo: draft.titulo,
      descripcion: draft.descripcion,
      evidencia: draft.evidencia,
      fixPropuesto: draft.fixPropuesto,
      confianza: draft.confianza,
      verificacion,
    });
    persistidos.push(h);
    // Reflejar a la KB como Evento (tipo hallazgo-auditoria): entra al grafo y
    // las próximas auditorías del mismo subsistema lo verán (evolución).
    void recordEvent({
      vault: 'dev',
      subsistema: subsistema as KbSubsistema,
      tipo: 'hallazgo-auditoria',
      entidad: {},
      severidad: draft.severidad,
      estado,
      titulo: draft.titulo,
      contenido: `${draft.descripcion}\n\n**Evidencia:** ${draft.evidencia}\n\n**Fix propuesto:** ${draft.fixPropuesto}`,
      fuente: `deepAudit:${auditId}`,
      confianza: draft.confianza,
      tags: ['hallazgo-auditoria', subsistema, draft.severidad],
    });
  }

  // 5. Síntesis (IA superior) sobre los hallazgos que sobrevivieron.
  let sintesis: Sintesis | null = null;
  if (persistidos.length > 0) {
    try {
      sintesis = await runSynthesis({ hallazgos: persistidos, model });
      llamadas += 1;
    } catch (e) {
      errores.push(`síntesis: ${(e as Error).message}`);
    }
  }

  // 6. Actualizar caché de último audit (para el ahorro de la próxima vez).
  const nextLast: LastAuditMap = { ...lastAudit };
  for (const s of subsistemas) nextLast[s] = { codeVersion, ts };
  await writeLastAudit(nextLast);

  // Persistir un resumen del informe (incl. síntesis) para la vista Consejo en
  // /admin — captura tanto las auditorías manuales como las automáticas.
  await writeLastAuditReport({
    ts,
    codeVersion,
    depth,
    subsistemasAuditados: subsistemas,
    totalHallazgos: persistidos.length,
    descartados,
    sintesis: sintesis
      ? {
          resumenEjecutivo: sintesis.resumenEjecutivo,
          topHallazgos: sintesis.topHallazgos,
          proximoPaso: sintesis.proximoPaso,
        }
      : null,
  }).catch(() => {});

  return {
    auditId,
    ts,
    codeVersion,
    depth,
    subsistemasAuditados: subsistemas,
    subsistemasSalteados: salteados,
    hallazgos: persistidos,
    descartados,
    sintesis,
    llamadas,
    errores,
  };
}
