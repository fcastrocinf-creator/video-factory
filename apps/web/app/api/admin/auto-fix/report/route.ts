// POST /api/admin/auto-fix/report
//
// Endpoint para REPORTAR errores capturados en runtime (client-side global
// boundary, server-side handlers, manual trigger). El error se encola en
// auto-fix queue para procesamiento ulterior.
//
// Body:
//   {
//     "message": "string",
//     "stack": "string (opcional)",
//     "filePath": "string (opcional, heurística)",
//     "line": number (opcional),
//     "context": "string (opcional)",
//     "source": "client" | "server" | "pipeline" | "validator" | "manual"
//   }

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { captureError, ErrorReportSchema } from '@/lib/auto-fix';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isAuthenticated()) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  try {
    const body = await req.json();
    const parsed = ErrorReportSchema.omit({ id: true, timestampIso: true }).safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body inválido: ${parsed.error.message.slice(0, 200)}` },
        { status: 400 },
      );
    }
    const report = await captureError(parsed.data);

    // OPCIONAL: auto-process immediately (fire-and-forget)
    // No esperamos resultado para no bloquear al cliente
    if (process.env['AUTO_FIX_PROCESS_ON_REPORT'] === '1') {
      void import('@/lib/auto-fix').then(({ processAutoFixQueue }) => {
        void processAutoFixQueue(
          require('node:path').resolve(process.cwd(), '..', '..'),
        ).catch(() => {});
      });
    }

    return NextResponse.json({
      ok: true,
      errorId: report.id,
      message: 'Error capturado en queue. Llamá a /api/admin/auto-fix POST para procesarlo.',
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
