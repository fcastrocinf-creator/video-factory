'use client';

import { useState, type FormEvent } from 'react';
import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';

type Status = 'idle' | 'sending' | 'success' | 'error';

const CATEGORIAS = [
  { value: 'improvement', label: 'Mejora' },
  { value: 'feature', label: 'Nueva feature' },
  { value: 'bug', label: 'Bug' },
  { value: 'question', label: 'Pregunta' },
  { value: 'other', label: 'Otra' },
] as const;

export default function SugerenciasPage() {
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
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Sugerencias de herramienta</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Dejá ideas de mejora, bugs, features que quieras agregar a Video Factory. Se guardan
        localmente en <code className="rounded bg-muted px-1 py-0.5 text-xs">storage/sugerencias/</code>{' '}
        y <strong>NO se aplican automáticamente</strong> — el owner las revisa cuando quiere.
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
            placeholder="Ej: Agregar shortcut Cmd+S al editor de composición"
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
            rows={8}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Detallá el qué, el por qué, y si tenés un ejemplo concreto mejor. Markdown OK."
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {description.length}/5000 caracteres
          </p>
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
              placeholder="Tu nombre o identificador"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="submit"
            disabled={status === 'sending'}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {status === 'sending' ? 'Guardando…' : 'Enviar sugerencia'}
          </button>

          <div className="text-sm">
            {status === 'success' && (
              <span className="text-green-600">
                ✓ Guardada {lastSavedId ? `(id: ${lastSavedId.slice(0, 8)})` : ''}
              </span>
            )}
            {status === 'error' && (
              <span className="text-red-600">Error: {errorMsg}</span>
            )}
          </div>
        </div>
      </form>

      {/* M8: chat IA con Claude para refinar la sugerencia antes de enviarla */}
      <div className="mt-6">
        <ClaudeChatPanel
          contextType="sugerencia"
          contextData={{
            currentTitle: title,
            currentDescription: description,
            currentCategory: category,
            sistemaConocido: {
              modos: ['Crear', 'Ripear', 'Aprender'],
              flujos: ['multi-provider image cascade', 'M2 Claude judge', 'M5 post-render', 'M6 editor IA loop'],
            },
          }}
          title="Discutí tu sugerencia con Claude antes de enviarla"
          placeholder="Ej: 'Estoy pensando en agregar X — ¿ya existe? ¿qué opinás?'"
        />
      </div>

      <div className="mt-6 rounded-md border border-input bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">¿Cómo se procesan estas sugerencias?</p>
        <p>
          Se guardan como archivos JSON en{' '}
          <code className="rounded bg-background px-1 py-0.5">storage/sugerencias/</code>{' '}
          (gitignored, local-only). El owner las revisa manualmente y decide cuáles implementar.{' '}
          <strong>No se aplican automáticamente al código del proyecto.</strong>
        </p>
      </div>
    </div>
  );
}
