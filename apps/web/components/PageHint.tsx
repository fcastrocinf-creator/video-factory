// Cartelito "para qué sirve" — explica de un vistazo cuándo usar cada sección.
// Re-work UX (31-may-2026): el owner pidió que siempre se sepa "cuándo usar qué".

export function PageHint({ emoji, children }: { emoji?: string; children: React.ReactNode }) {
  return (
    <div
      className="mb-6 flex gap-2.5 rounded-[10px] border border-[#2a2f3c] border-l-[3px] border-l-[#7c6cff] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#9aa3b2]"
      style={{ background: 'linear-gradient(90deg, rgba(124,108,255,0.10), transparent)' }}
    >
      {emoji && <span className="shrink-0 text-base">{emoji}</span>}
      <div>{children}</div>
    </div>
  );
}

// Encabezado de página consistente: título + subtítulo corto.
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
