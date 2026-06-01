import { redirect } from 'next/navigation';

// El Arquitecto IA se consolidó dentro del "Asistente IA" como el modo "Técnico".
// Mantenemos esta ruta como redirección para no romper enlaces antiguos.
export default function ArquitectoRedirect() {
  redirect('/sugerencias');
}
