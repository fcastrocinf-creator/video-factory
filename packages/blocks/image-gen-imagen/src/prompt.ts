// Sustitución de placeholders {variable} dentro del promptTemplate del preset.
// Los placeholders sin valor en `variables` se preservan tal cual (no rompen).
export function buildPrompt(template: string, variables: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (typeof key !== 'string') return match;
    return variables[key] ?? match;
  });
}

// Lee width/height directamente del header IHDR del PNG sin necesidad de
// librerías externas (los bytes 16-23 son big-endian uint32 width/height).
export function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) {
    throw new Error('Buffer demasiado corto para ser un PNG válido.');
  }
  const signatureA = buffer.readUInt32BE(0);
  const signatureB = buffer.readUInt32BE(4);
  if (signatureA !== 0x89504e47 || signatureB !== 0x0d0a1a0a) {
    throw new Error('El buffer no es un PNG válido (signature incorrecta).');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}
