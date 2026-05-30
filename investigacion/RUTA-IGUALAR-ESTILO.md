# Ruta para igualar un estilo de edición desde 0 (CODIFICADA)

Lo importante NO es un video puntual, sino el **cómo** se iguala visualmente un
estilo nuevo, rápido y desde cero. Esta es la ruta que descubrimos trabajando la
**frutinovela (SuperCalm)** y que ahora está metida en la lógica del aprendizaje
para que se repita sola con **cualquier** estilo nuevo.

## Los 5 pasos de la ruta

### 1. Referencia = frame REPRESENTATIVO (denso si el original lo es)
NO el "más limpio/simple". Un frame minimalista hace que un estilo rico se aprenda
pobre. Hay que elegir el frame que captura el look completo + su densidad típica.
- **Codificado en:** `pickReferenceFrameIndex` (`apps/web/lib/image-gen-tools.ts`).
  Antes era `pickCleanestFrameIndex` (sesgaba a lo simple) — ese era el error.

### 2. Generar con esa imagen de referencia (image-to-image, Nano Banana)
Anclar la generación a un frame real iguala el estilo al instante — mucho más rápido
y fiel que generar solo desde texto.
- **Codificado en:** `generateImageWithReference` (image-gen-tools) + el bloque
  `image-gen-multi` antepone un step Nano Banana cuando el preset trae referencia.

### 3. Capturar la DENSIDAD / complejidad explícita (no solo el "look")
Cuántos componentes/personajes hay por cuadro + los elementos recurrentes que hacen
rico el estilo (personajes secundarios, tipo de entorno, efectos).
- **Codificado en:** `compositionDensity` + `keyVisualComponents` en
  `video-understander.ts`; `enrichPromptWithDensity` en `auto-learn-preset.ts`
  inyecta la densidad al `promptTemplate` ("DENSE, multi-component, featuring ...").

### 4. El aprendizaje EMBEBE la referencia en el preset
Antes `visualStyle.referenceImages` quedaba **vacío** → la creación se iba a texto y
perdía todo. Ahora el aprendizaje extrae el frame representativo, lo downscalea
(512px JPEG) y lo embebe como data-URI (viaja con el preset).
- **Codificado en:** `auto-learn-preset.ts` (`frameToDataUri` + el bloque que puebla
  `referenceImages`).

### 5. Animar con intensidad ACORDE al contenido
Épico/animado → movimiento **potente** (acción dramática); talking-head/UGC → sutil
(respiración, micro-cámara). El movimiento sutil es tibio para escenas épicas.
- **Modelo de datos:** `motionIntensity` en `route-profiles.ts`
  (cartoon-3d=`powerful`, ugc-real=`subtle`).
- **PENDIENTE:** cablearlo en `scene-animator.ts` / `buildMotionPrompt` para que el
  motion prompt nazca con esa intensidad (hoy se aplicó a mano vía Kling).

## Validación
Probado a mano en la frutinovela: referencia densa + prompt denso + Kling `pro` con
motion potente → escenas idénticas en densidad al original + animación potente. La
codificación hace que **eso sea automático** al aprender cualquier estilo nuevo.

**Pendiente de validar end-to-end:** re-aprender un estilo y confirmar que el preset
sale con `referenceImages` poblado + la densidad en el prompt, automáticamente.

## Por qué importa (la regla)
El valor de la herramienta no es un video — es **la velocidad para igualar
visualmente cualquier estilo desde 0**. Esta ruta es ese activo. Mantenerla:
cualquier cambio en el aprendizaje debe preservar los 5 pasos.
