'use client';

// Panel flotante (bottom-right) que captura TODOS los errores JS del browser
// y los expone con botones "Descargar TXT" + "Copiar al portapapeles" para que
// el usuario pueda mandarlos fácilmente al developer.
//
// Captura:
//   - window.onerror (errores sincrónicos)
//   - window.onunhandledrejection (Promesas que rechazan sin catch)
//   - console.error (sobrescrito para interceptar)
//
// Filtra ruido conocido (errores de extensiones Chrome que no son nuestros bugs).

import { useEffect, useState } from 'react';

interface CapturedError {
  id: string;
  timestamp: string;
  type: 'error' | 'unhandledRejection' | 'console.error';
  message: string;
  stack?: string;
  source?: string;
  // Si parece error de extensión Chrome, lo marcamos para diferenciarlo de bugs propios
  fromExtension: boolean;
}

const MAX_ERRORS = 50;

export function ErrorCollector() {
  const [errors, setErrors] = useState<CapturedError[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // v3.2 #123: auto-fix state
  const [autoFixState, setAutoFixState] = useState<
    'idle' | 'sending' | 'processing' | 'done' | 'error'
  >('idle');
  const [autoFixResult, setAutoFixResult] = useState<string | null>(null);

  useEffect(() => {
    const isFromExtension = (text: string): boolean =>
      /chrome-extension:\/\//i.test(text) ||
      /\b(frame_ant|adblock|grammarly|metamask)\b/i.test(text);

    // Patrones de ruido conocido que NO son bugs de la herramienta:
    // - AbortError del dev-overlay de Next.js (polling de source maps que se cancela)
    // - HMR / hot reload errors transitorios
    // - ResizeObserver loop notifications (browser quirk)
    const isKnownNoise = (text: string, source?: string): boolean => {
      const src = (source ?? '') + ' ' + text;
      return (
        /signal is aborted without reason/i.test(text) ||
        /AbortError/i.test(text) ||
        /react-dev-overlay/i.test(src) ||
        /ResizeObserver loop/i.test(text) ||
        /\bHMR\b|hot reload/i.test(src) ||
        /Hydration failed/i.test(text) // los reales se ven en consola del server
      );
    };

    const onError = (event: ErrorEvent) => {
      const stack = event.error?.stack ?? '';
      const msg = event.message ?? 'Unknown error';
      if (isKnownNoise(msg, stack)) return; // ignorar ruido del framework
      const fromExt = isFromExtension(stack) || isFromExtension(event.filename ?? '');
      addError({
        type: 'error',
        message: msg,
        stack,
        source: event.filename ?? '',
        fromExtension: fromExt,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const msg =
        reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason);
      const stack = reason instanceof Error ? reason.stack ?? '' : '';
      if (isKnownNoise(msg, stack)) return;
      const fromExt = isFromExtension(stack) || isFromExtension(msg);
      addError({
        type: 'unhandledRejection',
        message: msg,
        stack,
        fromExtension: fromExt,
      });
    };

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ');
      if (!isKnownNoise(text)) {
        const fromExt = isFromExtension(text);
        addError({
          type: 'console.error',
          message: text.slice(0, 800),
          fromExtension: fromExt,
        });
      }
      originalConsoleError.apply(console, args);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      console.error = originalConsoleError;
    };
  }, []);

  function addError(partial: Omit<CapturedError, 'id' | 'timestamp'>): void {
    setErrors((prev) => {
      const next: CapturedError = {
        ...partial,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
      };
      return [...prev, next].slice(-MAX_ERRORS);
    });
  }

  if (errors.length === 0) return null;

  const ourErrors = errors.filter((e) => !e.fromExtension);
  const extensionErrors = errors.filter((e) => e.fromExtension);

  const formatForExport = () => {
    const lines: string[] = [];
    lines.push(`# Errores capturados — ${new Date().toLocaleString()}`);
    lines.push(`URL: ${typeof window !== 'undefined' ? window.location.href : ''}`);
    lines.push(`User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`);
    lines.push('');
    lines.push(`## Errores propios (${ourErrors.length})`);
    for (const e of ourErrors) {
      lines.push(`\n[${e.timestamp}] ${e.type}: ${e.message}`);
      if (e.source) lines.push(`  source: ${e.source}`);
      if (e.stack) lines.push(`  stack:\n${e.stack.split('\n').map((l) => '    ' + l).join('\n')}`);
    }
    if (extensionErrors.length > 0) {
      lines.push(`\n## Errores de extensiones de Chrome (NO son bugs de la herramienta) (${extensionErrors.length})`);
      for (const e of extensionErrors) {
        lines.push(`\n[${e.timestamp}] ${e.type}: ${e.message}`);
        if (e.stack) lines.push(`  stack:\n${e.stack.split('\n').slice(0, 3).map((l) => '    ' + l).join('\n')}`);
      }
    }
    return lines.join('\n');
  };

  const handleDownload = () => {
    const blob = new Blob([formatForExport()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `errores-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    const text = formatForExport();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: textarea oculto + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClear = () => {
    setErrors([]);
  };

  // v3.2 #123: Auto-fix con Claude. Envía los errores propios al endpoint de
  // auto-fix, que los pasa por Sonnet para diagnóstico + aplica fixes seguros.
  const handleAutoFix = async () => {
    const targets = ourErrors.slice(-10); // últimos 10 errores propios
    if (targets.length === 0) return;
    setAutoFixState('sending');
    setAutoFixResult(null);
    try {
      // 1. Reportar cada error al queue
      for (const e of targets) {
        try {
          await fetch('/api/admin/auto-fix/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: e.message,
              stack: e.stack,
              source: 'client',
              context: `${e.type} from ${e.source ?? 'browser'}`,
            }),
          });
        } catch {
          /* ignore individual failures */
        }
      }
      // 2. Disparar el procesamiento
      setAutoFixState('processing');
      const res = await fetch('/api/admin/auto-fix', { method: 'POST' });
      if (!res.ok) {
        setAutoFixState('error');
        setAutoFixResult(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setAutoFixState('done');
      const s = data.summary as {
        total: number;
        applied: number;
        queued: number;
        noFix: number;
      };
      setAutoFixResult(
        `${s.applied}/${s.total} fixes aplicados automáticamente · ${s.queued} encolados para review · ${s.noFix} sin fix conocido`,
      );
      if (s.applied > 0) {
        // Si se aplicaron fixes, limpiar los errores resueltos
        setTimeout(() => setErrors([]), 2000);
      }
    } catch (e) {
      setAutoFixState('error');
      setAutoFixResult((e as Error).message);
    }
  };

  // v3.2 (29-may-2026): si TODOS son de extensiones, mostramos la chapita
  // en color ÁMBAR (info) en vez de ROJO (alerta). Una pestaña roja te hace
  // pensar que algo está roto cuando en realidad es solo ruido de Grammarly,
  // MetaMask, AdBlock, etc. — bugs que vienen de OTRAS apps cargadas en tu
  // browser, no de Video Factory. Y la colapsamos por defecto a ICONO chico.
  const onlyExtensionNoise = ourErrors.length === 0 && extensionErrors.length > 0;
  const badgeBg = onlyExtensionNoise ? 'rgba(217,119,6,0.92)' : 'rgba(220,38,38,0.95)';
  const borderColor = onlyExtensionNoise ? 'rgba(217,119,6,0.4)' : 'rgba(220,38,38,0.4)';

  return (
    <div
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 9999,
        maxWidth: open ? '480px' : onlyExtensionNoise ? '180px' : '240px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: onlyExtensionNoise && !open ? '11px' : '13px',
        boxShadow: '0 10px 28px rgba(0,0,0,0.25)',
        borderRadius: '8px',
        overflow: 'hidden',
        border: `1px solid ${borderColor}`,
        opacity: onlyExtensionNoise && !open ? 0.75 : 1,
      }}
    >
      {/* Header colapsado */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          padding: onlyExtensionNoise && !open ? '6px 10px' : '10px 14px',
          background: badgeBg,
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontWeight: 600,
        }}
        title={
          onlyExtensionNoise
            ? 'Todos estos errores vienen de extensiones de Chrome (Grammarly, MetaMask, AdBlock, etc.). NO son bugs de Video Factory. Para verlos sin ruido, abre la herramienta en modo Incógnito.'
            : 'Errores capturados en la sesión actual. Click para ver detalle.'
        }
      >
        {open ? '▾' : '▸'}{' '}
        {onlyExtensionNoise ? (
          <>
            ⚠ {errors.length} ruido extensiones
          </>
        ) : (
          <>
            {errors.length} {errors.length === 1 ? 'error' : 'errores'} capturado
            {errors.length === 1 ? '' : 's'}
          </>
        )}
      </button>

      {open && (
        <div style={{ background: '#1a1a1a', color: '#e5e5e5', padding: '12px 14px', maxHeight: '60vh', overflow: 'auto' }}>
          {/* Botones de acción */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={handleDownload}
              style={{
                padding: '6px 12px',
                background: '#FFE600',
                color: '#1a1a1a',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              ⬇ Descargar todos los errores
            </button>
            <button
              onClick={handleCopy}
              style={{
                padding: '6px 12px',
                background: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              {copied ? '✓ Copiado' : '📋 Copiar al portapapeles'}
            </button>
            <button
              onClick={handleClear}
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: '#e5e5e5',
                border: '1px solid #555',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              Limpiar
            </button>
            {ourErrors.length > 0 && (
              <button
                onClick={handleAutoFix}
                disabled={autoFixState === 'sending' || autoFixState === 'processing'}
                style={{
                  padding: '6px 12px',
                  background: autoFixState === 'done' ? '#10b981' : '#a855f7',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  fontWeight: 600,
                  cursor:
                    autoFixState === 'sending' || autoFixState === 'processing'
                      ? 'wait'
                      : 'pointer',
                  fontSize: '12px',
                  opacity:
                    autoFixState === 'sending' || autoFixState === 'processing' ? 0.6 : 1,
                }}
                title="Envía los errores a Claude Sonnet para diagnóstico + auto-aplica fixes con confidence ≥85%"
              >
                {autoFixState === 'sending' && '🤖 Enviando...'}
                {autoFixState === 'processing' && '🤖 Claude analizando...'}
                {autoFixState === 'done' && '✓ Auto-fix completado'}
                {autoFixState === 'error' && '⚠ Reintentar'}
                {autoFixState === 'idle' && '🤖 Solucionar con Claude'}
              </button>
            )}
          </div>
          {autoFixResult && (
            <div
              style={{
                padding: '8px 10px',
                background:
                  autoFixState === 'done'
                    ? 'rgba(16,185,129,0.15)'
                    : 'rgba(220,38,38,0.15)',
                borderLeft: `3px solid ${
                  autoFixState === 'done' ? '#10b981' : '#dc2626'
                }`,
                marginBottom: '10px',
                borderRadius: '3px',
                fontSize: '11px',
              }}
            >
              {autoFixResult}
            </div>
          )}

          {/* Resumen */}
          {extensionErrors.length > 0 && (
            <div style={{ padding: '8px 10px', background: 'rgba(251,191,36,0.15)', borderLeft: '3px solid #fbbf24', marginBottom: '10px', borderRadius: '3px' }}>
              <strong>{extensionErrors.length}</strong> error{extensionErrors.length === 1 ? '' : 'es'} {extensionErrors.length === 1 ? 'es' : 'son'} de extensiones de Chrome (NO son bugs de la herramienta). Prueba en una ventana de incógnito.
            </div>
          )}

          {/* Lista */}
          {errors.slice(-10).reverse().map((e) => (
            <div
              key={e.id}
              style={{
                padding: '8px 10px',
                background: e.fromExtension ? 'rgba(251,191,36,0.1)' : 'rgba(220,38,38,0.15)',
                borderLeft: `3px solid ${e.fromExtension ? '#fbbf24' : '#dc2626'}`,
                marginBottom: '6px',
                borderRadius: '3px',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '11px',
              }}
            >
              <div style={{ opacity: 0.7, fontSize: '10px' }}>
                {new Date(e.timestamp).toLocaleTimeString()} · {e.type} {e.fromExtension && '· EXT'}
              </div>
              <div style={{ marginTop: '2px', wordBreak: 'break-word' }}>{e.message.slice(0, 200)}</div>
            </div>
          ))}

          {errors.length > 10 && (
            <div style={{ opacity: 0.6, fontSize: '11px', marginTop: '6px' }}>
              … y {errors.length - 10} más (descargá el TXT para ver todos).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
