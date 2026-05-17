import Link from 'next/link';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <Link href="/create" className="text-sm font-semibold tracking-tight">
            Video Factory
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/create" className="text-muted-foreground hover:text-foreground">
              Crear
            </Link>
          </nav>
        </div>
      </header>
      <main className="container py-8">{children}</main>
    </div>
  );
}
