'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';
import { PageHeader, PageHint } from '@/components/PageHint';

type Mode = 'ideas' | 'estilo' | 'tecnico';
type Status = 'idle' | 'sending' | 'success' | 'error';

const CATEGORIAS = [
  { value: 'improvement', label: 'Mejora' },
  { value: 'feature', label: 'Nueva feature' },
  { value: 'bug', label: 'Bug' },
  { value: 'question', label: 'Pregunta' },
  { value: 'other', label: 'Otra' },
] as const;

const MODES: Array<{ id: Mode; emoji: string; name: string; sub: string }> = [
  { id: 'ideas', emoji: '💡', name: 'Ideas', sub: 'hooks, ángulos, mejoras' },
  { id: 'estilo', emoji: '🎨', name: 'Aprender estilo', sub: 'analizar un video' },
  { id: 'tecnico', emoji: '🛠️', name: 'Técnico', sub: 'cómo funciona el tool' },
];

export default function AsistentePage() {
  const [mode, setMode] = useState<Mode>('ideas');

  // ----- Estado del formulario de ideas/sugerencias -----
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('improvement');
  const [author, setAuthor] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setErrorMsg('');
    setLastSavedId(null);

    try {
      const resp = await fetch('/api/sugerencias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          category,
          author: author.trim() || undefined,
        }),
      });

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(data.error ?? `Error ${resp.status}`);
        setStatus('error');
        return;
      }

      const data = (await resp.json()) as { id: string };
      setLastSavedId(data.id);
      setStatus('success');
      setTitle('');
      setDescription('');
      setAuthor('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Asistente IA" subtitle="Ideas, estilo y técnico en un solo lugar" />
      <PageHint emoji="🧠">
        <b className="text-foreground">Un solo asistente, tres usos.</b> Antes eran tres secciones sueltas
        (Sugerencias, Arquitecto, Aprendizaje). Ahora eliges el modo según lo que necesites: pedir{' '}
        <b className="text-foreground">ideas</b>, <b className="text-foreground">enseñar un estilo</b> nuevo
        o entender lo <b className="text-foreground">técnico</b>.
      </PageHint>

      {/* Selector de modo */}
      <div className="mb-6 grid grid-cols-3 gap-2">
        {MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={
                'rounded-xl border px-3 py-2.5 text-left transition-colors ' +
                (on
                  ? 'border-[#7c6cff] bg-[#7c6cff]/10'
                  : 'border-[#2a2f3c] hover:bg-[#222633]')
              }
            >
              <div className="text-lg leading-none">{m.emoji}</div>
              <div className="mt-1 text-sm font-semibold text-foreground">{m.name}</div>
              <div className="text-xs text-muted-foreground">{m.sub}</div>
            </button>
          );
        })}
      </div>

      {/* ---------- MODO: IDEAS ---------- */}
      {mode === 'ideas' && (
        <div className="space-y-6">
          <ClaudeChatPanel
            contextType="sugerencia"
            contextData={{
              currentTitle: title,
              currentDescription: description,
              currentCategory: category,
              sistemaConocido: {
                modos: ['Crear', 'Ripear', 'Aprender'],
                flujos: [
                  'multi-provider image cascade',
                  'M2 Claude judge',
                  'M5 post-render',
                  'M6 editor IA loop',
                ],
              },
            }}
            title="Pídele ideas a Claude (hooks, ángulos, guiones, mejoras)"
            placeholder="Ej: 'Dame 3 ángulos para un anuncio del producto X' o 'Se me ocurre agregar Y al editor, ¿qué opinas?'"
            defaultOpen
          />

          <div className="rounded-xl border border-[#2a2f3c] bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Guardar una idea o bug</h2>
            <p className="mt-1 mb-4 text-xs text-muted-foreground">
              Deja por escrito una mejora, feature o bug. Se guarda local y{' '}
              <strong>no se aplica solo</strong> — lo revisas cuando quieras.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="title" className="mb-1 block text-sm font-medium">
                  Título <span className="text-red-500">*</span>
                </label>
                <input
                  id="title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  minLength={3}
                  maxLength={200}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Ej: Agregar atajo para duplicar una escena en el editor"
                />
              </div>

              <div>
                <label htmlFor="description" className="mb-1 block text-sm font-medium">
                  Descripción <span className="text-red-500">*</span>
                </label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Cuenta el qué, el por qué, y si tienes un ejemplo concreto mejor."
                />
                <p className="mt-1 text-xs text-muted-foreground">{description.length}/5000 caracteres</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="category" className="mb-1 block text-sm font-medium">
                    Categoría
                  </label>
                  <select
                    id="category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {CATEGORIAS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="author" className="mb-1 block text-sm font-medium">
                    Autor (opcional)
                  </label>
                  <input
                    id="author"
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    maxLength={100}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Tu nombre"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="submit"
                  disabled={status === 'sending'}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {status === 'sending' ? 'Guardando…' : 'Guardar idea'}
                </button>

                <div className="text-sm">
                  {status === 'success' && (
                    <span className="text-emerald-500">
                      ✓ Guardada {lastSavedId ? `(id: ${lastSavedId.slice(0, 8)})` : ''}
                    </span>
                  )}
                  {status === 'error' && <span className="text-red-500">Error: {errorMsg}</span>}
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------- MODO: APRENDER ESTILO ---------- */}
      {mode === 'estilo' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-[#2a2f3c] bg-card p-6 text-center">
            <div className="text-3xl">🎨</div>
            <h2 className="mt-2 text-lg font-semibold text-foreground">Enséñale un estilo nuevo</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Subes un video de referencia y la herramienta aprende su look (Pixar, UGC realista, comic…)
              para repetirlo en tus próximos videos.
            </p>
            <Link
              href="/aprendizaje"
              className="mt-4 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(135deg,#7c6cff,#9d8bff)' }}
            >
              Ir a Aprendizaje →
            </Link>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            ¿Ya aprendiste un estilo? Apruébalo en{' '}
            <Link href="/admin" className="underline">
              Admin
            </Link>{' '}
            y aparecerá al{' '}
            <Link href="/create" className="underline">
              crear videos
            </Link>
            .
          </p>
        </div>
      )}

      {/* ---------- MODO: TÉCNICO ---------- */}
      {mode === 'tecnico' && (
        <div className="space-y-4">
          <ClaudeChatPanel
            contextType="architect"
            title="Habla con el Arquitecto IA (cómo funciona el tool)"
            defaultOpen
            placeholder="Ej: 'El estilo acuarela me sale plano, ¿qué ruta necesita?' o 'Quiero una ruta nueva para videos tipo claymation'"
          />
          <div className="rounded-md border border-[#2a2f3c] bg-muted/20 p-4 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Qué puede hacer este modo</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>Explicarte cómo trata la herramienta cada tipo de video.</li>
              <li>Diagnosticar por qué un tipo no sale bien (provider, animación, prompt).</li>
              <li>
                Proponer cambios concretos de ruta que <strong>tú apruebas</strong> antes de aplicar — nunca
                toca el código solo.
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
