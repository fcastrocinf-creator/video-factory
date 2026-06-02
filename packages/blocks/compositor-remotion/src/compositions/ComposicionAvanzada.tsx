import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Video,
  Easing,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// ─────────────────────────────────────────────────────────────────────────────
// ComposicionAvanzada — PROTOTIPO de edición/composición estilo CapCut.
// Demuestra los primitivos clave que faltaban: capas superpuestas (PiP),
// RECORTE de fondo por chroma key (pantalla verde), caption karaoke y
// anotaciones (flecha + círculo). Todo es Remotion puro (sin dependencias de
// recorte): el chroma key se hace con un filtro SVG feColorMatrix que vuelve
// transparente el verde — funciona en el render headless.
//
// En producción, el "sujeto" superpuesto (ej. el médico) se genera sobre fondo
// verde y este MISMO componente lo recorta y lo compone sobre el video base.
// ─────────────────────────────────────────────────────────────────────────────

export interface AvanzadaOverlay {
  /** Path relativo al publicDir (staticFile). */
  src: string;
  isVideo: boolean;
  /** Si true, elimina el fondo verde (chroma key). */
  chromaKey?: boolean;
  /** Posición de la caja del overlay (esquina sup-izq), en % del lienzo. */
  xPct: number;
  yPct: number;
  /** Ancho de la caja en % del lienzo. */
  widthPct: number;
  /** Esquinas redondeadas + borde (look "burbuja" de talking-head). */
  rounded?: boolean;
  border?: boolean;
  /** Segundo en el que aparece (pop-in). Default 0. */
  startSec?: number;
}

export interface AvanzadaAnnotation {
  /** Centro del círculo, en % del lienzo. */
  xPct: number;
  yPct: number;
  rxPct: number;
  ryPct: number;
  /** Origen de la flecha (en % del lienzo). Si se omite, no dibuja flecha. */
  arrowFromXPct?: number;
  arrowFromYPct?: number;
  startSec?: number;
  color?: string;
}

export interface ComposicionAvanzadaProps {
  backgroundSrc: string;
  backgroundIsVideo?: boolean;
  overlays: AvanzadaOverlay[];
  caption?: { text: string; highlightWord?: string; startSec?: number };
  annotation?: AvanzadaAnnotation;
  musicSrc?: string;
}

const CHROMA_FILTER_ID = 'vf-chroma-key';

export const ComposicionAvanzada: React.FC<ComposicionAvanzadaProps> = ({
  backgroundSrc,
  backgroundIsVideo = true,
  overlays,
  caption,
  annotation,
  musicSrc,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Definición del filtro chroma key (alpha = R - G + B → el verde puro se
          vuelve transparente; piel/blancos quedan opacos). */}
      <svg width={0} height={0} style={{ position: 'absolute' }}>
        <defs>
          <filter id={CHROMA_FILTER_ID} colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      1 -1 1 0 0"
            />
            {/* Suaviza un poco el borde del recorte. */}
            <feComponentTransfer>
              <feFuncA type="linear" slope="3" intercept="-0.4" />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>

      {/* Capa 0 — fondo (video base). */}
      <AbsoluteFill>
        {backgroundIsVideo ? (
          <Video
            src={staticFile(backgroundSrc)}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Img
            src={staticFile(backgroundSrc)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </AbsoluteFill>

      {/* Capas de overlays (PiP / recorte). */}
      {overlays.map((ov, i) => {
        const startFrame = Math.round((ov.startSec ?? 0) * fps);
        const appear = spring({
          frame: frame - startFrame,
          fps,
          config: { damping: 14, mass: 0.6 },
        });
        if (frame < startFrame) return null;
        const mediaStyle: React.CSSProperties = {
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: ov.chromaKey ? `url(#${CHROMA_FILTER_ID})` : undefined,
        };
        return (
          <div
            key={`${ov.src}-${i}`}
            style={{
              position: 'absolute',
              left: `${ov.xPct}%`,
              top: `${ov.yPct}%`,
              width: `${ov.widthPct}%`,
              aspectRatio: '9 / 16',
              transform: `scale(${appear})`,
              transformOrigin: 'center bottom',
              borderRadius: ov.rounded ? 28 : 0,
              overflow: 'hidden',
              boxShadow: ov.border ? '0 8px 40px rgba(0,0,0,0.5)' : undefined,
              border: ov.border ? '4px solid rgba(255,255,255,0.9)' : undefined,
            }}
          >
            {ov.isVideo ? (
              <Video src={staticFile(ov.src)} muted style={mediaStyle} />
            ) : (
              <Img src={staticFile(ov.src)} style={mediaStyle} />
            )}
          </div>
        );
      })}

      {/* Anotación — círculo + flecha rojos (dibujo animado). */}
      {annotation && (
        <Annotation frame={frame} fps={fps} width={width} height={height} a={annotation} />
      )}

      {/* Caption karaoke (palabra resaltada). */}
      {caption && <Caption frame={frame} fps={fps} caption={caption} />}

      {musicSrc ? <Audio src={staticFile(musicSrc)} volume={0.5} /> : null}
    </AbsoluteFill>
  );
};

const Annotation: React.FC<{
  frame: number;
  fps: number;
  width: number;
  height: number;
  a: AvanzadaAnnotation;
}> = ({ frame, fps, width, height, a }) => {
  const start = Math.round((a.startSec ?? 0) * fps);
  if (frame < start) return null;
  const color = a.color ?? '#FF3B30';
  const cx = (a.xPct / 100) * width;
  const cy = (a.yPct / 100) * height;
  const rx = (a.rxPct / 100) * width;
  const ry = (a.ryPct / 100) * height;
  const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const draw = interpolate(frame - start, [0, fps * 0.6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill="none"
        stroke={color}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - draw)}
      />
      {a.arrowFromXPct !== undefined && a.arrowFromYPct !== undefined && (
        <Arrow
          x1={(a.arrowFromXPct / 100) * width}
          y1={(a.arrowFromYPct / 100) * height}
          x2={cx}
          y2={cy + ry}
          color={color}
          progress={draw}
        />
      )}
    </svg>
  );
};

const Arrow: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  progress: number;
}> = ({ x1, y1, x2, y2, color, progress }) => {
  const ex = x1 + (x2 - x1) * progress;
  const ey = y1 + (y2 - y1) * progress;
  const angle = Math.atan2(ey - y1, ex - x1);
  const head = 26;
  return (
    <>
      <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={color} strokeWidth={10} strokeLinecap="round" />
      {progress > 0.9 && (
        <polygon
          points={`${ex},${ey} ${ex - head * Math.cos(angle - 0.5)},${ey - head * Math.sin(angle - 0.5)} ${ex - head * Math.cos(angle + 0.5)},${ey - head * Math.sin(angle + 0.5)}`}
          fill={color}
        />
      )}
    </>
  );
};

const Caption: React.FC<{
  frame: number;
  fps: number;
  caption: { text: string; highlightWord?: string; startSec?: number };
}> = ({ frame, fps, caption }) => {
  const start = Math.round((caption.startSec ?? 0) * fps);
  if (frame < start) return null;
  const pop = spring({ frame: frame - start, fps, config: { damping: 12, mass: 0.5 } });
  const words = caption.text.split(' ');
  const stroke = '#000';
  const strokeW = 5;
  const offsets: Array<[number, number]> = [];
  for (let dx = -strokeW; dx <= strokeW; dx++)
    for (let dy = -strokeW; dy <= strokeW; dy++) if (dx || dy) offsets.push([dx, dy]);
  const textShadow = offsets.map(([dx, dy]) => `${dx}px ${dy}px 0 ${stroke}`).join(', ');
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '14%',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '0.25em',
        padding: '0 60px',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: 800,
        fontSize: 72,
        lineHeight: 1.15,
        textShadow,
        transform: `scale(${interpolate(pop, [0, 1], [0.8, 1])})`,
      }}
    >
      {words.map((w, i) => {
        const hot = caption.highlightWord && w.toLowerCase().includes(caption.highlightWord.toLowerCase());
        return (
          <span key={i} style={{ color: hot ? '#FFE600' : '#FFFFFF' }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};
