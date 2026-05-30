// ClaudeChatPanel.tsx — M8 UI: panel de chat reusable con Claude.
//
// Componente reusable que se puede plugear en cualquier página donde el usuario
// tenga inputs/sugerencias y quiera discutirlos con Claude antes de confirmar.
//
// Uso:
//   <ClaudeChatPanel contextType="sugerencia" contextData={{ ... }} />
//
// Llama a POST /api/chat/discuss internamente. Estado local del componente
// (sin Redux/Zustand) — para chats simples conversacionales.

'use client';

import { useState, useRef, type FormEvent } from 'react';

type ContextType =
  | 'sugerencia'
  | 'scene-edit'
  | 'script-refine'
  | 'rip-analysis'
  | 'preset-tuning'
  | 'general';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ClaudeChatPanelProps {
  contextType: ContextType;
  /** Data estructurada que el chat IA debe conocer del contexto */
  contextData?: Record<string, unknown>;
  /** Label visible. Default: "Discutí con Claude" */
  title?: string;
  /** Placeholder del input. Default por contextType */
  placeholder?: string;
  /** Si true, el chat arranca expandido. Default false (collapsable) */
  defaultOpen?: boolean;
  /** Callback cuando se completa una respuesta (útil para tracking) */
  onReply?: (reply: string) => void;
}

const DEFAULT_PLACEHOLDERS: Record<ContextType, string> = {
  sugerencia: 'Ej: "Tengo idea de agregar X — ¿ya existe? ¿qué opinás?"',
  'scene-edit': 'Ej: "Cómo cambio el prompt de esta escena para que el producto se vea mejor?"',
  'script-refine': 'Ej: "Revisame este hook — ¿es fuerte para los primeros 3s?"',
  'rip-analysis': 'Ej: "Qué preset me recomendás para adaptar este ad?"',
  'preset-tuning': 'Ej: "El preset X genera escenas muy comprimidas, qué ajusto?"',
  general: 'Pregúntame lo que quieras sobre Video Factory.',
};

export function ClaudeChatPanel({
  contextType,
  contextData,
  title = 'Discutí con Claude',
  placeholder,
  defaultOpen = false,
  onReply,
}: ClaudeChatPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setError('');

    const newUserMsg: Message = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    const newMessages = [...messages, newUserMsg];
    setMessages(newMessages);
    setInput('');
    setSending(true);

    try {
      const resp = await fetch('/api/chat/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextType,
          contextData,
          conversation: newMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { reply: string };
      const replyMsg: Message = {
        role: 'assistant',
        content: data.reply,
        timestamp: Date.now(),
      };
      setMessages([...newMessages, replyMsg]);
      onReply?.(data.reply);
      // Scroll al final
      setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function clear() {
    setMessages([]);
    setError('');
  }

  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-500/5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium hover:bg-blue-500/10"
      >
        <span>
          🤖 {title}
          {messages.length > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              ({messages.length} mensaje{messages.length !== 1 ? 's' : ''})
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{open ? '▼' : '▶'}</span>
      </button>

      {open && (
        <div className="border-t border-blue-500/20 p-4">
          {messages.length === 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              Escribí abajo. Claude conoce el contexto del sistema y te puede ayudar a refinar
              tu idea, identificar problemas, o estimar esfuerzo.
            </p>
          )}

          {messages.length > 0 && (
            <div
              ref={scrollRef}
              className="mb-3 max-h-96 overflow-y-auto rounded-md bg-background p-3"
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`mb-3 last:mb-0 ${m.role === 'user' ? 'text-right' : 'text-left'}`}
                >
                  <div
                    className={`inline-block max-w-[90%] rounded-md px-3 py-2 text-sm ${
                      m.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              ))}
              {sending && (
                <div className="text-left">
                  <div className="inline-block rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    Claude está pensando…
                  </div>
                </div>
              )}
            </div>
          )}

          <form onSubmit={send} className="space-y-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder ?? DEFAULT_PLACEHOLDERS[contextType]}
              rows={3}
              disabled={sending}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  void send(e as unknown as FormEvent);
                }
              }}
            />
            <div className="flex items-center justify-between">
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? 'Enviando…' : 'Enviar (Ctrl+Enter)'}
              </button>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Limpiar conversación
                </button>
              )}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </form>
        </div>
      )}
    </div>
  );
}
