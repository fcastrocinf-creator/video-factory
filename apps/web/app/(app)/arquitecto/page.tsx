import { ClaudeChatPanel } from '@/components/ClaudeChatPanel';

// Arquitecto IA — copiloto que entiende la arquitectura de Video Factory y ayuda
// a que cada tipo de video tenga su ruta óptima. Reconoce "acá es diferente",
// diagnostica, y PROPONE cambios concretos para que el owner los apruebe.
// Backend: contextType 'architect' en claude-chat-discuss (Sonnet + perfiles de ruta).

export default function ArquitectoPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">🏗️ Arquitecto IA</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Un copiloto que entiende la arquitectura de Video Factory y te ayuda a que{' '}
        <strong>cada tipo de video tenga su ruta óptima</strong>. Reconoce cuándo &ldquo;acá es
        diferente&rdquo;, diagnostica por qué un tipo no sale bien, y{' '}
        <strong>propone cambios concretos para que tú los apruebes</strong> — nunca toca el código
        solo.
      </p>

      <ClaudeChatPanel
        contextType="architect"
        title="Habla con el Arquitecto"
        defaultOpen
        placeholder="Ej: 'El estilo acuarela me sale con texturas planas, ¿qué ruta necesita?' o 'Quiero una ruta nueva para videos tipo claymation'"
      />

      <div className="mt-6 rounded-md border border-input bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">Qué puede hacer</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Explicarte cómo trata la herramienta cada tipo de video (perfiles de ruta).</li>
          <li>Diagnosticar por qué un tipo no sale bien (validator, provider, animación, prompt).</li>
          <li>
            Proponer cambios concretos de ruta — perfiles, prompts de bloque, lógica — que{' '}
            <strong>tú apruebas</strong> antes de aplicar.
          </li>
        </ul>
        <p className="mt-2">
          Conoce los perfiles de ruta vivos, el pipeline, el validator y el &ldquo;cerebro&rdquo;
          que ya propone parches con tu aprobación (M7#5). Razona con Claude Sonnet.
        </p>
      </div>
    </div>
  );
}
