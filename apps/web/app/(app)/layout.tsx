import { Sidebar } from '@/components/Sidebar';
import { CopilotWidget } from '@/components/CopilotWidget';
import { isOwner } from '@/lib/auth';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar isOwner={isOwner()} />
      <main className="flex-1 min-w-0">
        <div className="px-6 md:px-10 py-8 max-w-[1180px]">{children}</div>
      </main>
      <CopilotWidget />
    </div>
  );
}
