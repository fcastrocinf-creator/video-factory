import { RipUploader } from './RipUploader';

export const dynamic = 'force-dynamic';

export default function RipPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Ripear anuncio</h1>
        <p className="text-sm text-muted-foreground">
          Sube un MP4 de un anuncio de referencia. Una IA analiza qué sucede en el
          video (escenas, narrador, línea editorial, producto). Después puedes:
        </p>
        <ul className="mt-2 list-disc pl-6 text-sm text-muted-foreground space-y-1">
          <li><strong>Ripear anuncio</strong>: reproduce el mismo video adaptado a tu producto (traducción + reemplazo de marca).</li>
          <li><strong>Script similar</strong>: propone 3 guiones nuevos que mantienen la línea editorial pero hablan de tu producto. Aprobás o pedís cambios.</li>
        </ul>
      </div>
      <RipUploader />
    </div>
  );
}
