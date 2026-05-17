# 📚 docs/ — Índice de documentación de Video Factory

Esta carpeta contiene **toda la documentación** del proyecto: análisis generados, instrucciones, y las **fuentes originales** que les dieron origen.

---

## 📄 Documentos principales (generados por Claude)

| Archivo | Qué es | Tamaño |
|---|---|---|
| [`analisis_videos_referencia.md`](./analisis_videos_referencia.md) | Análisis profundo de 4 videos de referencia (Dr. Tanaka / 5-carnosina / reflujo) | 15 KB |
| [`analisis_videos_ugc.md`](./analisis_videos_ugc.md) | Análisis de 2 videos UGC MOFU Product Aware (producto Nelo / papada) | 6 KB |
| [`instrucciones_cowork.md`](./instrucciones_cowork.md) | Instrucciones de preparación del proyecto (los 2 prompts para Cowork y Claude Code) | 11 KB |

> El **`DOCUMENTO_MAESTRO.md`** (fuente de verdad técnica del proyecto) vive en la raíz, no acá.

---

## 📁 sources/ — Material fuente original

Las **fuentes originales** que el chat de Claude usó para generar los análisis. Acá las dejamos para poder **actualizar** los análisis si los materiales cambian en el futuro.

Estructura:

```
sources/
├── investigacion/         (2 informes analíticos en .docx)
├── briefs/                (3 briefs de batches en .docx)
└── videos_referencia/     (5 .mp4 — videos de referencia y demás)
```

Ver detalle completo en [`sources/README.md`](./sources/README.md).

> **Nota:** `docs/sources/**/*.mp4` y `*.docx` están en `.gitignore`. No se versionan (son pesados). Si querés sincronizarlos en otra máquina, copiá manualmente o agregalos a un storage externo (Drive, S3, etc).

---

## 🔄 Flujo de actualización

Cuando el chat de Claude genera versiones nuevas de los análisis o documentos:

1. Descargar los nuevos `.md` / `.docx` / `.mp4` desde Claude
2. **Reemplazar** los archivos correspondientes en esta carpeta (manteniendo los mismos nombres)
3. Hacer commit si cambió un `.md` versionado
4. Las fuentes en `sources/` no se commitean (gitignored), simplemente se sobrescriben

---

## 🔗 Origen

Todo este material salió del chat de Claude:
**"MVP de editor de videos B ROLL con arquitectura modular"**
URL: https://claude.ai/chat/91a272e0-0e1a-4ecb-864f-b5b8dfdd49f1
