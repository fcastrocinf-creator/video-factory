'use client';

// Copilot flotante — guía de cara al usuario. Burbuja abajo a la derecha en
// toda la app. Sabe en qué página estás (sugerencias contextuales) y conversa
// con el motor de chat IA (contextType 'copilot', que NO recibe datos internos).

import { useState, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';

type Msg = { role: 'user' | 'assistant'; content: string };

// El Copilot puede emitir una sugerencia para administradores como un bloque
// oculto [[SUGERENCIA]]{...}[[/SUGERENCIA]]. Lo extraemos para (a) no mostrarlo
// como texto crudo y (b) ofrecer un botón "Enviar a administradores".
type ParsedSuggestion = { titulo: string; descripcion: string; categoria: string };
const SUGG_RE = /\[\[SUGERENCIA\]\]([\s\S]*?)\[\[\/SUGERENCIA\]\]/;
function parseSuggestion(content: string): { clean: string; suggestion: ParsedSuggestion | null } {
  const m = content.match(SUGG_RE);
  if (!m || !m[1]) return { clean: content, suggestion: null };
  let suggestion: ParsedSuggestion | null = null;
  try {
    const obj = JSON.parse(m[1].trim()) as Partial<ParsedSuggestion>;
    if (obj && typeof obj.titulo === 'string' && typeof obj.descripcion === 'string') {
      suggestion = {
        titulo: obj.titulo,
        descripcion: obj.descripcion,
        categoria: typeof obj.categoria === 'string' ? obj.categoria : 'improvement',
      };
    }
  } catch {
    // bloque malformado: lo ignoramos y mostramos el texto sin él.
  }
  // Limpiamos TODOS los bloques (flag g), no solo el primero.
  return {
    clean: content.replace(/\[\[SUGERENCIA\]\][\s\S]*?\[\[\/SUGERENCIA\]\]/g, '').trim(),
    suggestion,
  };
}

// El Copilot puede emitir un "brief" listo para crear como bloque oculto
// [[BRIEF]]{...}[[/BRIEF]]. Lo extraemos para ofrecer el botón "Crear este video"
// que prellena la pantalla de Crear.
type BriefData = {
  script: string;
  brandId?: string;
  presetId?: string;
  voice?: boolean;
  subtitles?: boolean;
  animation?: boolean;
  kenBurns?: boolean;
};
const BRIEF_RE = /\[\[BRIEF\]\]([\s\S]*?)\[\[\/BRIEF\]\]/;
function parseBrief(content: string): { clean: string; brief: BriefData | null } {
  const m = content.match(BRIEF_RE);
  if (!m || !m[1]) return { clean: content, brief: null };
  let brief: BriefData | null = null;
  try {
    const obj = JSON.parse(m[1].trim()) as Partial<BriefData>;
    if (obj && typeof obj.script === 'string' && obj.script.trim().length > 0) {
      brief = {
        script: obj.script,
        brandId: typeof obj.brandId === 'string' && obj.brandId ? obj.brandId : undefined,
        presetId: typeof obj.presetId === 'string' && obj.presetId ? obj.presetId : undefined,
        voice: obj.voice !== false,
        subtitles: obj.subtitles === true,
        animation: obj.animation !== false,
        kenBurns: obj.kenBurns === true,
      };
    }
  } catch {
    // bloque malformado: lo ignoramos.
  }
  return {
    clean: content.replace(/\[\[BRIEF\]\][\s\S]*?\[\[\/BRIEF\]\]/g, '').trim(),
    brief,
  };
}

// Render simple de texto enriquecido: **negrita** → <strong>, respeta saltos de
// línea. Evita que el usuario vea los asteriscos crudos del markdown.
function renderRich(text: string) {
  return text.split('\n').map((line, li) => (
    <span key={li} className="block">
      {line.split(/(\*\*[^*]+\*\*)/g).map((part, pi) =>
        /^\*\*[^*]+\*\*$/.test(part) ? (
          <strong key={pi} className="font-semibold text-white">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </span>
  ));
}

// Sugerencias contextuales según la sección donde está el usuario.
// "Quiero hacer un video" va SIEMPRE primero — arranca el Brief guiado.
const MAKE_VIDEO = '🎬 Quiero hacer un video';
function suggestionsFor(path: string): string[] {
  if (path.startsWith('/create')) return [MAKE_VIDEO, '¿Qué estilo elijo?', '¿Puedo quitar los subtítulos?'];
  if (path.startsWith('/rip')) return [MAKE_VIDEO, '¿Qué es ripear?', '¿Qué video debo subir?'];
  if (path.startsWith('/runs')) return [MAKE_VIDEO, '¿Cómo edito un video?', '¿Dónde veo el costo?'];
  if (path.startsWith('/brands')) return [MAKE_VIDEO, '¿Para qué sirven las marcas?'];
  if (path.startsWith('/sugerencias')) return [MAKE_VIDEO, '¿Qué es el Asistente IA?'];
  if (path.startsWith('/aprendizaje')) return [MAKE_VIDEO, '¿Cómo enseño un estilo nuevo?'];
  if (path.startsWith('/admin')) return [MAKE_VIDEO, '¿Qué apruebo aquí?'];
  return [MAKE_VIDEO, '¿Qué puedo hacer aquí?'];
}

export function CopilotWidget() {
  const path = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showNudge, setShowNudge] = useState(false);
  const [nudged, setNudged] = useState(false);
  const [sentSugg, setSentSugg] = useState<Record<number, 'sending' | 'sent' | 'error'>>({});
  const [userId, setUserId] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const convIdRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  // Identidad del usuario (hoy: estable por navegador; base para multi-usuario real).
  useEffect(() => {
    try {
      let id = localStorage.getItem('vf-user-id');
      if (!id) {
        id =
          'u-' +
          (typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        localStorage.setItem('vf-user-id', id);
      }
      setUserId(id);
    } catch {
      setUserId('u-anon');
    }
  }, []);

  // "¿Te quedaste atascado?" — si tras un rato no abriste el Copilot, lo ofrecemos
  // UNA vez (no molesto: una sola vez por sesión y descartable).
  useEffect(() => {
    if (open || nudged) return;
    const t = setTimeout(() => {
      setShowNudge(true);
      setNudged(true);
    }, 30000);
    return () => clearTimeout(t);
  }, [open, nudged]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || loading) return;
    const next: Msg[] = [...messages, { role: 'user', content: t }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const resp = await fetch('/api/chat/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextType: 'copilot',
          contextData: { currentPage: path },
          conversation: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as { reply?: string; error?: string };
      const reply = resp.ok
        ? data.reply ?? 'No pude responder ahora mismo.'
        : data.error ?? `Algo falló (${resp.status}).`;
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
      // Si el Copilot formuló una sugerencia (el usuario ya confirmó en el chat),
      // la guardamos sola. El índice del mensaje del asistente es next.length.
      if (resp.ok) {
        const parsedReply = parseSuggestion(reply);
        if (parsedReply.suggestion) void sendSuggestion(next.length, parsedReply.suggestion);
        void saveConversation([...next, { role: 'assistant', content: reply }]);
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Tuve un problema de conexión. Intenta de nuevo.' }]);
    } finally {
      setLoading(false);
    }
  }

  async function sendSuggestion(msgIndex: number, s: ParsedSuggestion) {
    setSentSugg((p) => ({ ...p, [msgIndex]: 'sending' }));
    try {
      const resp = await fetch('/api/sugerencias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: s.titulo,
          description: s.descripcion,
          category: s.categoria,
          author: 'Copilot (chat)',
        }),
      });
      setSentSugg((p) => ({ ...p, [msgIndex]: resp.ok ? 'sent' : 'error' }));
    } catch {
      setSentSugg((p) => ({ ...p, [msgIndex]: 'error' }));
    }
  }

  // "Crear este video": prellena la pantalla de Crear con el brief y navega allí.
  function createFromBrief(brief: BriefData) {
    try {
      sessionStorage.setItem(
        'prefill-script',
        JSON.stringify({
          script: brief.script,
          brandId: brief.brandId,
          presetId: brief.presetId,
          productId: null,
        }),
      );
      sessionStorage.setItem(
        'prefill-options',
        JSON.stringify({
          voice: brief.voice,
          subtitles: brief.subtitles,
          animation: brief.animation,
          kenBurns: brief.kenBurns,
        }),
      );
    } catch {
      // sessionStorage puede no estar disponible; igual navegamos.
    }
    setOpen(false);
    // Navegación completa: garantiza que /create se monte de nuevo y lea el
    // prellenado, incluso si el usuario ya estaba en esa pantalla.
    window.location.assign('/create');
  }

  // Guarda/actualiza la conversación del usuario (historial propio + base multi-usuario).
  async function saveConversation(msgs: Msg[]) {
    if (!userId || msgs.length === 0) return;
    // Asignamos el id en el CLIENTE (síncrono, vía ref) para que guardados
    // concurrentes no creen conversaciones duplicadas.
    if (!convIdRef.current) {
      convIdRef.current =
        'c-' +
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      setConversationId(convIdRef.current);
    }
    try {
      await fetch('/api/copilot/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, conversationId: convIdRef.current, messages: msgs }),
      });
    } catch {
      // best-effort: no romper el chat si falla el guardado.
    }
  }

  async function loadHistory() {
    if (!userId) return;
    setHistoryLoading(true);
    try {
      const resp = await fetch(`/api/copilot/conversations?userId=${encodeURIComponent(userId)}`);
      const data = (await resp.json().catch(() => ({}))) as {
        conversations?: Array<{ id: string; title: string; updatedAt: string }>;
      };
      setHistory(data.conversations ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) void loadHistory();
  }

  async function loadConversation(id: string) {
    if (!userId) return;
    try {
      const resp = await fetch(
        `/api/copilot/conversations?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(id)}`,
      );
      const data = (await resp.json().catch(() => ({}))) as { id?: string; messages?: Msg[] };
      if (data.messages) {
        setMessages(data.messages);
        setConversationId(data.id ?? id);
        convIdRef.current = data.id ?? id;
        setSentSugg({});
        setShowHistory(false);
      }
    } catch {
      // si falla, dejamos la conversación actual.
    }
  }

  function newConversation() {
    setMessages([]);
    setConversationId(null);
    convIdRef.current = null;
    setSentSugg({});
    setInput('');
    setShowHistory(false);
  }

  const chips = suggestionsFor(path);

  return (
    <>
      {/* Nudge "¿te ayudo?" — aparece una vez si no abriste el Copilot */}
      {!open && showNudge && (
        <div className="fixed bottom-20 right-5 z-50 flex max-w-[240px] items-center gap-2 rounded-xl border border-[#2a2f3c] bg-[#15171e] px-3 py-2 text-sm text-[#c7cdda] shadow-xl">
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setShowNudge(false);
            }}
            className="text-left hover:text-white"
          >
            💬 ¿Te ayudo con algo de esta sección?
          </button>
          <button
            type="button"
            onClick={() => setShowNudge(false)}
            className="shrink-0 text-[#6b7385] hover:text-white"
            aria-label="Descartar"
          >
            ×
          </button>
        </div>
      )}

      {/* Burbuja flotante */}
      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setShowNudge(false);
          }}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-white"
          style={{ background: 'linear-gradient(135deg,#7c6cff,#9d8bff)', boxShadow: '0 8px 24px -6px #7c6cff' }}
        >
          <span className="text-base">💬</span> Copilot
        </button>
      )}

      {/* Panel de chat */}
      {open && (
        <div
          className="fixed bottom-5 right-5 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col rounded-2xl border border-[#2a2f3c] bg-[#15171e] shadow-2xl"
          style={{ height: 'min(560px, calc(100vh - 2.5rem))' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#2a2f3c] px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className="grid h-7 w-7 place-items-center rounded-lg text-sm"
                style={{ background: 'linear-gradient(135deg,#7c6cff,#ffcf4a)' }}
              >
                🤖
              </span>
              <div>
                <div className="text-sm font-bold leading-none text-white">Copilot</div>
                <div className="text-xs text-[#6b7385]">tu guía paso a paso</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xl leading-none text-[#6b7385] hover:text-white"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>

          {/* Barra de conversaciones (historial por usuario) */}
          <div className="flex items-center justify-between border-b border-[#2a2f3c] px-3 py-1.5 text-xs">
            <button
              type="button"
              onClick={toggleHistory}
              className="flex items-center gap-1 text-[#9aa3b2] hover:text-white"
            >
              🗂 Ver conversaciones pasadas <span className="text-xs">{showHistory ? '▲' : '▼'}</span>
            </button>
            <button type="button" onClick={newConversation} className="text-[#9aa3b2] hover:text-white">
              ＋ Nueva
            </button>
          </div>
          {showHistory && (
            <div className="max-h-40 overflow-y-auto border-b border-[#2a2f3c] bg-[#13151b] px-2 py-1.5">
              {historyLoading ? (
                <div className="px-2 py-1 text-xs text-[#6b7385]">Cargando…</div>
              ) : history.length === 0 ? (
                <div className="px-2 py-1 text-xs text-[#6b7385]">
                  Aún no tienes conversaciones guardadas.
                </div>
              ) : (
                history.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => void loadConversation(h.id)}
                    title={h.title}
                    className={
                      'block w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[#222633] ' +
                      (h.id === conversationId ? 'text-white' : 'text-[#c7cdda]')
                    }
                  >
                    💬 {h.title}
                  </button>
                ))
              )}
            </div>
          )}

          {/* Mensajes */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {/* Comentario explicativo de qué es el Copilot (siempre visible) */}
            <div className="rounded-xl border border-[#2a2f3c] bg-[#1b1e27] p-3 text-sm leading-relaxed text-[#c7cdda]">
              ¡Hola! 👋 Soy tu <b className="text-white">Copilot</b>. Te guío para usar la herramienta sin
              enredos. Pregúntame lo que quieras — por ejemplo, cómo crear un video.
            </div>

            {messages.map((m, i) => {
              const sugg =
                m.role === 'assistant'
                  ? parseSuggestion(m.content)
                  : { clean: m.content, suggestion: null as ParsedSuggestion | null };
              const br =
                m.role === 'assistant'
                  ? parseBrief(sugg.clean)
                  : { clean: sugg.clean, brief: null as BriefData | null };
              return (
                <div
                  key={i}
                  className={'flex flex-col ' + (m.role === 'user' ? 'items-end' : 'items-start')}
                >
                  <div
                    className={
                      'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ' +
                      (m.role === 'user' ? 'bg-[#7c6cff] text-white' : 'bg-[#222633] text-[#e6e9f0]')
                    }
                  >
                    {m.role === 'assistant' ? renderRich(br.clean) : m.content}
                  </div>

                  {sugg.suggestion && (
                    <div className="mt-1.5 max-w-[85%] rounded-xl border border-[#7c6cff]/40 bg-[#7c6cff]/10 p-2.5 text-xs">
                      <div className="font-semibold text-white">💡 {sugg.suggestion.titulo}</div>
                      <div className="mt-0.5 text-[#c7cdda]">{sugg.suggestion.descripcion}</div>
                      <div className="mt-1.5 text-xs font-medium">
                        {sentSugg[i] === 'sent' && (
                          <span className="text-emerald-400">✓ Guardada para los administradores</span>
                        )}
                        {sentSugg[i] === 'sending' && <span className="text-[#9aa3b2]">Guardando…</span>}
                        {(sentSugg[i] === undefined || sentSugg[i] === 'error') && (
                          <button
                            type="button"
                            onClick={() => void sendSuggestion(i, sugg.suggestion!)}
                            className="rounded-lg bg-[#7c6cff] px-3 py-1.5 font-semibold text-white"
                          >
                            {sentSugg[i] === 'error' ? 'Reintentar' : '✅ Guardar para administradores'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {br.brief && (
                    <button
                      type="button"
                      onClick={() => createFromBrief(br.brief!)}
                      className="mt-1.5 flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold text-white"
                      style={{ background: 'linear-gradient(135deg,#7c6cff,#9d8bff)' }}
                    >
                      ✅ Crear este video
                    </button>
                  )}
                </div>
              );
            })}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-[#222633] px-3 py-2 text-sm text-[#9aa3b2]">Escribiendo…</div>
              </div>
            )}

            {/* Sugerencias (solo al inicio de la conversación) */}
            {messages.length === 0 && !loading && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {chips.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => send(c)}
                    className="rounded-full border border-[#2a2f3c] bg-[#1b1e27] px-3 py-1.5 text-xs text-[#c7cdda] transition-colors hover:border-[#7c6cff] hover:text-white"
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-[#2a2f3c] p-2.5">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                placeholder="Escribe tu pregunta…"
                className="max-h-24 flex-1 resize-none rounded-xl border border-[#2a2f3c] bg-[#0f1116] px-3 py-2 text-sm text-white placeholder:text-[#6b7385] focus:border-[#7c6cff] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void send(input)}
                disabled={loading || !input.trim()}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg,#7c6cff,#9d8bff)' }}
                aria-label="Enviar"
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
