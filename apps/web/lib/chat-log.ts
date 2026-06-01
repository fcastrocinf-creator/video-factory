// Registro de chats (Copilot + paneles IA) para mejorar la herramienta.
// El owner pidió dejar registro de las conversaciones de los usuarios. Se guarda
// LOCAL (storage/chat-logs/, gitignored) como JSONL — una línea por turno.
// Best-effort: nunca debe romper el chat si falla la escritura.

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STORAGE_DIR } from './paths';
import { recordEvent } from './kb/record';

const CHAT_LOG_DIR = resolve(STORAGE_DIR, 'chat-logs');
const CHAT_LOG_FILE = resolve(CHAT_LOG_DIR, 'chats.jsonl');

export interface ChatLogEntry {
  contextType: string;
  userMessage: string;
  reply: string;
  page?: string;
}

export async function appendChatLog(entry: ChatLogEntry): Promise<void> {
  try {
    await mkdir(CHAT_LOG_DIR, { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    await appendFile(CHAT_LOG_FILE, line, 'utf-8');
    // Fase 0 Base de Conocimiento: el chat también entra como Evento (vault producto).
    void recordEvent({
      vault: 'producto',
      subsistema: 'chat',
      tipo: 'chat',
      entidad: {},
      titulo: `Chat ${entry.contextType}: ${entry.userMessage.slice(0, 60)}`,
      contenido: `**Usuario:** ${entry.userMessage}\n\n**IA:** ${entry.reply}`,
      fuente: `user:${entry.contextType}`,
      tags: entry.page ? [entry.contextType, `page:${entry.page}`] : [entry.contextType],
    });
  } catch {
    // best-effort: el registro no debe interrumpir la conversación.
  }
}
