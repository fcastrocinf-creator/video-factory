import React from 'react';
import { AbsoluteFill, Audio, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type {
  PresetComposition,
  PresetSubtitles,
  SubtitleTrack,
} from '@video-factory/contracts';
import {
  findActiveLine,
  interpolateKenBurnsPan,
  interpolateKenBurnsZoom,
  isWordActive,
} from '../utils.js';

export interface PlanoFijoProps {
  audioSrc: string;
  imageSrc: string;
  subtitleTrack: SubtitleTrack;
  subtitlesConfig: PresetSubtitles;
  composition: PresetComposition;
}

export const PlanoFijo: React.FC<PlanoFijoProps> = ({
  audioSrc,
  imageSrc,
  subtitleTrack,
  subtitlesConfig,
  composition,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const currentSecond = frame / fps;

  const kb = composition.kenBurns;
  const zoom = interpolateKenBurnsZoom(frame, durationInFrames, kb.zoomStart, kb.zoomEnd, kb.enabled);
  const panX = interpolateKenBurnsPan(frame, durationInFrames, kb.panX, kb.enabled);
  const panY = interpolateKenBurnsPan(frame, durationInFrames, kb.panY, kb.enabled);

  const activeLine = findActiveLine(subtitleTrack.lines, currentSecond);

  const subtitleVerticalStyle = getVerticalPositionStyle(subtitlesConfig.position);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <Img
        src={staticFile(imageSrc)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
          transformOrigin: 'center center',
        }}
      />
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      {activeLine && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            ...subtitleVerticalStyle,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '0 60px',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '0.25em',
              maxWidth: '100%',
              fontFamily: subtitlesConfig.font,
              fontSize: subtitlesConfig.fontSize,
              fontWeight: 800,
              textTransform: subtitlesConfig.allCaps ? 'uppercase' : 'none',
              textShadow: buildTextShadow(subtitlesConfig.strokeColor, subtitlesConfig.strokeWidth),
              lineHeight: 1.15,
              textAlign: 'center',
            }}
          >
            {activeLine.wordRefs.map((wordIdx) => {
              const word = subtitleTrack.words[wordIdx];
              if (!word) return null;
              const active = isWordActive(word, currentSecond);
              return (
                <span
                  key={wordIdx}
                  style={{
                    color: active ? subtitlesConfig.highlightColor : subtitlesConfig.color,
                    transition: 'color 60ms linear',
                  }}
                >
                  {word.word}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

function getVerticalPositionStyle(position: PresetSubtitles['position']): React.CSSProperties {
  switch (position) {
    case 'top':
      return { top: '12%', bottom: 'auto' };
    case 'center':
      return { top: '50%', transform: 'translateY(-50%)' };
    case 'bottom':
    default:
      return { bottom: '15%', top: 'auto' };
  }
}

// Stroke "fake" via múltiples text-shadows en 8 direcciones. Más portable que -webkit-text-stroke.
function buildTextShadow(strokeColor: string, strokeWidth: number): string {
  const offsets: Array<[number, number]> = [];
  for (let dx = -strokeWidth; dx <= strokeWidth; dx++) {
    for (let dy = -strokeWidth; dy <= strokeWidth; dy++) {
      if (dx === 0 && dy === 0) continue;
      offsets.push([dx, dy]);
    }
  }
  return offsets.map(([dx, dy]) => `${dx}px ${dy}px 0 ${strokeColor}`).join(', ');
}
