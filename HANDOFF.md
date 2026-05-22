# HANDOFF — Video Factory · Orquestador de composición

> Documento de traspaso entre conversaciones de Claude Code.
> Para continuar: abre un chat nuevo en este proyecto y di **"lee HANDOFF.md y seguimos"**.
> Última actualización: 2026-05-20.

---

## 0. RESUMEN EJECUTIVO — dónde estamos

Se completó el **orquestador de composición** en 4 fases (todas con typecheck verde, código en disco):

1. **Fase 1** — Motor de composición libre (geometría arbitraria, no solo grids)
2. **Fase 2** — Detector de geometría exacta del video original
3. **Fase 3** — Editor manual de composición (canvas drag/resize/rotar + re-render)
4. **Fase 4** — Loop de aprendizaje (la IA aprende de las correcciones manuales)

**TODO el código está escrito, guardado y typechequeado.** NADA se ha probado en
runtime todavía porque falta **habilitar el billing de Google Cloud**.

### Próximo paso inmediato
1. Habilitar billing en GCP (proyecto `gen-lang-client-0913919937`)
2. Disparar un rip de prueba (~$2.50 de gpt-image-1)
3. Abrir el editor `/runs/{id}/editor` y validar todo el flujo end-to-end

---

## 1. EL PROYECTO

**Video Factory** — herramienta interna para generar videos verticales 9:16 (ads
TikTok/Reels) para marcas D2C (Vitaly, Nelo).

- **Ruta:** `C:\Users\cmktc\proyectos\video-factory`
- **Stack:** monorepo TypeScript · Next.js 14 · Remotion 4.x · Drizzle ORM + libsql · pnpm
- **Funcionalidad "Ripear":** toma el video de un anuncio existente y genera uno
  nuevo, adaptado al producto propio, replicando estructura y estilo.

**Flujo del pipeline (rip alta fidelidad):**
`script-processor → narrator-analyzer → tts-elevenlabs → subtitles-google →
scene-planner → rip-fidelity-aligner → compositor-remotion → final.mp4`

---

## 2. ESTADO ACTUAL — LAS 4 FASES DEL ORQUESTADOR

### Fase 1 — Motor de composición libre ✅
Antes solo existían layouts rígidos (grid-2x2, etc.). Ahora hay posicionamiento
arbitrario:
- **`CompositeElement`** (en `packages/contracts/src/scene.schema.ts`): cada pieza
  tiene `rect {xPct,yPct,widthPct,heightPct}`, `rotationDeg`, `opacity`, `zIndex`,
  `fit`, `cornerRadiusPct`, `startSeconds/endSeconds`, `textOverlay`, `manuallyAdjusted`.
- **`Scene.composition: CompositeElement[]`** — cuando está poblada, tiene prioridad.
- **`FreeformComposite` + `FreeformElement`** (en `PlanoEscenas.tsx`): componentes
  Remotion que renderizan geometría arbitraria (collage irregular, PiP, overlays).

### Fase 2 — Detector de geometría exacta ✅
- El detector (`composite-layout-detector.ts`) ahora devuelve `rect {x,y,w,h}` en %
  por cada panel — la geometría REAL del original, no una plantilla genérica.
- `generateCompositeScene` (en `rip-fidelity-aligner.ts`) construye un
  `CompositeElement[]` con esas coordenadas y lo propaga a `scene.composition`.

### Fase 3 — Editor manual ✅
- **Página:** `/runs/[id]/editor` — canvas 9:16 con drag (mover), handles de
  esquina (redimensionar), inputs de rotación/opacidad/capa/borde, lista de capas,
  duplicar/eliminar piezas, "crear composición" desde cero.
- **Endpoints:**
  - `GET/PUT /api/runs/[id]/composition` — lee/guarda la composición (scene-plan.json)
  - `GET /api/runs/[id]/scene-asset?file=...` — sirve imágenes del workDir al canvas
  - `POST /api/runs/[id]/rerender` — re-renderiza el video con la composición editada
- **Re-render:** regenera el `final.mp4` SIN regenerar imágenes (solo Remotion, rápido y barato).
- **Persistencia:** el pipeline ahora guarda `scene-plan.json` y `render-job.json`
  en el workDir del run (antes NO se persistía el sceneTrack).
- Botón "Editor de composición" agregado en la página del run (`RunViewer.tsx`).

### Fase 4 — Loop de aprendizaje ✅
- **`packages/core/src/composition-memory.ts`**: registra cada corrección manual
  como par (geometría que propuso la IA ↔ geometría final del humano).
  Storage append-only en `storage/composition-memory/corrections.jsonl`.
- El `PUT /composition` compara lo guardado contra la propuesta original de la IA
  (`render-job.json`) y registra la corrección (`diffComposition`).
- El detector de geometría carga las correcciones relevantes
  (`queryRelevantCompositionCorrections`) y las inyecta como ejemplos few-shot en
  su prompt → con cada edición manual, el modo automático mejora.

---

## 3. HISTORIAL DE ESTA SESIÓN — bugs encontrados y arreglados

Antes de las 4 fases hubo una larga sesión de debugging corriendo 4 rips. Bugs:

### Bug 1 — Validación muerta y silenciosa
El detector de composites y el reviewer usaban `gemini-2.5-pro`, cuyo quota diario
(1000 req) se agotó. Cuando fallaban, caían **silenciosamente** a "todo OK" — por
eso pasaban grids con texto gibberish sin que nadie se enterara.
**Fix:** detector + reviewer migrados a `gemini-2.5-flash` (10K req/día), con
logging visible de fallbacks, retry con backoff exponencial, y `maxOutputTokens`.

### Bug 2 — Next.js cacheaba módulos viejos
Tras editar los `lib/*.ts`, el dev server seguía ejecutando el código antiguo.
**Fix:** reiniciar el `pnpm dev`. (Gotcha recurrente — ver sección 8.)

### Bug 3 — ROOT CAUSE: el preset le pedía texto a la IA
El preset `learned-vitaly-media-23faa1f14cc9-bfd664eb` tenía en su `promptTemplate`:
> "Text overlays are bright green, high-contrast TikTok style, driving the key messages."

Le pedía **activamente** al generador que incrustara texto verde tipo TikTok.
**Fix:** se reescribió el `promptTemplate` y el `negativePrompt` del preset
(`packages/presets/pending/learned-vitaly-media-23faa1f14cc9-bfd664eb.preset.json`)
— quitando esa línea, el `#39FF14`, y agregando `text, caption, split-screen,
grid, collage` al negative prompt.

### Otros fixes
- **Anti-composite/anti-text prefix:** cuando el reviewer rechaza una imagen por
  composite/texto alucinado, se inyectan directivas explícitas al INICIO del
  prompt de regeneración (los image generators respetan más las primeras palabras).
- **Auto-escalado a composite:** si el generador alucina grids de forma
  persistente (todos los attempts rechazados por composite), el aligner deja de
  pelear y escala la escena a generación composite real (panel por panel) —
  `hallucinatedCompositePersistently` en `rip-fidelity-aligner.ts`.
- **`expectedSingleShot`:** flag que el reviewer usa para rechazar composites
  cuando se esperaba un plano único.
- **`grid-3x2`:** layout de 6 paneles agregado al schema/detector/renderer.

### Último run exitoso
`f4c6fe8f-cf73-435a-a6f9-f45bfbd0fca8` — 50 imágenes, video 128s, SIN texto
gibberish (gran mejora vs. runs anteriores). Aún tenía algunas escenas composite
no deseadas — eso lo resuelve el auto-escalado + las 4 fases nuevas.

---

## 4. ARCHIVOS CLAVE DE ESTA SESIÓN

### Creados
| Archivo | Qué hace |
|---|---|
| `apps/web/app/api/runs/[id]/composition/route.ts` | GET/PUT de la composición + registro de aprendizaje |
| `apps/web/app/api/runs/[id]/scene-asset/route.ts` | Sirve imágenes del workDir al canvas del editor |
| `apps/web/app/api/runs/[id]/rerender/route.ts` | Dispara el re-render |
| `apps/web/lib/rerender-composition.ts` | Función de re-render (solo compositor) |
| `apps/web/app/(app)/runs/[id]/editor/page.tsx` | Página del editor |
| `apps/web/app/(app)/runs/[id]/editor/CompositionEditor.tsx` | UI del editor canvas |
| `packages/core/src/composition-memory.ts` | Loop de aprendizaje (registro + query + diff) |

### Modificados
| Archivo | Cambio |
|---|---|
| `packages/contracts/src/scene.schema.ts` | `CompositeElement`, `Scene.composition`, `grid-3x2` |
| `apps/web/lib/composite-layout-detector.ts` | flash, `rect`, retry, logging, `DetectContext`, lessons |
| `apps/web/lib/scene-reviewer.ts` | flash, `expectedSingleShot`, retry, maxOutputTokens, logging |
| `apps/web/lib/rip-fidelity-aligner.ts` | detección composite, auto-escalado, `composition` |
| `packages/blocks/compositor-remotion/src/compositions/PlanoEscenas.tsx` | `CompositeFrame`, `FreeformComposite` |
| `packages/blocks/compositor-remotion/src/block.ts` | proyecta `composition` a `CompositeElementVisual` |
| `packages/blocks/compositor-remotion/src/index.ts` | exports nuevos |
| `apps/web/lib/pipeline.ts` | persiste `scene-plan.json` + `render-job.json` |
| `apps/web/app/(app)/runs/[id]/RunViewer.tsx` | botón "Editor de composición" |
| `packages/core/src/index.ts` | export `composition-memory` |
| `packages/presets/pending/learned-vitaly-...preset.json` | `promptTemplate` corregido |

> Estado git: hay cambios sin commitear. NO se ha hecho commit todavía — decidir
> si commitear antes o después de la prueba en runtime.

---

## 5. BUG PENDIENTE — BILLING DE GOOGLE CLOUD

Sin billing, el detector y el reviewer caen con error 429 (quota agotada). Los
retries con backoff lo mitigan pero NO lo eliminan.

- **Proyecto GCP:** `gen-lang-client-0913919937`
- **Vincular billing:** `https://console.cloud.google.com/billing/linkedaccount?project=gen-lang-client-0913919937`
- **Crear cuenta de billing (si no hay):** `https://console.cloud.google.com/billing/create`
- **Habilitar Vertex AI:** `https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=gen-lang-client-0913919937`
- **AI Studio (fallback) upgrade:** `https://aistudio.google.com/app/apikey`

Con billing: gemini-2.5-flash sube de 1K a límites altísimos; Vertex deja de ser
intermitente. Costo de visión por rip: centavos. El grueso del costo sigue siendo
gpt-image-1 (~$2/rip).

---

## 6. PRÓXIMOS PASOS CONCRETOS

1. **Habilitar billing GCP** (sección 5).
2. **Reiniciar el localhost** si no está arriba (sección 7).
3. **Disparar un rip de prueba** (sección 7) — esto genera un run con
   `scene-plan.json` y `render-job.json`.
4. **Verificar en los logs del dev server:**
   - `rip-aligner:composite_detected` con geometría
   - `rip-aligner:freeform_composition_built` (Fase 2)
   - `rip-aligner:escalating_to_composite` (auto-escalado, si aplica)
   - que NO aparezcan `FALLBACK` del detector/reviewer (señal de quota OK)
5. **Abrir el editor:** `/runs/{nuevoRunId}/editor` — probar mover/redimensionar
   piezas, "Guardar", "Re-renderizar".
6. **Verificar el loop de aprendizaje:** tras guardar una edición, debe aparecer
   `storage/composition-memory/corrections.jsonl` con la corrección registrada.
7. **Opcional:** commitear todo el trabajo de la sesión.

---

## 7. DETALLES OPERATIVOS

### Levantar el localhost
```
cd C:\Users\cmktc\proyectos\video-factory
pnpm --filter '@video-factory/web' dev
```
Corre en `http://localhost:3000`. **Gotcha:** al cambiar archivos `lib/*.ts` a
veces hay que reiniciarlo para que tome los cambios (Next.js cachea módulos server).

### Autenticación
- `POST /api/auth` con body `{"password": "<APP_PASSWORD del archivo .env>"}`
- Devuelve cookie `app_auth`. El password está en `.env` (raíz del repo).

### Disparar un rip de prueba
```
POST /api/rip/27ad591c-ad6c-4975-ba92-59f25e06dfda/rip
Body: {
  "brandId": "vitaly",
  "presetId": "learned-vitaly-media-23faa1f14cc9-bfd664eb",
  "productId": "vitaly_gotas",
  "fidelityMode": "high"
}
```
- **Rip ID de prueba:** `27ad591c-ad6c-4975-ba92-59f25e06dfda` (video `media-23faa1f14cc9.mp4`)
- El rip corre en background (~25-35 min). Devuelve un `runId`.

### Consultar estado de un run (DB)
```
cd apps/web && node -e "const {createClient}=require('@libsql/client');const c=createClient({url:'file:../../db/local.db'});(async()=>{const r=await c.execute({sql:\"SELECT id,status,current_step,progress,image_count FROM runs ORDER BY started_at DESC LIMIT 5\",args:[]});console.log(JSON.stringify(r.rows,null,2));})();"
```

### Datos clave
- **DB:** `db/local.db` (libsql), `DATABASE_URL=file:./db/local.db`
- **Último run exitoso:** `f4c6fe8f-cf73-435a-a6f9-f45bfbd0fca8`
- **Brand de prueba:** `vitaly` (`packages/brands/vitaly.brand.json`)
- **Preset de prueba:** `learned-vitaly-media-23faa1f14cc9-bfd664eb`
- **GCP credenciales:** `GOOGLE_APPLICATION_CREDENTIALS=C:\Users\cmktc\.gcp\video-factory-sa.json`
- **Modelos de visión:** detector + reviewer usan `gemini-2.5-flash`

### Typecheck
```
pnpm -r typecheck        # los 16 paquetes — actualmente TODO verde
```

---

## 8. GOTCHAS / COSAS QUE SABER

- **Next.js cachea módulos server:** tras editar `lib/*.ts`, reiniciar `pnpm dev`
  si el cambio no se refleja. (Causó el "Bug 2" de esta sesión.)
- **El editor solo funciona con runs NUEVOS:** los runs viejos no tienen
  `scene-plan.json` (la persistencia se agregó en esta sesión). Un run viejo en el
  editor muestra "404 — sin scene-plan.json", que es lo esperado.
- **Imágenes en el chat:** cuando el contexto de la conversación se satura, las
  capturas adjuntas fallan con error 400 "Could not process image". Workaround:
  guardar la captura en `C:\Users\cmktc\Desktop\claude-img\` y decir "mira" — el
  asistente lee el archivo más reciente con su lector de archivos local.
- **Preferencia de idioma:** español neutro (formas con "tú", sin argentinismos).
- **Sin billing:** cualquier rip tendrá validación degradada (detector/reviewer
  con 429). No es bug de código — es infraestructura.
- **El `learned-vitaly` preset** está en `packages/presets/pending/` — los presets
  aprendidos quedan en `pending/` hasta aprobarse en `/admin`.

---

## 9. PENDIENTES FUTUROS (no bloqueantes)

- Cargar **assets reales de marca** (fotos del producto, logo) para Vitaly: el
  schema soporta `product.referenceImagePath` pero el brand `vitaly.brand.json`
  está vacío de imágenes, y el generador hoy solo usa descripciones de texto — por
  eso los productos salen con etiquetas inventadas. Conectar las fotos reales como
  reference images al generador resolvería esto de raíz.
- Aprobar el preset `learned-vitaly` en `/admin` si se quiere usar en `/create`.
- Considerar commitear el trabajo de la sesión a git.
