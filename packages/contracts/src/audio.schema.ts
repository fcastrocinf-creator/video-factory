import { z } from 'zod';

export const AudioSegmentSchema = z.object({
  text: z.string(),
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().nonnegative(),
});

export type AudioSegment = z.infer<typeof AudioSegmentSchema>;

export const AudioTrackSchema = z.object({
  filePath: z.string(),
  durationSeconds: z.number().positive(),
  sampleRate: z.number().default(44100),
  channels: z.literal(1),
  format: z.literal('mp3'),

  segments: z.array(AudioSegmentSchema),
});

export type AudioTrack = z.infer<typeof AudioTrackSchema>;
