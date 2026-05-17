import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { SubtitleTrack } from '@video-factory/contracts';
import { PlanoFijo, type PlanoFijoProps } from './PlanoFijo.js';

const DEFAULT_SUBTITLE_TRACK: SubtitleTrack = {
  language: 'es',
  words: [],
  lines: [],
};

const DEFAULT_PROPS: PlanoFijoProps = {
  audioSrc: 'audio.mp3',
  imageSrc: 'image.png',
  subtitleTrack: DEFAULT_SUBTITLE_TRACK,
  subtitlesConfig: {
    style: 'word_level_kinetic',
    font: 'Inter',
    fontSize: 64,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 4,
    highlightColor: '#FFE600',
    position: 'bottom',
    allCaps: false,
  },
  composition: {
    kenBurns: {
      enabled: true,
      zoomStart: 1.0,
      zoomEnd: 1.15,
      panX: 0,
      panY: -20,
    },
    backgroundMusic: {
      enabled: false,
      volumeDb: -20,
    },
  },
};

// El tipado de <Composition> de Remotion exige `component: ComponentType<Record<string, unknown>>`
// porque los inputProps se pasan dinámicamente en runtime. PlanoFijo tiene props tipadas,
// así que el cast es necesario y seguro: validamos los inputProps con Zod antes de invocar el render.
const PlanoFijoLoose = PlanoFijo as unknown as React.ComponentType<Record<string, unknown>>;

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
        defaultProps={DEFAULT_PROPS as unknown as Record<string, unknown>}
      />
    </>
  );
};

registerRoot(RemotionRoot);
