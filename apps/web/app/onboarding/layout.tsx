import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Configuración inicial — Video Factory',
  description: 'Verifica que tu instalación de Video Factory esté lista para usar.',
};

/**
 * Layout mínimo para la ruta /onboarding.
 *
 * NO incluye Sidebar ni CopilotWidget (esos viven solo en (app)/layout.tsx).
 * Esta ruta es pública (pre-auth), por lo que no debe tener elementos de
 * navegación que requieran sesión.
 */
export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {children}
    </div>
  );
}
