import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  CompositeLayout,
  PresetSubtitles,
  SubtitleTrack,
  TextOverlay,
} from '@video-factory/contracts';
import { findActiveLine, isWordActive } from '../utils.js';

// Panel individual de una escena composite (split-screen / grid / pip).
// Cada panel se genera como imagen INDEPENDIENTE por el aligner — esto resuelve
// el problema de los generators borrosean los paneles cuando se les pide una
// composición. Acá los re-juntamos pixel-perfect.
export interface SubScenePanel {
  panel: string; // 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-wide', 'left', 'right', 'top', 'bottom', 'main', 'pip'
  imageSrc: string; // basename dentro del publicDir
  textOverlay?: TextOverlay; // overlay vectorial propio del panel
}

// Elemento de composición LIBRE (freeform). Versión "visual" de CompositeElement
// del contrato: los paths vienen como basenames dentro del publicDir. Cada
// elemento se posiciona con coordenadas arbitrarias — habilita ediciones
// complejas tipo collage/PiP/overlay que no encajan en un grid rígido.
export interface CompositeElementVisual {
  id: string;
  kind: 'image' | 'video' | 'text';
  imageSrc?: string; // basename
  videoSrc?: string; // basename
  text?: string;
  rect: { xPct: number; yPct: number; widthPct: number; heightPct: number };
  rotationDeg?: number;
  opacity?: number;
  zIndex?: number;
  fit?: 'cover' | 'contain' | 'fill';
  cornerRadiusPct?: number;
  startSeconds?: number;
  endSeconds?: number;
  textOverlay?: TextOverlay;
}

export interface SceneVisual {
  imageSrc: string; // basename dentro del publicDir
  durationSeconds: number;
  // Opcional: si la escena fue animada con Veo, este es el basename del MP4.
  // Cuando está presente, el compositor renderiza OffthreadVideo (animación real)
  // en lugar de Img + CSS transforms. Si está vacío/undefined, fallback a imageSrc.
  videoSrc?: string;
  // Capas de texto que se renderizan ENCIMA de la imagen base. Resuelven el
  // problema de Imagen 4 fallando con texto (labels gibberish, calendar broken).
  textOverlays?: TextOverlay[];
  // Si la escena tiene compositeLayout != 'single', en vez de renderizar
  // imageSrc como única imagen base, el compositor renderiza cada panel de
  // subScenes en su posición correspondiente. imageSrc se conserva como fallback
  // (en caso de que el aligner haya fallado en generar paneles separados).
  compositeLayout?: CompositeLayout;
  subScenes?: SubScenePanel[];
  // Composición LIBRE. Cuando está poblada, la escena se renderiza con el motor
  // FreeformComposite (cada elemento en posición arbitraria) — tiene prioridad
  // sobre compositeLayout/subScenes/imageSrc. Es la estructura que produce el
  // detector de geometría exacta y que el editor manual manipula.
  composition?: CompositeElementVisual[];
}

export interface PlanoEscenasProps {
  audioSrc: string;
  scenes: SceneVisual[];
  subtitleTrack: SubtitleTrack;
  subtitlesConfig: PresetSubtitles;
  // Si false, los cortes son hard cuts (estilo TikTok/Reels denso). Si true, suave Ken Burns.
  kenBurnsZoomEnd?: number;
  // Ken Burns OPT-IN: SOLO cuando true se aplica pan/zoom a las imágenes estáticas.
  // Default false = imagen fija (sin movimiento). El usuario lo activa en la edición.
  kenBurns?: boolean;
  // Cuando true, cada escena se renderiza con motion AGRESIVA: zoom amplio +
  // pan dinámico + rotación sutil. Usado por formats 'b-roll-animated' y
  // 'voiceover-animated' para dar sensación de video animado sin pagar Veo
  // por escena. Trade-off: la imagen base sigue siendo estática, pero la
  // composición agrega vida.
  animatedScenes?: boolean;
}

export const PlanoEscenas: React.FC<PlanoEscenasProps> = ({
  audioSrc,
  scenes,
  subtitleTrack,
  subtitlesConfig,
  kenBurnsZoomEnd = 1.0,
  kenBurns = false,
  animatedScenes = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentSecond = frame / fps;

  const activeLine = findActiveLine(subtitleTrack.lines, currentSecond);
  const subtitleVerticalStyle = getVerticalPositionStyle(subtitlesConfig.position);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <Series>
        {scenes.map((scene, i) => {
          const durationInFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
          const isFreeform = scene.composition && scene.composition.length > 0;
          const isComposite =
            scene.compositeLayout &&
            scene.compositeLayout !== 'single' &&
            scene.subScenes &&
            scene.subScenes.length > 0;
          return (
            <Series.Sequence
              key={`${scene.imageSrc}-${i}`}
              durationInFrames={durationInFrames}
              name={`Scene ${i}`}
            >
              {isFreeform ? (
                <FreeformComposite
                  elements={scene.composition!}
                  durationInFrames={durationInFrames}
                  animatedScenes={animatedScenes}
                />
              ) : isComposite ? (
                <CompositeFrame
                  layout={scene.compositeLayout!}
                  panels={scene.subScenes!}
                  durationInFrames={durationInFrames}
                  sceneIndex={i}
                  animatedScenes={animatedScenes}
                />
              ) : (
                <SceneFrame
                  imageSrc={scene.imageSrc}
                  videoSrc={scene.videoSrc}
                  durationInFrames={durationInFrames}
                  zoomEnd={
                    animatedScenes
                      ? i % 2 === 0
                        ? 1.1
                        : 0.92
                      : i % 2 === 0
                        ? 1.06
                        : 0.96
                  }
                  kenBurns={kenBurns}
                  animatedScenes={animatedScenes}
                  sceneIndex={i}
                />
              )}
              {scene.textOverlays && scene.textOverlays.length > 0 && (
                <TextOverlayLayer overlays={scene.textOverlays} durationInFrames={durationInFrames} />
              )}
            </Series.Sequence>
          );
        })}
      </Series>

      <Audio src={staticFile(audioSrc)} />

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

// Sub-componente por escena. Soporta dos modos:
//   - microMotion=true: micro zoom in/out alternado (1.0→1.06 par, 1.0→0.96 impar) +
//     leve push/pull al inicio (primeros 8 frames de fade-in). Estilo TikTok/Reels denso.
//   - microMotion=false: Ken Burns clásico (zoom 1.0→1.12 lento).
const SceneFrame: React.FC<{
  imageSrc: string;
  videoSrc?: string;
  durationInFrames: number;
  zoomEnd: number;
  kenBurns: boolean;
  animatedScenes: boolean;
  sceneIndex: number;
}> = ({ imageSrc, videoSrc, durationInFrames, zoomEnd, kenBurns, animatedScenes, sceneIndex }) => {
  const localFrame = useCurrentFrame();
  const t = Math.min(1, Math.max(0, localFrame / Math.max(1, durationInFrames - 1)));

  // Si tenemos un videoSrc real generado por Veo, lo renderizamos con motion
  // mínima (zoom muy leve para suavizar) — la animación REAL ya viene del video.
  // CSS transforms agresivas sobre un video animado son contraproducentes.
  if (videoSrc) {
    const subtleZoom = 1 + 0.04 * t; // 0% → 4% — muy sutil
    const FADE_FRAMES = 6;
    const opacity = Math.min(1, localFrame / FADE_FRAMES);
    return (
      <AbsoluteFill style={{ opacity }}>
        <OffthreadVideo
          src={staticFile(videoSrc)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${subtleZoom})`,
            transformOrigin: 'center center',
          }}
          muted // el audio del video Veo se descarta — usamos el audio narrador del compositor
          playbackRate={1}
        />
      </AbsoluteFill>
    );
  }

  // Fallback: imagen estática. MOVIMIENTO (Ken Burns) SOLO si se pidió (kenBurns).
  // Default = HOLD (sin pan/zoom/rotación): el motion automático sobre estáticas se
  // sentía como "Ken Burns no solicitado". El usuario lo activa desde la edición.
  const panDirection = sceneIndex % 4;
  const motionOn = kenBurns;
  const panMax = !motionOn ? 0 : animatedScenes ? 60 : 30;
  let panX = 0;
  let panY = 0;
  if (motionOn) {
    if (panDirection === 0) panX = panMax * t;
    else if (panDirection === 1) panX = -panMax * t;
    else if (panDirection === 2) panY = panMax * t;
    else panY = -panMax * t;
  }

  const zoom = 1 + ((motionOn ? zoomEnd : 1.0) - 1) * t;

  const rotation = motionOn && animatedScenes ? (sceneIndex % 2 === 0 ? 0.6 : -0.6) * t : 0;

  // Fade-in suave de 4 frames al inicio. animatedScenes alarga el fade a 6
  // para suavizar transiciones entre clips animados.
  const FADE_FRAMES = animatedScenes ? 6 : 4;
  const opacity = Math.min(1, localFrame / FADE_FRAMES);

  // N1 fix defensivo (25-may-2026): si por algún edge case el imageSrc viene
  // vacío/undefined, renderizamos un placeholder VISIBLE en vez de transparent/negro.
  // Eso permite que el post-render judge (M5) detecte el problema sin que el
  // viewer vea un frame negro silencioso. Color #2a1810 (sepia oscuro) matchea
  // mejor con presets acuarela; sino fallback a #1a1a1a.
  if (!imageSrc || imageSrc.length === 0) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: '#2a1810',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            color: '#ffcc88',
            fontSize: 48,
            fontFamily: 'Inter, sans-serif',
            opacity: 0.5,
            textAlign: 'center',
            padding: '0 60px',
          }}
        >
          [missing visual · scene {sceneIndex}]
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={staticFile(imageSrc)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${zoom}) translate(${panX}px, ${panY}px) rotate(${rotation}deg)`,
          transformOrigin: 'center center',
        }}
      />
    </AbsoluteFill>
  );
};

// ===== COMPOSITE FRAME =====
//
// Renderiza una escena compuesta de múltiples sub-paneles (split-screen / grid /
// pip). Cada panel viene como SubScenePanel{ panel, imageSrc, textOverlay? }
// con su imagen ya generada por el aligner.
//
// Por qué este componente existe: cuando una escena del ad original es un
// collage (típico TikTok: antes/después + diagrama + label de producto),
// pedirle a Imagen una sola imagen con ese collage entero resulta en paneles
// borrosos, texto gibberish, y composición caótica. La solución es generar
// CADA panel por separado (imagen limpia, enfocada) y juntarlos pixel-perfect
// acá en post-producción, con texto vectorial sobre cada panel.
//
// Border / gap: usamos un gap pequeño (8px) y border negro fino para imitar
// el estilo TikTok típico de ads que usan splits. Los paneles van sin motion
// individual (estaticos) porque ya tienen suficiente información visual y un
// pan/zoom haría perder el efecto de "comparación lado a lado".
const CompositeFrame: React.FC<{
  layout: CompositeLayout;
  panels: SubScenePanel[];
  durationInFrames: number;
  sceneIndex: number;
  animatedScenes: boolean;
}> = ({ layout, panels, durationInFrames, sceneIndex, animatedScenes }) => {
  const localFrame = useCurrentFrame();
  const FADE_FRAMES = animatedScenes ? 6 : 4;
  const fillOpacity = Math.min(1, localFrame / FADE_FRAMES);

  // Subtle global zoom para que no se vea estático. Más sutil que el SceneFrame
  // porque los paneles tienen alto contenido — un zoom agresivo distrae.
  const t = Math.min(1, Math.max(0, localFrame / Math.max(1, durationInFrames - 1)));
  const globalZoom = 1 + 0.02 * t;
  void sceneIndex;

  const panelStyleByPosition = (pos: string): React.CSSProperties => layoutPositionToRect(layout, pos);

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0a', opacity: fillOpacity }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${globalZoom})`,
          transformOrigin: 'center center',
        }}
      >
        {panels.map((panel, idx) => {
          const rect = panelStyleByPosition(panel.panel);
          return (
            <div
              key={`${panel.panel}-${idx}`}
              style={{
                position: 'absolute',
                ...rect,
                overflow: 'hidden',
                border: '2px solid #1a1a1a',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                backgroundColor: '#0a0a0a',
              }}
            >
              <Img
                src={staticFile(panel.imageSrc)}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
              {panel.textOverlay && (
                <PanelTextOverlay overlay={panel.textOverlay} />
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// Posición pixel-perfect de un panel dentro del frame 9:16 1080×1920.
// Las posiciones se expresan en porcentajes para que escalen con cualquier
// resolución de output. El gap entre paneles es de ~8px equivalente a ~0.4%
// del ancho — visualmente lo logramos con border + padding interno.
function layoutPositionToRect(layout: CompositeLayout, position: string): React.CSSProperties {
  // Helper: pequeño gap entre paneles, tipo TikTok grid.
  const GAP = '4px';
  switch (layout) {
    case 'grid-2x2': {
      // 2×2 igual tamaño, 50/50.
      const half = `calc(50% - ${GAP})`;
      switch (position) {
        case 'top-left':
          return { left: 0, top: 0, width: half, height: half };
        case 'top-right':
          return { right: 0, top: 0, width: half, height: half };
        case 'bottom-left':
          return { left: 0, bottom: 0, width: half, height: half };
        case 'bottom-right':
          return { right: 0, bottom: 0, width: half, height: half };
      }
      break;
    }
    case 'grid-2x2-with-bottom': {
      // 75% arriba (2×2) + 25% abajo (full width). 5 paneles típicos del ad
      // "antes/después/antes/después + nombre del producto al fondo".
      const lowerH = '25%';
      const halfW = `calc(50% - ${GAP})`;
      const cellH = `calc(37.5% - ${GAP})`; // 75% / 2
      switch (position) {
        case 'top-left':
          return { left: 0, top: 0, width: halfW, height: cellH };
        case 'top-right':
          return { right: 0, top: 0, width: halfW, height: cellH };
        case 'bottom-left':
          return { left: 0, top: `calc(37.5% + ${GAP})`, width: halfW, height: cellH };
        case 'bottom-right':
          return { right: 0, top: `calc(37.5% + ${GAP})`, width: halfW, height: cellH };
        case 'bottom-wide':
          return { left: 0, bottom: 0, width: '100%', height: lowerH };
      }
      break;
    }
    case 'grid-3x2': {
      // 3 filas × 2 columnas, 6 paneles iguales. Cada panel: 50% width × 33.33% height.
      // Típico del ad "6 mujeres testimoniales con antes/después + label de producto".
      const halfW = `calc(50% - ${GAP})`;
      const cellH = `calc(33.333% - ${GAP})`;
      switch (position) {
        case 'top-left':
          return { left: 0, top: 0, width: halfW, height: cellH };
        case 'top-right':
          return { right: 0, top: 0, width: halfW, height: cellH };
        case 'middle-left':
          return { left: 0, top: `calc(33.333% + ${GAP} / 2)`, width: halfW, height: cellH };
        case 'middle-right':
          return { right: 0, top: `calc(33.333% + ${GAP} / 2)`, width: halfW, height: cellH };
        case 'bottom-left':
          return { left: 0, bottom: 0, width: halfW, height: cellH };
        case 'bottom-right':
          return { right: 0, bottom: 0, width: halfW, height: cellH };
      }
      break;
    }
    case 'before-after': {
      // 2 paneles verticales: izq = antes, der = después. Cada uno 50%×100%.
      const halfW = `calc(50% - ${GAP})`;
      switch (position) {
        case 'left':
          return { left: 0, top: 0, width: halfW, height: '100%' };
        case 'right':
          return { right: 0, top: 0, width: halfW, height: '100%' };
      }
      break;
    }
    case 'side-by-side': {
      // 2 paneles horizontales: top, bottom. Cada uno 100%×50%.
      const halfH = `calc(50% - ${GAP})`;
      switch (position) {
        case 'top':
          return { left: 0, top: 0, width: '100%', height: halfH };
        case 'bottom':
          return { left: 0, bottom: 0, width: '100%', height: halfH };
      }
      break;
    }
    case 'pip': {
      // Picture-in-picture: 1 grande (100% × 100%) + 1 chico (28% × 28%)
      // en esquina inferior derecha con margen.
      switch (position) {
        case 'main':
          return { left: 0, top: 0, width: '100%', height: '100%' };
        case 'pip':
          return { right: '4%', bottom: '8%', width: '28%', height: '28%' };
      }
      break;
    }
    case 'single':
      return { left: 0, top: 0, width: '100%', height: '100%' };
  }
  // Fallback: ocupa todo el frame (mejor que dejarlo invisible).
  return { left: 0, top: 0, width: '100%', height: '100%' };
}

// Overlay de texto sobre un panel individual. A diferencia del TextOverlayLayer
// global (que se posiciona contra el frame entero 9:16), este se posiciona
// contra el rectángulo del panel, así un product-label en un panel pequeño se
// auto-ajusta al panel y no se sale.
const PanelTextOverlay: React.FC<{ overlay: TextOverlay }> = ({ overlay }) => {
  const scale = (overlay.scale ?? 1) * 0.55; // dentro de un panel chico, escalamos al 55%
  const color = overlay.color ?? '#FFE600';
  const position = overlay.position ?? defaultPositionForKind(overlay.kind);

  const baseJustify =
    position === 'top' || position === 'top-left' || position === 'top-right'
      ? 'flex-start'
      : position === 'bottom' || position === 'bottom-left' || position === 'bottom-right'
        ? 'flex-end'
        : 'center';
  const baseAlign =
    position === 'top-left' || position === 'bottom-left'
      ? 'flex-start'
      : position === 'top-right' || position === 'bottom-right'
        ? 'flex-end'
        : 'center';

  // Box style depende del kind. Reutilizamos los mismos estilos que el overlay
  // global, simplemente con scale reducido.
  const boxStyle: React.CSSProperties = (() => {
    switch (overlay.kind) {
      case 'product-label':
        return {
          backgroundColor: 'rgba(245, 242, 237, 0.96)',
          padding: `${Math.round(12 * scale)}px ${Math.round(32 * scale)}px`,
          borderRadius: '6px',
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          border: '2px solid #1a1a1a',
          color: '#1a1a1a',
          fontFamily: '"Playfair Display", Georgia, serif',
          fontSize: Math.round(56 * scale),
          fontWeight: 900,
          letterSpacing: '0.10em',
          textAlign: 'center',
        };
      case 'day-counter':
        return {
          backgroundColor: color,
          padding: `${Math.round(10 * scale)}px ${Math.round(22 * scale)}px`,
          borderRadius: '999px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          transform: 'rotate(-3deg)',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: Math.round(68 * scale),
          fontWeight: 900,
          color: '#1a1a1a',
          letterSpacing: '0.05em',
        };
      case 'metric-callout':
        return {
          backgroundColor: 'rgba(26, 26, 26, 0.92)',
          padding: `${Math.round(14 * scale)}px ${Math.round(32 * scale)}px`,
          borderRadius: '10px',
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: Math.round(82 * scale),
          fontWeight: 900,
          color: color,
          letterSpacing: '0.02em',
        };
      case 'subtitle-banner':
        return {
          backgroundColor: 'rgba(26, 26, 26, 0.85)',
          padding: `${Math.round(10 * scale)}px ${Math.round(22 * scale)}px`,
          borderRadius: '4px',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: Math.round(34 * scale),
          fontWeight: 700,
          color: '#FFFFFF',
          textAlign: 'center',
          maxWidth: '90%',
        };
    }
  })();

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: baseJustify,
        alignItems: baseAlign,
        padding: '6% 5%',
        pointerEvents: 'none',
      }}
    >
      <div style={boxStyle}>{overlay.text}</div>
    </div>
  );
};

// ===== FREEFORM COMPOSITE — MOTOR DE COMPOSICIÓN LIBRE =====
//
// Renderiza N elementos en posiciones ARBITRARIAS del frame 9:16. A diferencia
// de CompositeFrame (6 layouts rígidos predefinidos), acá cada pieza tiene
// coordenadas, tamaño, rotación, capa (zIndex) y timing propios — reproduce
// cualquier edición compleja: collage irregular, picture-in-picture, overlays
// en esquinas, piezas que entran y salen en distintos momentos.
//
// Es el motor compartido sobre el que renderizan:
//   - el modo AUTOMÁTICO (detector de geometría exacta — Fase 2)
//   - el EDITOR MANUAL (Fase 3)
const FreeformComposite: React.FC<{
  elements: CompositeElementVisual[];
  durationInFrames: number;
  animatedScenes: boolean;
}> = ({ elements, durationInFrames, animatedScenes }) => {
  const localFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const FADE_FRAMES = animatedScenes ? 6 : 4;
  const fillOpacity = Math.min(1, localFrame / FADE_FRAMES);

  // zIndex ascendente: el mayor se pinta último (queda al frente).
  const ordered = [...elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0a', opacity: fillOpacity }}>
      {ordered.map((el, idx) => {
        const key = el.id || `el-${idx}`;
        // Timing: si el elemento define start/end, lo envolvemos en una Sequence
        // relativa al inicio de la escena. Si no, dura toda la escena.
        const hasStart = typeof el.startSeconds === 'number';
        const hasEnd = typeof el.endSeconds === 'number';
        if (hasStart || hasEnd) {
          const fromFrame = hasStart ? Math.max(0, Math.round(el.startSeconds! * fps)) : 0;
          const seqDuration = hasEnd
            ? Math.max(1, Math.round((el.endSeconds! - (el.startSeconds ?? 0)) * fps))
            : Math.max(1, durationInFrames - fromFrame);
          return (
            <Sequence
              key={key}
              from={fromFrame}
              durationInFrames={seqDuration}
              name={key}
              layout="none"
            >
              <FreeformElement element={el} />
            </Sequence>
          );
        }
        return <FreeformElement key={key} element={el} />;
      })}
    </AbsoluteFill>
  );
};

// Un elemento individual de la composición libre, posicionado en coordenadas
// arbitrarias (% del frame) con rotación, opacidad, recorte y bordes propios.
const FreeformElement: React.FC<{ element: CompositeElementVisual }> = ({ element }) => {
  const localFrame = useCurrentFrame();
  const { height } = useVideoConfig();
  const FADE = 5;
  const enterOpacity = Math.min(1, localFrame / FADE);
  const { rect } = element;
  const fit = element.fit ?? 'cover';

  const boxStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${rect.xPct}%`,
    top: `${rect.yPct}%`,
    width: `${rect.widthPct}%`,
    height: `${rect.heightPct}%`,
    transform: `rotate(${element.rotationDeg ?? 0}deg)`,
    transformOrigin: 'center center',
    opacity: (element.opacity ?? 1) * enterOpacity,
    overflow: 'hidden',
    borderRadius: element.cornerRadiusPct ? `${element.cornerRadiusPct}%` : '0',
  };

  // fontSize del texto puro: relativo a la altura de la caja del elemento.
  const textFontSize = Math.max(12, Math.round((rect.heightPct / 100) * height * 0.22));

  return (
    <div style={boxStyle}>
      {element.kind === 'image' && element.imageSrc && (
        <Img
          src={staticFile(element.imageSrc)}
          style={{ width: '100%', height: '100%', objectFit: fit }}
        />
      )}
      {element.kind === 'video' && element.videoSrc && (
        <OffthreadVideo
          src={staticFile(element.videoSrc)}
          style={{ width: '100%', height: '100%', objectFit: fit }}
          muted
        />
      )}
      {element.kind === 'text' && (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontWeight: 800,
            fontSize: textFontSize,
            color: '#FFFFFF',
            textAlign: 'center',
            lineHeight: 1.1,
            padding: '4%',
          }}
        >
          {element.text ?? ''}
        </div>
      )}
      {element.textOverlay && <PanelTextOverlay overlay={element.textOverlay} />}
    </div>
  );
};

// Layer que renderiza las TextOverlays como capas vectoriales sobre la imagen.
// Resuelve el problema estructural de que Imagen 4 no genera texto coherente:
// la imagen base se genera SIN texto, y este componente sobrepone el texto
// con formato perfecto controlado por nosotros.
const TextOverlayLayer: React.FC<{
  overlays: TextOverlay[];
  durationInFrames: number;
}> = ({ overlays, durationInFrames }) => {
  const localFrame = useCurrentFrame();
  // Fade-in suave para el texto: aparece a partir del frame 6 y se estabiliza en frame 18.
  // Esto crea un efecto "el texto aparece" sutil después de que la imagen entra.
  const opacity = interpolate(localFrame, [6, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  void durationInFrames; // reservado para animaciones de salida en futuro

  return (
    <>
      {overlays.map((o, idx) => (
        <OverlayItem key={`${o.kind}-${idx}`} overlay={o} opacity={opacity} />
      ))}
    </>
  );
};

const OverlayItem: React.FC<{ overlay: TextOverlay; opacity: number }> = ({ overlay, opacity }) => {
  const style = getOverlayStyle(overlay);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', opacity }}>
      <div style={style.container}>
        {overlay.kind === 'product-label' && (
          <div style={style.productLabel as React.CSSProperties}>
            <div style={style.productLabelText as React.CSSProperties}>{overlay.text}</div>
          </div>
        )}
        {overlay.kind === 'day-counter' && (
          <div style={style.dayCounter as React.CSSProperties}>
            <div style={style.dayCounterText as React.CSSProperties}>{overlay.text}</div>
          </div>
        )}
        {overlay.kind === 'metric-callout' && (
          <div style={style.metricCallout as React.CSSProperties}>
            <div style={style.metricCalloutText as React.CSSProperties}>{overlay.text}</div>
          </div>
        )}
        {overlay.kind === 'subtitle-banner' && (
          <div style={style.subtitleBanner as React.CSSProperties}>
            <div style={style.subtitleBannerText as React.CSSProperties}>{overlay.text}</div>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

function getOverlayStyle(overlay: TextOverlay): {
  container: React.CSSProperties;
  productLabel?: React.CSSProperties;
  productLabelText?: React.CSSProperties;
  dayCounter?: React.CSSProperties;
  dayCounterText?: React.CSSProperties;
  metricCallout?: React.CSSProperties;
  metricCalloutText?: React.CSSProperties;
  subtitleBanner?: React.CSSProperties;
  subtitleBannerText?: React.CSSProperties;
} {
  const scale = overlay.scale ?? 1;
  const color = overlay.color ?? '#FFE600'; // Vitaly yellow por defecto
  const position = overlay.position ?? defaultPositionForKind(overlay.kind);

  const containerJustify: React.CSSProperties = (() => {
    const baseJustify =
      position === 'top' || position === 'top-left' || position === 'top-right'
        ? 'flex-start'
        : position === 'bottom' || position === 'bottom-left' || position === 'bottom-right'
          ? 'flex-end'
          : 'center';
    const baseAlign =
      position === 'top-left' || position === 'bottom-left'
        ? 'flex-start'
        : position === 'top-right' || position === 'bottom-right'
          ? 'flex-end'
          : 'center';
    return {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: baseJustify,
      alignItems: baseAlign,
      width: '100%',
      height: '100%',
      padding: '8% 6%',
    };
  })();

  return {
    container: containerJustify,
    productLabel: {
      backgroundColor: 'rgba(245, 242, 237, 0.96)', // brand cream
      padding: `${Math.round(18 * scale)}px ${Math.round(48 * scale)}px`,
      borderRadius: '6px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      border: '2px solid #1a1a1a',
    } as React.CSSProperties,
    productLabelText: {
      fontFamily: '"Playfair Display", Georgia, serif',
      fontSize: Math.round(96 * scale),
      fontWeight: 900,
      letterSpacing: '0.12em',
      color: '#1a1a1a',
      lineHeight: 1,
      textAlign: 'center' as const,
    } as React.CSSProperties,
    dayCounter: {
      backgroundColor: color,
      padding: `${Math.round(20 * scale)}px ${Math.round(40 * scale)}px`,
      borderRadius: '999px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
      transform: 'rotate(-3deg)',
    } as React.CSSProperties,
    dayCounterText: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: Math.round(120 * scale),
      fontWeight: 900,
      color: '#1a1a1a',
      letterSpacing: '0.05em',
      lineHeight: 1,
    } as React.CSSProperties,
    metricCallout: {
      backgroundColor: 'rgba(26, 26, 26, 0.92)',
      padding: `${Math.round(24 * scale)}px ${Math.round(56 * scale)}px`,
      borderRadius: '12px',
      boxShadow: '0 10px 28px rgba(0,0,0,0.35)',
    } as React.CSSProperties,
    metricCalloutText: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: Math.round(140 * scale),
      fontWeight: 900,
      color: color,
      letterSpacing: '0.02em',
      lineHeight: 1,
    } as React.CSSProperties,
    subtitleBanner: {
      backgroundColor: 'rgba(26, 26, 26, 0.85)',
      padding: `${Math.round(18 * scale)}px ${Math.round(36 * scale)}px`,
      borderRadius: '4px',
      maxWidth: '90%',
    } as React.CSSProperties,
    subtitleBannerText: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: Math.round(56 * scale),
      fontWeight: 700,
      color: '#FFFFFF',
      textAlign: 'center' as const,
      lineHeight: 1.2,
    } as React.CSSProperties,
  };
}

function defaultPositionForKind(kind: TextOverlay['kind']): NonNullable<TextOverlay['position']> {
  switch (kind) {
    case 'product-label':
      return 'center'; // suele ir delante/encima del producto
    case 'day-counter':
      return 'top-right';
    case 'metric-callout':
      return 'center';
    case 'subtitle-banner':
      return 'top';
  }
}

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
