import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  Series,
  Video,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  PresetSubtitles,
  SubtitleTrack,
  VideoClip,
} from '@video-factory/contracts';
import { findActiveLine, isWordActive } from '../utils.js';

export interface PlanoAnimadoProps {
  audioSrc: string;
  // Array de paths relativos al publicDir, en orden.
  videoClipSrcs: string[];
  // Duración de cada clip (en segundos), mismo orden que videoClipSrcs.
  videoClipDurations: number[];
  subtitleTrack: SubtitleTrack;
  subtitlesConfig: PresetSubtitles;
}

export const PlanoAnimado: React.FC<PlanoAnimadoProps> = ({
  audioSrc,
  videoClipSrcs,
  videoClipDurations,
  subtitleTrack,
  subtitlesConfig,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentSecond = frame / fps;

  const activeLine = findActiveLine(subtitleTrack.lines, currentSecond);
  const subtitleVerticalStyle = getVerticalPositionStyle(subtitlesConfig.position);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      {/* Concatenamos los clips secuencialmente con <Series>. Cada Sequence dura
          exactamente lo que dura su clip. Si el último clip termina antes que el
          audio, el último frame se congela hasta que el audio finaliza. */}
      <Series>
        {videoClipSrcs.map((src, i) => {
          const durationSeconds = videoClipDurations[i] ?? 8;
          const durationInFrames = Math.max(1, Math.round(durationSeconds * fps));
          return (
            <Series.Sequence
              key={`${src}-${i}`}
              durationInFrames={durationInFrames}
              name={`Clip ${i}`}
            >
              <AbsoluteFill>
                <Video
                  src={staticFile(src)}
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              </AbsoluteFill>
            </Series.Sequence>
          );
        })}
      </Series>

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
