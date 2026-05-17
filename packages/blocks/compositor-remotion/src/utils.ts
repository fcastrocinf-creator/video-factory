import type { SubtitleLine, SubtitleWord } from '@video-factory/contracts';

export function findActiveLine(lines: SubtitleLine[], timeSeconds: number): SubtitleLine | null {
  for (const line of lines) {
    if (timeSeconds >= line.startTimeSeconds && timeSeconds < line.endTimeSeconds) {
      return line;
    }
  }
  return null;
}

export function isWordActive(word: SubtitleWord, timeSeconds: number): boolean {
  return timeSeconds >= word.startTimeSeconds && timeSeconds < word.endTimeSeconds;
}

// Interpolación lineal 0→1 acotada a [0, 1]. Equivalente al Remotion `interpolate`
// para extrapolación clamp, pero como función pura sin depender de Remotion.
export function clampedProgress(frame: number, totalFrames: number): number {
  if (totalFrames <= 0) return 0;
  const raw = frame / (totalFrames - 1);
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

export function interpolateKenBurnsZoom(
  frame: number,
  totalFrames: number,
  zoomStart: number,
  zoomEnd: number,
  enabled: boolean,
): number {
  if (!enabled) return zoomStart;
  const t = clampedProgress(frame, totalFrames);
  return zoomStart + (zoomEnd - zoomStart) * t;
}

export function interpolateKenBurnsPan(
  frame: number,
  totalFrames: number,
  panEnd: number,
  enabled: boolean,
): number {
  if (!enabled) return 0;
  const t = clampedProgress(frame, totalFrames);
  return panEnd * t;
}

export function durationToFrames(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.ceil(durationSeconds * fps));
}
