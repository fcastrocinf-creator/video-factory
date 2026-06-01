# 🧠 Base de Conocimiento + Auditores Especializados (el "Cerebro Obsidian")

> Spec ejecutable. Diseñado para construirse **al hilo** y quedar **funcional**.
> Extiende (no reemplaza) el "cerebro evolutivo" M7 ya existente (preset-judgment-memory,
> prompt-evolution, owner-feedback). Fecha: 2026-06-01.

## 0. Objetivo (en una frase)
Que "**revisa a profundidad**" sea de verdad profundo y **evolucione**: toda la actividad
queda **registrada y ubicable** (lógica Obsidian: nodos enlazados), unos **agentes
especializados** la auditan a fondo cuando el owner lo pide, una **IA superior** los
coordina y decide, y todo **aprende del uso** — gastando lo mínimo (solo la recolección es
automática; el análisis caro es on-demand).

## 1. Principios (lo que pidió el owner + los gaps del arquitecto)
1. **Todo registrado + ubicable** — cada cosa que pasa es un nodo con dirección estable.
2. **Agentes especializados que evolucionan** con el uso real.
3. **IA superior** que conversa con cada especialista en su idioma, arma un contexto casi
   perfecto (sin omitir) y decide.
4. **On-demand**: solo la **recolección** es automática; análisis/agentes corren cuando el
   owner lo dice. (Ahorro.)
   - (gap) **Curación señal/ruido** — pesar qué importa; sin esto la base es un pantano.
   - (gap) **Esquema/idioma común** — columna vertebral del grafo.
   - (gap) **Procedencia + frescura** — de dónde salió, cuándo, atado al commit del código.
   - (gap) **Bucle de resultado** — registrar si un hallazgo fue real/falso → los agentes
     aprenden su propia precisión.
   - (gap) **2 vaults**: `dev` (bugs/código) y `producto` (uso/feedback).

## 2. El nodo: esquema común (`Evento`) — el "idioma" del grafo
Toda pieza registrada es un `Evento` con esta forma (contratos en `packages/contracts`):
```ts
interface Evento {
  id: string;            // estable y direccionable: `<tipo>/<YYYY-MM-DD>/<uuid8>`
  ts: string;            // ISO — cuándo
  codeVersion: string;   // git short hash o fecha — FRESCURA (gap procedencia)
  vault: 'dev' | 'producto';
  subsistema: 'pipeline' | 'validator' | 'chat' | 'aprendizaje' | 'compositor'
            | 'seguridad' | 'ux' | 'image-gen' | 'animacion' | 'otro';
  tipo: 'bug' | 'hallazgo-auditoria' | 'feedback' | 'decision' | 'metrica'
      | 'juicio-preset' | 'sugerencia' | 'chat' | 'run-evento';
  entidad: { brandId?: string; presetId?: string; runId?: string;
             sceneIndex?: number; userId?: string };  // a qué se ancla → links del grafo
  severidad?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  estado?: 'abierto' | 'confirmado' | 'falso-positivo' | 'arreglado' | 'descartado';
  titulo: string;
  contenido: string;     // markdown legible (Obsidian)
  enlaces: string[];     // ids de otros Evento relacionados (el grafo)
  fuente: string;        // procedencia: 'auditor:chat' | 'user:copilot' | 'pipeline:run-failed' | 'owner:feedback'
  confianza?: number;    // 0..1 — curación
  tags: string[];
}
```

## 3. Storage (sobre el `storage/` ya UNIFICADO vía `VF_STORAGE_DIR`)
```
storage/kb/
  eventos/<subsistema>.jsonl     # append-only, un archivo por subsistema
  indice/
    por-entidad.json             # brandId|presetId|runId -> [eventId]   (ubicar)
    por-subsistema.json
    por-tag.json
  hallazgos/findings.jsonl       # resultados de auditorías + su desenlace (bucle)
  notas/                         # vista Obsidian (markdown generado, opcional)
    presets/<presetId>.md  runs/<runId>.md  brands/<brandId>.md
```

## 4. Capa 1 — Recolección (AUTOMÁTICA, cero IA, barata) ← se construye PRIMERO
Una sola función, ruteo de todo lo que ya emitimos:
```ts
// apps/web/lib/kb/record.ts
export async function recordEvent(e: Omit<Evento,'id'|'ts'|'codeVersion'>): Promise<void>;
```
- Wrappea/normaliza los emisores que YA existen al esquema `Evento` + actualiza el índice:
  - `chat-log.ts` → tipo `chat` (vault producto)
  - `system-log.ts` → tipo `run-evento`
  - `preset-judgment-memory` → tipo `juicio-preset`
  - `/api/sugerencias` → tipo `sugerencia`
  - `owner-feedback` → tipo `feedback`
  - pipeline run-success/run-failed → tipo `run-evento` (+ métricas)
- **Cero IA**, solo `appendFile` + índice. Best-effort (nunca rompe el flujo).
- `codeVersion` se obtiene 1 vez al boot (git short hash) y se cachea.

## 5. Capa 2 — Consulta / ubicación ("saber dónde está")
```ts
// apps/web/lib/kb/query.ts
export async function query(f: Partial<{ subsistema; tipo; entidad; tag; estado; desde; hasta }>): Promise<Evento[]>;
// Pre-digiere: arma un contexto CHICO y preciso para un agente (no dumps crudos) = el ahorro.
export async function buildContextFor(scope: { subsistema?; entidad? }, maxChars=4000): Promise<string>;
```
- (Opcional) generar `notas/*.md` para vista humana tipo Obsidian + una pestaña en `/admin`.

## 6. Capa 3 — Auditoría profunda (ON-DEMAND): especialistas + IA superior
Operación `deepAudit(scope?)` — corre **solo cuando el owner lo pide**:
```ts
// apps/web/lib/kb/deep-audit.ts  (usa el Agent/Workflow tool)
export async function deepAudit(scope?: { subsistemas?: string[] }): Promise<AuditReport>;
```
Pipeline **estructurado** (más confiable y barato que "chat libre entre agentes"):
1. **IA superior (orquestador)** elige qué especialistas invocar según `scope`
   (default: solo los subsistemas que cambiaron desde el último audit — vía `codeVersion`/git diff).
2. Cada **especialista** (pipeline / validator / chat / aprendizaje / compositor / seguridad)
   recibe un **contexto chico y a su medida** (`buildContextFor`) + el código relevante,
   con mandato **adversarial**: "encuentra un bug, asume que existe". Devuelve hallazgos
   en esquema `Evento` (tipo `hallazgo-auditoria`).
3. Un **verificador adversarial** intenta **refutar** cada hallazgo high/critical → mata
   falsos positivos (curación señal/ruido).
4. La **IA superior** sintetiza: dedup, cross-check, ranking, **reporte final + fixes
   propuestos** (NUNCA auto-aplica; el owner aprueba).
5. Todos los hallazgos → `hallazgos/findings.jsonl` con su `estado`.

> "Comunicación entre agentes" = este pipeline (encontrar → refutar → sintetizar).
> "IA superior conversa con cada uno en su idioma" = a cada especialista le da su prompt
> de dominio + su rebanada de la KB. Contexto casi perfecto, sin omitir, pero CHICO.

## 7. Capa 4 — Evolución (aprendizaje compartido)
- Cuando un hallazgo se **confirma/arregla/descarta** → se actualiza su `estado` en `findings.jsonl`.
- Cada especialista, al correr, recibe: (a) hallazgos **confirmados** previos de su subsistema
  (sabe dónde se concentran los bugs), (b) su **tasa de falsos positivos** histórica. → afina solo.
- **Curación:** un hallazgo sube de `confianza` cuando se **repite** o lo confirma el owner;
  baja si fue falso-positivo. Solo lo de alta confianza entra al contexto "casi perfecto".

## 8. Ahorro (costos) — explícito
- Recolección = **cero IA**.
- `deepAudit` = **solo on-demand**, **scoped** (subsistema cambiado), **cacheado** (salta código sin cambios).
- Contexto **pre-digerido** (chico, no dumps) → cada agente gasta poco.
- Nº de especialistas/verificadores configurable (budget).

## 9. Fases de construcción (en este orden = "al hilo")
- **Fase 0 — Cimiento (barato, automático):** esquema `Evento` + `recordEvent` + ruteo de
  emisores actuales + índice. ← *empezar acá.*
- **Fase 1 — Consulta:** `query()` + `buildContextFor()` + (opcional) vista `/admin` + notas md.
- **Fase 2 — Auditoría on-demand:** `deepAudit` (orquestador + especialistas + verificador + síntesis).
- **Fase 3 — Evolución:** bucle de resultado + augmentación de prompts + curación.

## 10. Automático vs on-demand (resumen)
| Pieza | ¿Cuándo corre? | ¿Usa IA? |
|---|---|---|
| Recolección (`recordEvent`) | siempre, automático | no |
| Índice | siempre, automático | no |
| `query` / `buildContextFor` | cuando se pide | no |
| `deepAudit` (especialistas + IA superior) | **solo cuando el owner lo dice** | sí |
| Bucle de resultado / curación | al confirmar un fix | no (salvo síntesis) |

---
**Regla de oro:** nada se auto-aplica al código. La IA superior **propone**; el owner aprueba.
La recolección es lo único automático.
