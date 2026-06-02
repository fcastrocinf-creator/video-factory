import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { SubtitleTrack } from '@video-factory/contracts';
import { PlanoFijo, type PlanoFijoProps } from './PlanoFijo.js';
import { PlanoAnimado, type PlanoAnimadoProps } from './PlanoAnimado.js';
import { PlanoEscenas, type PlanoEscenasProps } from './PlanoEscenas.js';
import { ComposicionAvanzada, type ComposicionAvanzadaProps } from './ComposicionAvanzada.js';

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

const DEFAULT_PLANO_ESCENAS_PROPS: PlanoEscenasProps = {
  audioSrc: 'audio.mp3',
  scenes: [{ imageSrc: 'scene_00.png', durationSeconds: 10 }],
  subtitleTrack: DEFAULT_SUBTITLE_TRACK,
  subtitlesConfig: DEFAULT_SUBTITLES_CONFIG,
};

const DEFAULT_AVANZADA_PROPS: ComposicionAvanzadaProps = {
  backgroundSrc: 'bg.mp4',
  backgroundIsVideo: true,
  overlays: [
    { src: 'person.png', isVideo: false, xPct: 56, yPct: 46, widthPct: 40, rounded: true, border: true, startSec: 0.2 },
    { src: 'badge-green.mp4', isVideo: true, chromaKey: true, xPct: 6, yPct: 10, widthPct: 26, startSec: 0.5 },
  ],
  caption: { text: 'y su papada', highlightWord: 'papada', startSec: 0.3 },
  annotation: { xPct: 42, yPct: 60, rxPct: 13, ryPct: 7, arrowFromXPct: 66, arrowFromYPct: 78, startSec: 0.6 },
};

// Cast: ver comentario en versiones anteriores. <Composition> exige ComponentType<Record<string, unknown>>.
const PlanoFijoLoose = PlanoFijo as unknown as React.ComponentType<Record<string, unknown>>;
const PlanoAnimadoLoose = PlanoAnimado as unknown as React.ComponentType<Record<string, unknown>>;
const PlanoEscenasLoose = PlanoEscenas as unknown as React.ComponentType<Record<string, unknown>>;
const ComposicionAvanzadaLoose = ComposicionAvanzada as unknown as React.ComponentType<Record<string, unknown>>;

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
      <Composition
        id="PlanoEscenas"
        component={PlanoEscenasLoose}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={DEFAULT_PLANO_ESCENAS_PROPS as unknown as Record<string, unknown>}
      />
      <Composition
        id="ComposicionAvanzada"
        component={ComposicionAvanzadaLoose}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={DEFAULT_AVANZADA_PROPS as unknown as Record<string, unknown>}
      />
    </>
  );
};

registerRoot(RemotionRoot);
