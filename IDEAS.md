# IDEAS — backlog para barrer e implementar

> Acá guardamos ideas a medida que surgen. Cada una con **contexto suficiente para
> retomarla**. Más adelante hacemos un **barrido** para priorizar e implementar.
>
> Estados: 💡 idea · 🔬 en análisis · 🛠️ en implementación · ✅ hecho · ❌ descartada
>
> Cómo usar: cuando el owner "tira" una idea, se agrega abajo con el mismo formato.
> Para el barrido: leer este archivo, priorizar, y mover lo elegido a HANDOFF/tareas.

---

## Idea #1 — Multi-usuario con aprendizaje aislado + cerebro común auto-mejorable
**Estado:** 💡 idea · **Fecha:** 2026-05-31

**Qué:** cada usuario personaliza su propia herramienta vía su **login**; su aprendizaje
es **independiente** (aislado por usuario). En algún momento las bases de conocimiento
**se mixean** y toman **lo mejor de todas** → **auto-mejora colectiva**. (Los "hooks" /
info de cómo trabaja cada uno se suman después — el owner ya tiene el plan.)

**Mecanismo propuesto (owner):** una sección de "**aprendizaje**" que tome todo lo que se
ejecuta, y que tras CADA video se le pida a la persona un **comentario**.

**Recomendación (para que sirva de verdad):**
- No solo texto libre: **👍/👎 + 2-3 tags rápidos** (movimiento / alineación / densidad /
  identidad) **+** comentario libre. Lo estructurado se agrega solo; el texto libre lo lee
  Claude y extrae la lección.
- **1 clic / opcional** — si comentar es tedioso, nadie lo hace. La mayoría del aprendizaje
  sale de lo estructurado + de lo que el video logró (aprobado / editado / falló).
- **Curar antes de mixear:** cada aprendizaje se etiqueta con **a qué aplica** (preset / tipo
  de escena / paso) y solo sube al cerebro común **cuando se repite** (varios videos/usuarios
  lo confirman) → no contamina con opiniones sueltas.

**Viabilidad (honesta):** sí, ejecutable POR FASES.
- 🟢 Estándar: login + auth real + **aislar datos por usuario** (hoy single-user, cookie estática).
- 🟢 Cimiento existente: feedback loop M7 (`preset-judgment-memory`: approved/rejected/edited) +
  cerebro evolutivo (`prompt-evolution`) + confidence scores.
- 🟡 Lo difícil: el "mixea y toma lo mejor" = mecanismo de **curación**.
- ✅ Privacidad: NO es problema — todos de acuerdo (confirmado por el owner).

**Para retomar:** definir (a) modelo de datos por-usuario (userId en runs/memoria), (b) UI de
la sección "aprendizaje" + el comentario post-video, (c) regla de promoción al cerebro común.

---

## Idea #2 — "Brief guiado": formato de solicitud → confirmación → genera
**Estado:** 💡 idea · **Fecha:** 2026-06-01

**Origen:** el owner está puliendo el Copilot para que el chat guíe al usuario. Hoy, como el
chat aún no entiende lenguaje natural libre, el flujo real es: se le manda al usuario un
**formato/plantilla** de solicitud, el usuario lo completa, y la herramienta devuelve una
**salida de confirmación** antes de generar. Caso de validación: video de **clorofila**, B-roll,
estilo **"cartoon visceral"** (grotesco: intestinos inflamados, estómagos explotando), bajo el
concepto de un script que el socio (Mirko) pasó por Slack.

**Qué (feature):** un **brief guiado** dentro de la herramienta (wizard corto o el Copilot
preguntando paso a paso) que recoge: producto, guion/idea, formato, estilo, escenas obligatorias,
voz sí/no, subtítulos sí/no, duración y componentes opcionales (foto del producto real, logo,
referencia del estilo). Al final muestra una **tarjeta de confirmación** ("Voy a crear: …, ¿confirmas?")
y recién ahí **genera**. Es la versión productizada de la plantilla que hoy se manda a mano.

**Por qué sirve (cualquier usuario):** baja la barrera para no-técnicos, evita pedidos incompletos
(garantiza que llegue lo que el motor necesita: marca/preset/guion/opciones) y da sensación de
"acompañamiento". Conecta directo con el **Copilot** (que puede conducir el brief) y con la idea de
**chat que ejecuta funciones**.

**Mapeo al motor (real):** campos del brief → brandId + (category/format/style) preset + script +
voz + interruptores a la carta (voz/subtítulos/animación/kenburns) + micro-escenas. Estilos nuevos
("cartoon visceral") → preset animado más cercano + styleBase fuerte, o **Aprender estilo** desde una
referencia. Componentes (producto real / logo) → ingredients de la marca.

**Para retomar:** (a) campos mínimos del brief, (b) wizard-form vs Copilot-conversacional, (c) tarjeta
de confirmación → POST /api/generate con overrides, (d) manejar "marca/estilo no existe aún" (crear
marca rápida o pedir referencia para Aprender estilo). Primer caso de prueba: clorofila cartoon visceral.

---

<!-- Próximas ideas se agregan acá abajo con el mismo formato (## Idea #N — ...) -->
