import { z } from 'zod';

export const SubtitleWordSchema = z.object({
  word: z.string(),
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
});

export type SubtitleWord = z.infer<typeof SubtitleWordSchema>;

export const SubtitleLineSchema = z.object({
  text: z.string(),
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
  wordRefs: z.array(z.number().int().nonnegative()),
});

export type SubtitleLine = z.infer<typeof SubtitleLineSchema>;

export const SubtitleTrackSchema = z.object({
  language: z.string(),
  words: z.array(SubtitleWordSchema),
  lines: z.array(SubtitleLineSchema),
});

export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
