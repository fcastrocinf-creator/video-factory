import type { AudioSegment, ScriptSegment } from '@video-factory/contracts';

export function buildPrompt(segments: ScriptSegment[]): string {
  return segments
    .map((segment, index) => {
      const isLast = index === segments.length - 1;
      if (isLast || segment.pauseAfterMs === 0) {
        return segment.text;
      }
      return `${segment.text} <break time="${segment.pauseAfterMs}ms"/>`;
    })
    .join(' ');
}

// Distribuye la duración total entre los segmentos proporcionalmente al largo del texto.
// Es la aproximación que pide el doc: "calcula timing aproximando por duración total".
// El timing word-level real lo provee Whisper en B.3.
export function computeSegmentTimings(
  segments: ScriptSegment[],
  totalDurationSeconds: number,
): AudioSegment[] {
  if (segments.length === 0) return [];

  const totalChars = segments.reduce((acc, s) => acc + s.text.length, 0);
  if (totalChars === 0) return [];

  let cursor = 0;
  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const ratio = segment.text.length / totalChars;
    const duration = totalDurationSeconds * ratio;
    const startTimeSeconds = roundTo(cursor, 3);
    cursor += duration;
    // Forzar el último endTime al total para evitar drift por redondeo.
    const endTimeSeconds = isLast ? roundTo(totalDurationSeconds, 3) : roundTo(cursor, 3);
    return {
      text: segment.text,
      startTimeSeconds,
      endTimeSeconds,
    };
  });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
