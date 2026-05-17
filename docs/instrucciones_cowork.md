# 📋 Instrucciones para Claude Cowork — Preparación del proyecto Video Factory

> Este documento contiene **dos prompts**: uno para Cowork (preparar el ambiente) y otro para Claude Code (construir el software).
>
> **Cowork SOLO prepara la carpeta, organiza archivos y verifica requisitos.** Después Claude Code construye el código.

---

## 🔧 PASO 1 — Verificar que Cowork puede acceder a tu sistema

Antes de pegar el prompt, asegurate de tener:

1. **Claude Cowork** instalado (desktop app, plan Pro o Max)
2. **Sistema operativo**: macOS o Windows
3. **Carpeta donde quieras crear el proyecto** (ejemplo: `~/Documentos/proyectos/` o `~/Desktop/`)
4. **Permiso de acceso a esa carpeta** desde Cowork (Settings → Folder Access)
5. **El archivo `DOCUMENTO_MAESTRO.md`** descargado en tu computadora (vamos a moverlo después)
6. **El archivo `analisis_videos_referencia.md`** descargado
7. **El archivo `analisis_videos_ugc.md`** descargado

---

## 🎯 PROMPT PARA CLAUDE COWORK (copiar y pegar tal cual)

```
Hola Claude Cowork. Necesito que me prepares el ambiente para un proyecto de software 
llamado "Video Factory". Tu trabajo es SOLO preparar la estructura de carpetas y mover 
archivos. NO escribas código todavía — eso lo hará Claude Code después.

CONTEXTO:
Voy a usar Claude Code después para construir un MVP de generación de videos con IA. 
Necesito que dejes todo listo en una carpeta para que cuando abra Claude Code, encuentre 
los archivos correctos en su lugar.

UBICACIÓN DEL PROYECTO:
Crealo en: [REEMPLAZAR CON LA RUTA DONDE QUIERES EL PROYECTO]
Ejemplo macOS: /Users/tu-usuario/Documents/proyectos/
Ejemplo Windows: C:\Users\tu-usuario\Documents\proyectos\

ARCHIVOS QUE YA TENGO DESCARGADOS:
Tengo estos 3 archivos en mi carpeta de Descargas (o donde los hayas puesto):
1. DOCUMENTO_MAESTRO.md
2. analisis_videos_referencia.md
3. analisis_videos_ugc.md

TAREAS A REALIZAR EN ORDEN:

TAREA 1 — Verificar requisitos del sistema:
Abrí una terminal (o usá tu herramienta de ejecución de comandos) y verificá:
a) Node.js versión 20 o superior está instalado: ejecutá `node --version`
b) pnpm está instalado: ejecutá `pnpm --version`. Si no está, ejecutá `npm install -g pnpm`
c) Git está instalado: ejecutá `git --version`
d) Reportame las versiones que encontraste. Si falta alguno, decime cuál falta — 
   no intentes instalarlo automáticamente, solo avisame.

TAREA 2 — Crear estructura de carpetas:
Dentro de la ubicación del proyecto especificada arriba, creá la carpeta `video-factory/`. 
Adentro creá esta estructura exacta:

video-factory/
├── docs/
└── (la raíz queda vacía por ahora)

TAREA 3 — Mover los archivos descargados a su lugar correcto:
Buscá en mi carpeta de Descargas (o donde estén) los 3 archivos mencionados arriba 
y movélos así:

- DOCUMENTO_MAESTRO.md          → mover a video-factory/ (raíz)
- analisis_videos_referencia.md → mover a video-factory/docs/
- analisis_videos_ugc.md        → mover a video-factory/docs/

Si no encontrás alguno de los archivos, decime cuál falta y dónde lo buscaste.

TAREA 4 — Inicializar Git:
Abrí una terminal en la carpeta video-factory/ y ejecutá:
   git init
   git branch -M main

TAREA 5 — Crear archivo .gitignore:
Creá un archivo llamado `.gitignore` en la raíz de video-factory/ con este contenido 
exacto:

# Dependencias
node_modules/
.pnpm-store/

# Build outputs
.next/
dist/
build/
*.tsbuildinfo

# Environment
.env
.env.local
.env.*.local

# Storage (archivos generados por la app)
storage/
!storage/.gitkeep

# Logs
logs/
*.log
npm-debug.log*
pnpm-debug.log*

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Database
*.db
*.db-journal

# Cache
.turbo/
.cache/

TAREA 6 — Crear carpeta storage con placeholder:
Creá la carpeta `video-factory/storage/` y dentro de ella un archivo vacío llamado 
`.gitkeep` (es un archivo vacío, solo necesita existir).

TAREA 7 — Verificación final:
Listá el contenido de video-factory/ y video-factory/docs/ para confirmar que todo 
está en su lugar. Mostrame el árbol de archivos resultante.

TAREA 8 — Reportar y dar instrucciones siguientes:
Cuando hayas terminado todo, decime:
1. Confirmación de que todo está listo
2. La ruta absoluta a la carpeta video-factory/
3. Recordame que el siguiente paso es abrir Claude Code en esa carpeta

NO HAGAS:
- No instales dependencias de Node (no ejecutes pnpm install todavía)
- No crees archivos package.json, tsconfig.json ni ningún otro archivo de código
- No escribas código TypeScript ni JavaScript
- No modifiques el contenido de los 3 archivos .md que vas a mover
- No abras Claude Code automáticamente

Empezá por la Tarea 1 y avanzá en orden. Si algo falla, paráte y reportame antes 
de continuar.
```

---

## ⚠️ ANTES DE PEGAR EL PROMPT

**Editá estas dos cosas dentro del prompt antes de pegarlo:**

1. **Ruta del proyecto** (línea que dice `[REEMPLAZAR CON LA RUTA...]`):
   - **macOS**: algo como `/Users/tu-usuario/Documents/proyectos/`
   - **Windows**: algo como `C:\Users\tu-usuario\Documents\proyectos\`

2. **Confirmar dónde tenés los 3 archivos descargados**:
   - Por defecto Cowork buscará en `~/Downloads/` o `Descargas/`
   - Si los pusiste en otro lado, agregá una línea al prompt:
     > "Los archivos descargados están en: [RUTA]"

---

## 🔍 QUÉ ESPERAR DE COWORK

Cowork te va a pedir **permiso para acceder a las carpetas** que va a tocar. Aceptá:

1. ✅ Permiso para leer la carpeta donde están los archivos descargados
2. ✅ Permiso para crear/escribir en la carpeta del proyecto

Vas a ver mensajes tipo:
- "Claude wants to read [carpeta]" → **Allow**
- "Claude wants to create folder [carpeta]" → **Allow**
- "Claude wants to run command: `node --version`" → **Allow**

---

## ✅ AL TERMINAR COWORK — Resultado esperado

Vas a tener una carpeta así:

```
video-factory/
├── .git/                              ← Inicializado por Cowork
├── .gitignore                          ← Creado por Cowork
├── DOCUMENTO_MAESTRO.md                ← Movido por Cowork
├── docs/
│   ├── analisis_videos_referencia.md   ← Movido por Cowork
│   └── analisis_videos_ugc.md          ← Movido por Cowork
└── storage/
    └── .gitkeep                        ← Creado por Cowork
```

Y Cowork debería decirte:
- ✅ Node, pnpm, Git versiones encontradas
- ✅ Carpeta creada en `[tu ruta]/video-factory/`
- ✅ Archivos movidos correctamente
- ✅ Git inicializado
- ✅ Estructura verificada

---

## 🚀 PASO 2 — Pasarle el trabajo a Claude Code

Una vez que Cowork termine y te confirme todo, abrí una terminal en la carpeta 
`video-factory/` y ejecutá:

```bash
cd /ruta/a/tu/video-factory
claude
```

Cuando Claude Code abra, pegá este prompt:

```
Hola Claude. Vas a construir el MVP de Video Factory HOY.

PASO 1 — LECTURA OBLIGATORIA:
Lee completo DOCUMENTO_MAESTRO.md en la raíz de este repo. Es la fuente de verdad 
sobre arquitectura, stack, APIs externas, schemas, presets, marcas, roadmap y reglas. 
NO empieces nada hasta haberlo leído entero.

También leé los archivos en docs/ para entender el contexto de qué tipo de videos 
vamos a generar.

PASO 2 — CONFIRMACIÓN:
Después de leer todo, hazme un resumen muy corto (máximo 6 bullets) de:
- Qué hace el proyecto
- Stack técnico decidido
- Cuáles son los 5 bloques del pipeline
- Cuál es la marca y preset inicial
- Tres reglas inviolables
- Qué hay en Bloque A del roadmap

PASO 3 — CONSTRUCCIÓN (después de mi OK):
Trabajamos el roadmap en orden: Bloque A → Bloque B → Bloque C.

REGLAS DE TRABAJO:
- IR RÁPIDO sin sacrificar arquitectura.
- Bloques A.1 a A.8 juntos, después pausá para mostrarme. 
- Bloques B uno por uno, mostrame al final de cada uno.
- Bloque C todo junto, mostrame el resultado final.
- Commits atómicos en español ("feat: setup monorepo turborepo").
- Si hay decisión que no está en el documento, PREGUNTÁ.
- No instales dependencias adicionales sin confirmarme.

OBJETIVO DE HOY:
Tener un MP4 generado end-to-end con:
- Marca: Vitaly (configurada en brands/vitaly.brand.json)
- Preset: educativo_pixar (configurado en presets/educativo_pixar.preset.json)
- Guión de prueba que yo te paso
- Output: MP4 1080×1920 con imagen Pixar + voz ElevenLabs + subs word-level

Empezá leyendo el documento. Cuando termines, dame el resumen y esperá mi OK 
para arrancar Bloque A.
```

---

## 🆘 SI ALGO FALLA EN COWORK

### Si dice "no encuentro los archivos":
- Verificá dónde descargaste DOCUMENTO_MAESTRO.md, analisis_videos_referencia.md y 
  analisis_videos_ugc.md
- Decile a Cowork: "Los archivos están en [ruta exacta]"

### Si dice "no tengo permiso para esa carpeta":
- En Cowork → Settings → Folder Access → Add Folder
- Agregá la carpeta donde quieras crear el proyecto

### Si dice "Node.js no está instalado":
- Pará a Cowork
- Andá a https://nodejs.org/ y descargá Node 20 LTS
- Una vez instalado, decile a Cowork: "Listo, Node ya está instalado, continuá"

### Si dice "pnpm no está instalado":
- Decile a Cowork: "Instalá pnpm con `npm install -g pnpm`"
- Esperá la confirmación

### Si dice "Git no está instalado":
- **macOS**: instalá Xcode Command Line Tools con `xcode-select --install`
- **Windows**: descargá desde https://git-scm.com/

---

## 💡 ¿Por qué dividir entre Cowork y Claude Code?

| Cowork hace | Claude Code hace |
|---|---|
| Crear carpetas | Escribir código TypeScript |
| Mover archivos | Configurar package.json |
| Verificar versiones de Node/pnpm | Instalar dependencias |
| Inicializar Git | Hacer commits del código |
| Crear .gitignore | Crear estructura del monorepo |
| Crear archivos vacíos placeholder | Implementar los bloques del pipeline |

**Cowork es bueno para tareas de oficina sobre archivos.**
**Claude Code es bueno para construir software.**

Si le pedís a Cowork que escriba código del proyecto, va a hacerlo peor que Claude Code. 
Si le pedís a Claude Code que mueva archivos manualmente, te va a costar más tiempo.

**Usá cada uno para lo que es bueno.**

---

*Instrucciones para preparación del proyecto Video Factory · Mayo 2026*
