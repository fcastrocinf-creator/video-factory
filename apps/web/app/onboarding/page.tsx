'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// Shape del JSON que retorna /api/onboarding/status
interface StatusResponse {
  prereqs: {
    node: boolean;
    pnpm: boolean;
    ffmpeg: boolean;
    db: boolean;
  };
  keys: {
    APP_PASSWORD: boolean;
    OPENAI_API_KEY: boolean;
    ELEVENLABS_API_KEY: boolean;
    GOOGLE_AI_API_KEY: boolean;
    ANTHROPIC_API_KEY: boolean;
    GOOGLE_SPEECH_API_KEY: boolean;
    GCP_PROJECT_ID: boolean;
    GOOGLE_APPLICATION_CREDENTIALS: boolean;
    GCP_LOCATION: boolean;
    HIGGSFIELD: boolean;
    KLING: boolean;
    FAL_API_KEY: boolean;
    ZAPCAP_API_KEY: boolean;
    LOG_LEVEL: boolean;
  };
  sync: { configured: boolean };
  ok: boolean;
}

// Icono de check verde
function CheckIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-500/20 text-green-400 text-xs font-bold flex-shrink-0">
      ✓
    </span>
  );
}

// Icono de error rojo
function ErrorIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/20 text-red-400 text-xs font-bold flex-shrink-0">
      ✗
    </span>
  );
}

// Icono de advertencia (para opcionales faltantes)
function WarnIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold flex-shrink-0">
      !
    </span>
  );
}

interface CheckItemProps {
  label: string;
  present: boolean;
  required?: boolean;
  hint?: string;
}

function CheckItem({ label, present, required = false, hint }: CheckItemProps) {
  const icon = present ? (
    <CheckIcon />
  ) : required ? (
    <ErrorIcon />
  ) : (
    <WarnIcon />
  );

  return (
    <div className="flex items-start gap-3 py-2">
      {icon}
      <div className="flex-1 min-w-0">
        <span
          className={`text-sm font-mono ${
            present
              ? 'text-foreground'
              : required
                ? 'text-red-400 font-semibold'
                : 'text-yellow-400'
          }`}
        >
          {label}
        </span>
        {!present && hint && (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        )}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

export default function OnboardingPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/status');
      if (!res.ok) {
        throw new Error(`Error ${res.status} al consultar el estado`);
      }
      const data = (await res.json()) as StatusResponse;
      setStatus(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo conectar con el servidor. Verifica que pnpm dev esté corriendo.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      {/* Cabecera */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">
          Configuración inicial — Video Factory
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Esta página verifica que tu instalación esté lista para usar. No
          muestra valores de keys, solo indica si están configuradas.
        </p>
      </div>

      {/* Estado de carga */}
      {loading && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          Verificando configuración...
        </div>
      )}

      {/* Error de conexión */}
      {!loading && error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          <p className="font-semibold">No se pudo verificar el estado</p>
          <p className="mt-1">{error}</p>
          <button
            onClick={() => void fetchStatus()}
            className="mt-3 rounded-md bg-red-500/20 px-3 py-1 text-xs hover:bg-red-500/30 transition-colors"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Checklist */}
      {!loading && status && (
        <div className="space-y-4">
          {/* Banner de estado general */}
          {status.ok ? (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
              <p className="text-green-400 font-semibold text-sm">
                Todo listo — puedes empezar a usar Video Factory
              </p>
              <Link
                href="/"
                className="mt-2 inline-block rounded-md bg-green-500/20 px-4 py-1.5 text-xs text-green-400 hover:bg-green-500/30 transition-colors"
              >
                Ir al inicio
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <p className="text-red-400 font-semibold text-sm">
                Completa los pasos marcados en rojo y reinicia el servidor con{' '}
                <code className="font-mono">pnpm dev</code>
              </p>
            </div>
          )}

          {/* Software del sistema */}
          <Section title="Software del sistema">
            <CheckItem
              label="Node.js (>= 20)"
              present={status.prereqs.node}
              required
              hint="Instalar desde https://nodejs.org (versión 20 LTS o superior)"
            />
            <CheckItem
              label="pnpm (>= 9)"
              present={status.prereqs.pnpm}
              required
              hint="Instalar con: npm install -g pnpm@9.15.0"
            />
            <CheckItem
              label="ffmpeg (bundled con Remotion)"
              present={status.prereqs.ffmpeg}
              required
              hint="Correr 'pnpm install' para descargar el binario bundled de Remotion"
            />
          </Section>

          {/* Base de datos */}
          <Section title="Base de datos">
            <CheckItem
              label="Base de datos local (db/local.db)"
              present={status.prereqs.db}
              required
              hint="Correr 'pnpm db:migrate' para crear e inicializar la base de datos"
            />
          </Section>

          {/* Keys requeridas */}
          <Section title="Keys requeridas">
            <CheckItem
              label="APP_PASSWORD"
              present={status.keys.APP_PASSWORD}
              required
              hint="Definir en .env: APP_PASSWORD=tu-password-aqui"
            />
            <CheckItem
              label="OPENAI_API_KEY"
              present={status.keys.OPENAI_API_KEY}
              required
              hint="Obtener en https://platform.openai.com/api-keys — pipeline de imágenes y TTS de respaldo"
            />
            <CheckItem
              label="ELEVENLABS_API_KEY"
              present={status.keys.ELEVENLABS_API_KEY}
              required
              hint="Obtener en https://elevenlabs.io/app/settings/api-keys — narración de voz"
            />
            <CheckItem
              label="GOOGLE_AI_API_KEY"
              present={status.keys.GOOGLE_AI_API_KEY}
              required
              hint="Obtener en https://aistudio.google.com/app/apikey — Gemini Vision e Imagen"
            />
          </Section>

          {/* Keys recomendadas */}
          <Section title="Keys recomendadas">
            <CheckItem
              label="ANTHROPIC_API_KEY"
              present={status.keys.ANTHROPIC_API_KEY}
              hint="Obtener en https://console.anthropic.com/settings/keys — Copilot, editor IA y jueces Claude"
            />
            <CheckItem
              label="GCP_PROJECT_ID"
              present={status.keys.GCP_PROJECT_ID}
              hint="ID de tu proyecto Google Cloud — activa Vertex AI sin límites diarios"
            />
            <CheckItem
              label="GOOGLE_APPLICATION_CREDENTIALS"
              present={status.keys.GOOGLE_APPLICATION_CREDENTIALS}
              hint="Ruta al JSON del service account GCP con rol 'Vertex AI User'"
            />
          </Section>

          {/* Keys opcionales */}
          <Section title="Keys opcionales">
            <CheckItem
              label="GOOGLE_SPEECH_API_KEY"
              present={status.keys.GOOGLE_SPEECH_API_KEY}
              hint="Cloud Speech-to-Text dedicada para subtítulos — fallback a GOOGLE_AI_API_KEY si no está"
            />
            <CheckItem
              label="GCP_LOCATION"
              present={status.keys.GCP_LOCATION}
              hint="Región de Vertex AI (por defecto: us-central1)"
            />
            <CheckItem
              label="HIGGSFIELD (KEY_ID + KEY_SECRET)"
              present={status.keys.HIGGSFIELD}
              hint="Obtener en https://higgsfield.ai — requiere HIGGSFIELD_KEY_ID y HIGGSFIELD_KEY_SECRET"
            />
            <CheckItem
              label="KLING (ACCESS_KEY + SECRET_KEY)"
              present={status.keys.KLING}
              hint="Obtener en https://klingai.com — requiere KLING_ACCESS_KEY y KLING_SECRET_KEY"
            />
            <CheckItem
              label="FAL_API_KEY"
              present={status.keys.FAL_API_KEY}
              hint="Obtener en https://fal.ai — proveedor adicional de generación de imágenes (flux-pro)"
            />
            <CheckItem
              label="ZAPCAP_API_KEY"
              present={status.keys.ZAPCAP_API_KEY}
              hint="Obtener en https://zapcap.ai — subtítulos animados estilo CapCut"
            />
          </Section>

          {/* Buzón de sync */}
          <Section title="Buzón de sincronización (Cerebro)">
            <CheckItem
              label={
                status.sync.configured
                  ? 'Sincronización activada'
                  : 'Sincronización desactivada (comportamiento normal)'
              }
              present={status.sync.configured}
            />
            {!status.sync.configured && (
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                La sincronización del Cerebro está desactivada. Para activarla,
                pide al responsable técnico las variables{' '}
                <code className="font-mono">VF_LEARNING_SYNC_URL</code> y{' '}
                <code className="font-mono">VF_LEARNING_SYNC_KEY</code> y
                agrégalas a tu <code className="font-mono">.env</code>.
              </p>
            )}
          </Section>

          {/* Acciones */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => void fetchStatus()}
              className="rounded-md bg-muted px-4 py-2 text-sm text-foreground hover:bg-muted/80 transition-colors"
            >
              Verificar de nuevo
            </button>
            <Link
              href="/"
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              Ir al inicio
            </Link>
          </div>

          {/* Nota al pie */}
          <p className="text-xs text-muted-foreground pt-2 leading-relaxed">
            Esta página no muestra los valores de tus keys, solo indica si están
            configuradas. Después de editar tu{' '}
            <code className="font-mono">.env</code>, reinicia el servidor con{' '}
            <code className="font-mono">pnpm dev</code> y vuelve a verificar.
          </p>
        </div>
      )}
    </main>
  );
}
