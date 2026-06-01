# 🧭 CONTEXTO — el "por qué" (lo que no está en el código)

> Doc curado para que un chat nuevo entienda la INTENCIÓN, no solo el código.
> Léelo junto a `HANDOFF.md` (qué se hizo) y `CONOCIMIENTO.md` (el Cerebro).
> Denso a propósito. Si algo no está acá ni en el código → pregúntale al owner.

## 1. Visión: para quién y para qué
**Video Factory** es una herramienta **interna** para que el **owner (no técnico)** y su
socio generen **ads verticales 9:16** (TikTok/Reels) para marcas D2C (Vitaly, Nelo, y
productos como la clorofila). El objetivo profundo, repetido por el owner:

> "Que la herramienta lo haga **TODO sola**, que cualquiera pueda apretar Generar y salga
> bien, **sin depender de ti** (Claude haciéndolo a mano)."

3 modos: **Crear** (guión→video), **Ripear** (copiar un ad que funciona y adaptarlo a tu
producto), **Aprender** (video→estilo reutilizable).

## 2. Qué hace que un video salga "BIEN" (dirección creativa)
- **Misma persona** en todas las escenas (identidad consistente). **Nunca collage/grid** —
  un solo cuadro por escena. El owner odia el "collage".
- **Alineación escena↔narrador PERFECTA**: cuando la voz dice X, se ve X. Para el owner esto
  "es un error que NO puede suceder jamás".
- **Densidad** de escenas + **micro-escenas donde importan**: si el guión enumera ("cara,
  abdomen y piernas") → un plano corto por ítem. **Seleccionable**, no automático.
- **Ken Burns y micro-escenas = OPT-IN** (el usuario elige). Nunca por defecto.
- **Ripear = replicar las MISMAS escenas** (misma composición y orden), cambiando solo lo
  pedido (estilo / idioma / producto), iterando hasta ~95% de similitud. NO es una
  reinterpretación libre — eso ya se corrigió una vez.
- Estilos de referencia vividos: el **"LODO LINFÁTICO"** (UGC + CGI macro del cuerpo), el
  **rip Pixar fiel**, y el pendiente **"clorofila cartoon visceral"** (grotesco: intestinos
  inflamados, estómagos explotando — para el socio Mirko; falta script de Slack + ref visual).

## 3. Decisiones clave + su POR QUÉ (no solo el qué)
- **Todo a la carta / opt-in** → el usuario controla (voz, subtítulos, animación, Ken Burns,
  micro-escenas). No decidir por él.
- **El Copilot NO ve datos internos** (proveedores/claves/rutas) → seguridad + es de cara al
  usuario. PERO sí ve un **catálogo** (marcas/estilos con ids) → para armar briefs reales.
- **Mixeo cross-usuario DIFERIDO** → es prematuro (hoy ~22 datos de 1 usuario). Primero el
  prerequisito: **unificar el storage** (hecho). El cerebro común espera datos reales.
- **Saneador de voseo determinista** → "español neutro" es la **regla #1** y el modelo a
  veces se escapa; hace falta una red de seguridad, no solo el prompt.
- **Nada se auto-aplica al código** → el cerebro **propone**, el owner **aprueba**. Siempre.
- **Auditar con AGENTES adversariales > revisar "inline"** → los bugs reales de esta sesión
  (seguridad, validador muerto, saneador roto) salieron de **agentes especializados con
  mandato "encuentra un bug"**, no de revisar de corrido. Por eso el Cerebro (CONOCIMIENTO.md).
- **Honestidad brutal** → distinguir siempre "qué está hecho y verificado" vs "qué es manual
  / riesgoso / no probado". El owner lo valora más que el optimismo.

## 4. Preferencias y forma de trabajar del owner
- **Respuestas CORTAS, "para doomies"** (no técnico). Nada de muros de texto.
- **Ejecutar autónomo**: "hazlo todo tú", "déjalo perfecto", "esfuérzate".
- **Verificar A FONDO**: que no se caiga nada. Quiere ver la **revisión de cada punto**.
- **Español neutro SIEMPRE, JAMÁS voseo** (nada de tenés/querés/mirá/dale). Verificar cada texto.
- **NUNCA `git push`** sin pedido explícito. **Commits locales OK** como checkpoints.
- Le importa mucho el **chat IA / Copilot robusto** (prioridad histórica #1).
- Piensa en grande (multi-usuario, cerebro común, agentes que predicen) — pero acepta hacerlo
  **por fases** cuando le explicas el porqué con honestidad.

## 5. El norte ahora
Construir la **Base de Conocimiento** (el "Cerebro Obsidian", ver `CONOCIMIENTO.md`) por
fases: que **todo quede registrado y ubicable**, que unos **agentes especializados** auditen
a fondo cuando el owner lo pide, una **IA superior** los coordine, y que **evolucione con el
uso** — gastando lo mínimo (solo la recolección es automática). Fase 0 en curso.

## 6. Cómo evitar errores (la garantía real)
No es tener "memoria perfecta" — es **disciplina**: el chat nuevo **lee el código** (fuente de
verdad), usa los docs como **mapa**, y **verifica** (typecheck/tests/leer) **antes de actuar**.
Los errores nacen de actuar sobre suposiciones; verificar los mata.
