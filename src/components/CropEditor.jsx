import { useCallback, useEffect, useRef, useState } from 'react';
import { clampCropRect } from '../utils/imageProcessing';

const RECT_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CORNER_NAMES = [
  'Kiri Atas',
  'Kanan Atas',
  'Kanan Bawah',
  'Kiri Bawah',
];

function getHandleCursor(handle) {
  const map = {
    nw: 'nwse-resize',
    se: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
  };
  return map[handle] || 'move';
}

function getMidpoint(p1, p2) {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

export default function CropEditor({
  imageSrc,
  imageWidth,
  imageHeight,
  cropType = 'perspective', // 'perspective' (4 sudut) | 'box' (kotak)
  onCropTypeChange,
  corners, // [{x, y}, {x, y}, {x, y}, {x, y}]
  onCornersChange,
  cropRect, // {x, y, width, height}
  onCropChange,
}) {
  const containerRef = useRef(null);
  const frameRef = useRef(null);
  const imageRef = useRef(null);
  const loupeCanvasRef = useRef(null);

  const [displayScale, setDisplayScale] = useState(1);
  const [activeDrag, setActiveDrag] = useState(null); // { type, index }
  const [loupePoint, setLoupePoint] = useState(null); // { x, y, name }

  const dragRef = useRef(null);

  // Hitung skala tampilan sesuai ruang container
  const updateScale = useCallback(() => {
    const container = containerRef.current;
    if (!container || !imageWidth || !imageHeight) return;

    const maxW = container.clientWidth;
    const maxH = container.clientHeight;
    const scale = Math.min(maxW / imageWidth, maxH / imageHeight, 1);
    setDisplayScale(scale);
  }, [imageWidth, imageHeight]);

  useEffect(() => {
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [updateScale]);

  // Gambar kaca pembesar (loupe) saat titik sedang digeser
  const drawLoupe = useCallback(
    (pt) => {
      const canvas = loupeCanvasRef.current;
      const img = imageRef.current;
      if (!canvas || !img || !pt) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const size = 120;
      const zoom = 2.4;
      const srcSize = size / zoom;

      ctx.clearRect(0, 0, size, size);
      ctx.save();

      // Masking lingkaran
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();

      // Cuplikan gambar zoom
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        pt.x - srcSize / 2,
        pt.y - srcSize / 2,
        srcSize,
        srcSize,
        0,
        0,
        size,
        size,
      );

      // Garis bidik (Crosshair)
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(size / 2, 0);
      ctx.lineTo(size / 2, size / 2 - 6);
      ctx.moveTo(size / 2, size / 2 + 6);
      ctx.lineTo(size / 2, size);

      ctx.moveTo(0, size / 2);
      ctx.lineTo(size / 2 - 6, size / 2);
      ctx.moveTo(size / 2 + 6, size / 2);
      ctx.lineTo(size, size / 2);
      ctx.stroke();

      // Titik bidik tengah
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 4, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    },
    [],
  );

  useEffect(() => {
    if (loupePoint) {
      drawLoupe(loupePoint);
    }
  }, [loupePoint, drawLoupe]);

  // ── Dragging Logic: 4 Sudut Bebas (Perspective) ──
  const startDragCorner = (index, e) => {
    e.preventDefault();
    e.stopPropagation();

    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    dragRef.current = {
      type: 'corner',
      index,
      startX: clientX,
      startY: clientY,
      startCorners: corners ? [...corners] : [],
    };
    setActiveDrag({ type: 'corner', index });

    if (corners && corners[index]) {
      setLoupePoint({ ...corners[index], name: CORNER_NAMES[index] });
    }
  };

  const startDragEdge = (index, e) => {
    e.preventDefault();
    e.stopPropagation();

    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    dragRef.current = {
      type: 'edge',
      index,
      startX: clientX,
      startY: clientY,
      startCorners: corners ? [...corners] : [],
    };
    setActiveDrag({ type: 'edge', index });
  };

  const startDragBody = (e) => {
    e.preventDefault();

    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    dragRef.current = {
      type: 'body',
      startX: clientX,
      startY: clientY,
      startCorners: corners ? [...corners] : [],
    };
    setActiveDrag({ type: 'body' });
  };

  // ── Dragging Logic: Kotak Standar (Box Crop) ──
  const startDragBox = (mode, handle, clientX, clientY) => {
    if (!cropRect) return;
    const display = {
      x: cropRect.x * displayScale,
      y: cropRect.y * displayScale,
      width: cropRect.width * displayScale,
      height: cropRect.height * displayScale,
    };
    dragRef.current = {
      type: 'box',
      mode,
      handle,
      startX: clientX,
      startY: clientY,
      startRect: display,
    };
  };

  // Pointer move handler umum
  const handlePointerMove = useCallback(
    (clientX, clientY) => {
      const drag = dragRef.current;
      if (!drag) return;

      const frame = frameRef.current;
      if (!frame) return;

      // ── MODE PERSPECTIVE: 4 SUDUT ──
      if (drag.type === 'corner') {
        const rect = frame.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;

        const imgX = Math.max(0, Math.min(imageWidth, Math.round(localX / displayScale)));
        const imgY = Math.max(0, Math.min(imageHeight, Math.round(localY / displayScale)));

        const next = [...(corners || drag.startCorners)];
        next[drag.index] = { x: imgX, y: imgY };
        onCornersChange?.(next);
        setLoupePoint({ x: imgX, y: imgY, name: CORNER_NAMES[drag.index] });
        return;
      }

      if (drag.type === 'edge') {
        const dx = (clientX - drag.startX) / displayScale;
        const dy = (clientY - drag.startY) / displayScale;

        // Edge 0: 0-1 (Atas), Edge 1: 1-2 (Kanan), Edge 2: 3-2 (Bawah), Edge 3: 0-3 (Kiri)
        const edgePairs = [
          [0, 1],
          [1, 2],
          [3, 2],
          [0, 3],
        ];
        const [idxA, idxB] = edgePairs[drag.index] || [0, 1];

        const next = [...drag.startCorners];
        const movePt = (pt) => ({
          x: Math.max(0, Math.min(imageWidth, Math.round(pt.x + dx))),
          y: Math.max(0, Math.min(imageHeight, Math.round(pt.y + dy))),
        });

        next[idxA] = movePt(drag.startCorners[idxA]);
        next[idxB] = movePt(drag.startCorners[idxB]);
        onCornersChange?.(next);
        return;
      }

      if (drag.type === 'body') {
        const dx = (clientX - drag.startX) / displayScale;
        const dy = (clientY - drag.startY) / displayScale;

        let minX = 0;
        let maxX = imageWidth;
        let minY = 0;
        let maxY = imageHeight;

        drag.startCorners.forEach((pt) => {
          minX = Math.min(minX, pt.x);
          maxX = Math.max(maxX, pt.x);
          minY = Math.min(minY, pt.y);
          maxY = Math.max(maxY, pt.y);
        });

        const clampedDx = Math.max(-minX, Math.min(imageWidth - maxX, dx));
        const clampedDy = Math.max(-minY, Math.min(imageHeight - maxY, dy));

        const next = drag.startCorners.map((pt) => ({
          x: Math.round(pt.x + clampedDx),
          y: Math.round(pt.y + clampedDy),
        }));
        onCornersChange?.(next);
        return;
      }

      // ── MODE KOTAK BIASA (BOX CROP) ──
      if (drag.type === 'box') {
        const dx = clientX - drag.startX;
        const dy = clientY - drag.startY;
        let { x, y, width, height } = drag.startRect;

        if (drag.mode === 'move') {
          x += dx;
          y += dy;
          const maxX = imageWidth * displayScale - width;
          const maxY = imageHeight * displayScale - height;
          x = Math.max(0, Math.min(x, maxX));
          y = Math.max(0, Math.min(y, maxY));
        } else {
          const minSize = 40 * displayScale;
          const handle = drag.handle;

          if (handle.includes('w')) {
            x += dx;
            width -= dx;
          }
          if (handle.includes('e')) {
            width += dx;
          }
          if (handle.includes('n')) {
            y += dy;
            height -= dy;
          }
          if (handle.includes('s')) {
            height += dy;
          }

          if (width < minSize) {
            if (handle.includes('w')) x -= minSize - width;
            width = minSize;
          }
          if (height < minSize) {
            if (handle.includes('n')) y -= minSize - height;
            height = minSize;
          }

          x = Math.max(0, x);
          y = Math.max(0, y);
          if (x + width > imageWidth * displayScale) width = imageWidth * displayScale - x;
          if (y + height > imageHeight * displayScale) height = imageHeight * displayScale - y;
        }

        const clamped = clampCropRect(
          {
            x: x / displayScale,
            y: y / displayScale,
            width: width / displayScale,
            height: height / displayScale,
          },
          imageWidth,
          imageHeight,
        );
        onCropChange?.(clamped);
      }
    },
    [corners, displayScale, imageHeight, imageWidth, onCornersChange, onCropChange],
  );

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const point = e.touches ? e.touches[0] : e;
      handlePointerMove(point.clientX, point.clientY);
    };

    const handleUp = () => {
      dragRef.current = null;
      setActiveDrag(null);
      setLoupePoint(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };
  }, [handlePointerMove]);

  const frameW = Math.max(1, Math.round(imageWidth * displayScale));
  const frameH = Math.max(1, Math.round(imageHeight * displayScale));

  // Konversi koordinat sudut ke display
  const displayCorners = (
    corners || [
      { x: 0, y: 0 },
      { x: imageWidth, y: 0 },
      { x: imageWidth, y: imageHeight },
      { x: 0, y: imageHeight },
    ]
  ).map((pt) => ({
    x: pt.x * displayScale,
    y: pt.y * displayScale,
  }));

  // Titik tengah setiap sisi
  const midTop = getMidpoint(displayCorners[0], displayCorners[1]);
  const midRight = getMidpoint(displayCorners[1], displayCorners[2]);
  const midBottom = getMidpoint(displayCorners[3], displayCorners[2]);
  const midLeft = getMidpoint(displayCorners[0], displayCorners[3]);
  const edgeMidpoints = [midTop, midRight, midBottom, midLeft];

  // Path SVG untuk masking gelap di luar 4 sudut (evenodd fill rule)
  const c = displayCorners;
  const maskPath = `M 0 0 L ${frameW} 0 L ${frameW} ${frameH} L 0 ${frameH} Z M ${c[0].x} ${c[0].y} L ${c[3].x} ${c[3].y} L ${c[2].x} ${c[2].y} L ${c[1].x} ${c[1].y} Z`;
  const polyPoints = `${c[0].x},${c[0].y} ${c[1].x},${c[1].y} ${c[2].x},${c[2].y} ${c[3].x},${c[3].y}`;

  // Grid garis bantu 3x3
  const gridLine1Top = {
    x: c[0].x + (c[1].x - c[0].x) / 3,
    y: c[0].y + (c[1].y - c[0].y) / 3,
  };
  const gridLine1Bottom = {
    x: c[3].x + (c[2].x - c[3].x) / 3,
    y: c[3].y + (c[2].y - c[3].y) / 3,
  };
  const gridLine2Top = {
    x: c[0].x + ((c[1].x - c[0].x) * 2) / 3,
    y: c[0].y + ((c[1].y - c[0].y) * 2) / 3,
  };
  const gridLine2Bottom = {
    x: c[3].x + ((c[2].x - c[3].x) * 2) / 3,
    y: c[3].y + ((c[2].y - c[3].y) * 2) / 3,
  };

  const gridLine1Left = {
    x: c[0].x + (c[3].x - c[0].x) / 3,
    y: c[0].y + (c[3].y - c[0].y) / 3,
  };
  const gridLine1Right = {
    x: c[1].x + (c[2].x - c[1].x) / 3,
    y: c[1].y + (c[2].y - c[1].y) / 3,
  };
  const gridLine2Left = {
    x: c[0].x + ((c[3].x - c[0].x) * 2) / 3,
    y: c[0].y + ((c[3].y - c[0].y) * 2) / 3,
  };
  const gridLine2Right = {
    x: c[1].x + ((c[2].x - c[1].x) * 2) / 3,
    y: c[1].y + ((c[2].y - c[1].y) * 2) / 3,
  };

  // Posisi floating loupe
  let loupeStyle = null;
  if (loupePoint) {
    const dispX = loupePoint.x * displayScale;
    const dispY = loupePoint.y * displayScale;
    const topOffset = dispY > 95 ? dispY - 85 : dispY + 85;
    const leftOffset = Math.max(65, Math.min(frameW - 65, dispX));
    loupeStyle = {
      left: `${leftOffset}px`,
      top: `${topOffset}px`,
    };
  }

  // Display untuk kotak biasa
  const boxDisplay = cropRect
    ? {
        x: cropRect.x * displayScale,
        y: cropRect.y * displayScale,
        width: cropRect.width * displayScale,
        height: cropRect.height * displayScale,
      }
    : { x: 0, y: 0, width: frameW, height: frameH };

  return (
    <div className="crop-editor-wrapper">
      {onCropTypeChange && (
        <div className="crop-mode-switch" role="tablist" aria-label="Mode Pemotongan">
          <button
            type="button"
            role="tab"
            aria-selected={cropType === 'perspective'}
            className={`crop-mode-btn ${cropType === 'perspective' ? 'crop-mode-btn--active' : ''}`}
            onClick={() => onCropTypeChange('perspective')}
          >
            📐 4 Sudut Bebas (Luruskan)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={cropType === 'box'}
            className={`crop-mode-btn ${cropType === 'box' ? 'crop-mode-btn--active' : ''}`}
            onClick={() => onCropTypeChange('box')}
          >
            🔲 Kotak Standar (Potong Tepi)
          </button>
        </div>
      )}

      <div className="crop-editor" ref={containerRef}>
        <div
          className="crop-editor__frame"
          ref={frameRef}
          style={{ width: frameW, height: frameH }}
        >
          <img
            ref={imageRef}
            className="crop-editor__image"
            src={imageSrc}
            alt="Crop preview"
            draggable={false}
            style={{ width: frameW, height: frameH }}
          />

          {cropType === 'perspective' ? (
            /* ── PERSPECTIVE (4 SUDUT BEBAS) OVERLAY ── */
            <svg
              className="crop-editor__svg"
              width={frameW}
              height={frameH}
              viewBox={`0 0 ${frameW} ${frameH}`}
            >
              <defs>
                <filter id="handleShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.45" />
                </filter>
              </defs>

              {/* Area gelap di luar dokumen */}
              <path d={maskPath} fill="rgba(15, 23, 42, 0.52)" fillRule="evenodd" />

              {/* Area dalam dokumen (bisa digeser seluruhnya) */}
              <polygon
                points={polyPoints}
                fill="rgba(59, 130, 246, 0.08)"
                stroke="#3b82f6"
                strokeWidth="2.5"
                style={{ cursor: activeDrag?.type === 'body' ? 'grabbing' : 'move' }}
                onMouseDown={startDragBody}
                onTouchStart={startDragBody}
              />

              {/* Garis bantu grid perspektif */}
              <g stroke="rgba(255, 255, 255, 0.45)" strokeWidth="1" strokeDasharray="3 3">
                <line
                  x1={gridLine1Top.x}
                  y1={gridLine1Top.y}
                  x2={gridLine1Bottom.x}
                  y2={gridLine1Bottom.y}
                />
                <line
                  x1={gridLine2Top.x}
                  y1={gridLine2Top.y}
                  x2={gridLine2Bottom.x}
                  y2={gridLine2Bottom.y}
                />
                <line
                  x1={gridLine1Left.x}
                  y1={gridLine1Left.y}
                  x2={gridLine1Right.x}
                  y2={gridLine1Right.y}
                />
                <line
                  x1={gridLine2Left.x}
                  y1={gridLine2Left.y}
                  x2={gridLine2Right.x}
                  y2={gridLine2Right.y}
                />
              </g>

              {/* 4 Titik Tengah Sisi (Edge Midpoints) untuk menggeser garis sisi */}
              {edgeMidpoints.map((mid, idx) => (
                <g
                  key={`edge-${idx}`}
                  className="crop-handle-edge"
                  onMouseDown={(e) => startDragEdge(idx, e)}
                  onTouchStart={(e) => startDragEdge(idx, e)}
                >
                  <circle cx={mid.x} cy={mid.y} r={18} fill="transparent" />
                  <circle
                    cx={mid.x}
                    cy={mid.y}
                    r={7}
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth="2.5"
                    filter="url(#handleShadow)"
                  />
                  <circle cx={mid.x} cy={mid.y} r={2.5} fill="#2563eb" />
                </g>
              ))}

              {/* 4 Titik Sudut Utama (Corner Handles) */}
              {displayCorners.map((pt, idx) => {
                const isActive = activeDrag?.type === 'corner' && activeDrag.index === idx;
                return (
                  <g
                    key={`corner-${idx}`}
                    className={`crop-handle-corner ${isActive ? 'crop-handle-corner--active' : ''}`}
                    onMouseDown={(e) => startDragCorner(idx, e)}
                    onTouchStart={(e) => startDragCorner(idx, e)}
                  >
                    {/* Area sentuh besar agar mudah di-tap di HP */}
                    <circle cx={pt.x} cy={pt.y} r={26} fill="transparent" />
                    {/* Lingkaran luar putih berbayang */}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={isActive ? 16 : 14}
                      fill="#ffffff"
                      filter="url(#handleShadow)"
                    />
                    {/* Lingkaran warna biru */}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={isActive ? 12 : 10.5}
                      fill="#2563eb"
                      stroke="#ffffff"
                      strokeWidth="1.5"
                    />
                    {/* Titik putih kecil di tengah */}
                    <circle cx={pt.x} cy={pt.y} r={3.5} fill="#ffffff" />
                  </g>
                );
              })}
            </svg>
          ) : (
            /* ── BOX CROP (KOTAK BIASA) OVERLAY ── */
            <div className="crop-editor__overlay">
              <div
                className="crop-editor__box"
                style={{
                  left: boxDisplay.x,
                  top: boxDisplay.y,
                  width: boxDisplay.width,
                  height: boxDisplay.height,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  startDragBox('move', null, e.clientX, e.clientY);
                }}
                onTouchStart={(e) => {
                  const t = e.touches[0];
                  startDragBox('move', null, t.clientX, t.clientY);
                }}
              >
                {RECT_HANDLES.map((handle) => (
                  <div
                    key={handle}
                    className={`crop-editor__handle crop-editor__handle--${handle}`}
                    style={{ cursor: getHandleCursor(handle) }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startDragBox('resize', handle, e.clientX, e.clientY);
                    }}
                    onTouchStart={(e) => {
                      e.stopPropagation();
                      const t = e.touches[0];
                      startDragBox('resize', handle, t.clientX, t.clientY);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Kaca Pembesar (Magnifier Loupe) saat menggeser titik sudut */}
          {cropType === 'perspective' && loupePoint && loupeStyle && (
            <div className="perspective-loupe" style={loupeStyle}>
              <canvas ref={loupeCanvasRef} width={120} height={120} />
              {loupePoint.name && (
                <span className="perspective-loupe__badge">{loupePoint.name}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
