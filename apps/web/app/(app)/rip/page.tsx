import { RipUploader } from './RipUploader';
import { PageHeader, PageHint } from '@/components/PageHint';

export const dynamic = 'force-dynamic';

export default function RipPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Ripear anuncio" subtitle="Copia un anuncio que ya funciona y adáptalo a tu producto" />
      <PageHint emoji="🎯">
        <b className="text-foreground">Parte de un anuncio que ya funciona.</b> Sube el MP4 de referencia: la
        IA analiza sus escenas, narrador y estilo. Luego puedes <b className="text-foreground">ripearlo</b>
        (mismo video adaptado a tu producto) o pedir <b className="text-foreground">guiones similares</b> que
        mantienen la línea pero hablan de lo tuyo.
      </PageHint>
      <RipUploader />
    </div>
  );
}
