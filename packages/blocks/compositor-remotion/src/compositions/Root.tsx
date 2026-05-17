import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { SubtitleTrack } from '@video-factory/contracts';
import { PlanoFijo, type PlanoFijoProps } from './PlanoFijo.js';
import { PlanoAnimado, type PlanoAnimadoProps } from './PlanoAnimado.js';

const DEFAULT_SUBTITLE_TRACK: SubtitleTrack = {
  language: 'es',
  words: [],
  lines: [],
};

const DEFAULT_SUBTITLES_CONFIG = {
  style: 'word_level_kinetic' as const,
  font: 'Inter',
  fontSize: 64,
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 4,
  highlightColor: '#FFE600',
  position: 'bottom' as const,
  allCaps: false,
};

const DEFAULT_PLANO_FIJO_PROPS: PlanoFijoProps = {
  audioSrc: 'audio.mp3',
  imageSrc: 'image.png',
  subtitleTrack: DEFAULT_SUBTITLE_TRACK,
  subtitlesConfig: DEFAULT_SUBTITLES_CONFIG,
  composition: {
    kenBurns: { enabled: true, zoomStart: 1.0, zoomEnd: 1.15, panX: 0, panY: -20 },
    backgroundMusic: { enabled: false, volumeDb: -20 },
  },
};

const DEFAULT_PLANO_ANIMADO_PROPS: PlanoAnimadoProps = {
  audioSrc: 'audio.mp3',
  videoClipSrcs: ['clip_00.mp4'],
  videoClipDurations: [8],
  subtitleTrack: DEFAULT_SUBTITLE_TRACK,
  subtitlesConfig: DEFAULT_SUBTITLES_CONFIG,
};

// Cast: ver comentario en versiones anteriores. <Composition> exige ComponentType<Record<string, unknown>>.
const PlanoFijoLoose = PlanoFijo as unknown as React.ComponentType<Record<string, unknown>>;
const PlanoAnimadoLoose = PlanoAnimado as unknown as React.ComponentType<Record<string, unknown>>;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PlanoFijo"
        component={PlanoFijoLoose}
        durationInFrames={3600}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={DEFAULT_PLANO_FIJO_PROPS as unknown as Record<string, unknown>}
      />
      <Composition
        id="PlanoAnimado"
        component={PlanoAnimadoLoose}
        durationInFrames={240}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={DEFAULT_PLANO_ANIMADO_PROPS as unknown as Record<string, unknown>}
      />
    </>
  );
};

registerRoot(RemotionRoot);
