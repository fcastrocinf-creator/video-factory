import pino, { type Logger, type LoggerOptions } from 'pino';

export function createLogger(runId: string, extra?: Record<string, unknown>): Logger {
  const options: LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { runId, ...extra },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(options);
}

export type { Logger };
