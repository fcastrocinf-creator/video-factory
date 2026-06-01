import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ErrorCollector } from '@/components/ErrorCollector';

// Tipografía estilo Apple: en equipos Apple se usa la San Francisco real (vía
// el stack del sistema en tailwind.config.ts) y, para el resto (Windows/Linux),
// Inter — su mejor equivalente legible. Prioriza la lectura cómoda.
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Video Factory',
  description: 'Herramienta interna para generar videos verticales 9:16 con IA',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`dark ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
        <ErrorCollector />
      </body>
    </html>
  );
}
