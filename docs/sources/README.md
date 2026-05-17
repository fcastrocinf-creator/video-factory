# 📁 sources/ — Material fuente original del chat

Acá viven las **fuentes originales** (informes, briefs, videos) que el chat de Claude analizó para generar los `.md` del proyecto. Sirven como:

- 🔄 **Referencia para futuras actualizaciones** (si cambian, regeneramos los `.md`)
- 📦 **Respaldo local** del material que pasamos al chat
- 🎬 **Ejemplos visuales** para Claude Code cuando construya el pipeline

> Originales también están en `C:\Users\cmktc\Downloads\` (copiados, no movidos). Si limpiás Descargas, esta carpeta es el respaldo.

---

## 📂 investigacion/

Los 2 informes analíticos de la fase de research inicial.

| Archivo (acá)                                  | Nombre original (Descargas)                                                                                            | Tamaño |
|---|---|---|
| `informe_mvp_one_click_b_roll.docx`            | `Informe analítico para un MVP one-click de vídeos FULL IA con B-roll, TTS y scraping de scripts gana.docx`            | 53 KB |
| `informe_videos_full_ia_automatico.docx`       | `Informe analítico sobre creación de videos FULL IA para una herramienta de generación casi automátic.docx`            | 112 KB |

**Para qué sirven:** Definen el alcance, stack técnico recomendado y el "porqué" del proyecto. Son la base que se cristalizó en el `DOCUMENTO_MAESTRO.md`.

---

## 📂 briefs/

Briefs específicos de batches creativos (referencia para qué tipo de output esperamos).

| Archivo                                                | Tamaño |
|---|---|
| `BATCH_78_VIDEOS_1_Y_2.docx`                           | 13 KB  |
| `BRIEF_BATCH_A_VIDEO_1_El_test_del_dedo.docx`          | 19 KB  |
| `BRIEF_BATCH_A_VIDEO_2_El_espejo_de_la_manana.docx`    | 20 KB  |

**Para qué sirven:** Muestran cómo se redactan los briefs en producción. Útil para el Bloque del pipeline que recibe el guión.

---

## 📂 videos_referencia/

Videos de muestra que se analizaron para definir el estilo y formato del output.

| Archivo                              | Identificación según los análisis                                              | Tamaño  | Origen |
|---|---|---|---|
| `974753215487923_video_0.mp4`        | **Video #1** del análisis · 3D Pixar/Disney — Doctor asiático animado (5:26)   | 40 MB   | Chat (attachment) |
| `1281142893553184_video_0.mp4`       | **Video #2** del análisis · Foto-realista AI — Monje budista (2:25)            | 11 MB   | Descarga directa (no estaba en chat) |
| `1323127946346027_video_0.mp4`       | ❓ No identificado en los análisis. Verificar manualmente.                     | 12 MB   | Descarga directa |
| `VIDEO_2.mp4`                        | Renombrado de "VIDEO 2.mp4" del chat. Sin identificar — abrir para ubicar.    | 30 MB   | Chat (attachment) |
| `Video_3.mp4`                        | Renombrado de "Video 3.mp4" del chat. Sin identificar — abrir para ubicar.    | 27 MB   | Chat (attachment) |

**Para qué sirven:** Plantillas de estilo visual y narrativo. El pipeline tiene que poder producir output similar.

---

## ⚠️ Faltantes detectados

Estos archivos aparecen en el chat o en los análisis pero **NO están en Descargas**:

| Falta                                                 | Dónde se menciona                              | Acción sugerida |
|---|---|---|
| `995610209889718_video_0.mp4`                         | Chat (attachment x2) y análisis (Video #3 — Cartoon vintage) | Re-descargar del chat |
| Video con ID `27746426...`                            | Análisis (Video #4 — Acuarela ilustrada)       | Buscar fuente original |
| `UGC_-_OBJECIONES_-_MOFU_-_PRODUCT_AWARE_V1.mp4`     | Chat (attachment) — análisis UGC V1            | Re-descargar del chat |
| `UGC_-_OBJECIONES_-_MOFU_-_PRODUCT_AWARE_V2.mp4`     | Chat (attachment) — análisis UGC V2            | Re-descargar del chat |

> Si los descargás, tirá los `.mp4` en `videos_referencia/` con el nombre original.

---

## 🔄 Cómo actualizar las fuentes

1. Descargar el nuevo archivo desde Claude/donde sea
2. Reemplazar el archivo correspondiente acá (mismo nombre)
3. Si cambia mucho, regenerar los `.md` de análisis hablando con el chat
4. Como están en `.gitignore`, no requieren commit

---

*Última actualización: 17 de mayo de 2026*
