// Registro de chats (Copilot + paneles IA) para mejorar la herramienta.
// El owner pidió dejar registro de las conversaciones de los usuarios. Se guarda
// LOCAL (storage/chat-logs/, gitignored) como JSONL — una línea por turno.
// Best-effort: nunca debe romper el chat si falla la escritura.

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STORAGE_DIR } from './paths';

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
  } catch {
    // best-effort: el registro no debe interrumpir la conversación.
  }
}
