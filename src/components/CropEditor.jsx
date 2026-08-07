import { useCallback, useEffect, useRef, useState } from 'react';
import { clampCropRect } from '../utils/imageProcessing';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

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

export default function CropEditor({ imageSrc, imageWidth, imageHeight, cropRect, onCropChange }) {
  const containerRef = useRef(null);
  const [displayScale, setDisplayScale] = useState(1);
  const dragRef = useRef(null);

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

  const toDisplay = (rect) => ({
    x: rect.x * displayScale,
    y: rect.y * displayScale,
    width: rect.width * displayScale,
    height: rect.height * displayScale,
  });

  const toImageCoords = (displayRect) =>
    clampCropRect(
      {
        x: displayRect.x / displayScale,
        y: displayRect.y / displayScale,
        width: displayRect.width / displayScale,
        height: displayRect.height / displayScale,
      },
      imageWidth,
      imageHeight,
    );

  const startDrag = (mode, handle, clientX, clientY) => {
    const display = toDisplay(cropRect);
    dragRef.current = {
      mode,
      handle,
      startX: clientX,
      startY: clientY,
      startRect: display,
    };
  };

  const onPointerMove = useCallback(
    (clientX, clientY) => {
      const drag = dragRef.current;
      if (!drag) return;

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

      onCropChange(toImageCoords({ x, y, width, height }));
    },
    [cropRect, displayScale, imageHeight, imageWidth, onCropChange],
  );

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const point = e.touches ? e.touches[0] : e;
      onPointerMove(point.clientX, point.clientY);
    };

    const handleUp = () => {
      dragRef.current = null;
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
  }, [onPointerMove]);

  const display = toDisplay(cropRect);
  const frameW = imageWidth * displayScale;
  const frameH = imageHeight * displayScale;

  return (
    <div className="crop-editor" ref={containerRef}>
      <div className="crop-editor__frame" style={{ width: frameW, height: frameH }}>
        <img
          className="crop-editor__image"
          src={imageSrc}
          alt="Crop preview"
          draggable={false}
          style={{ width: frameW, height: frameH }}
        />
        <div className="crop-editor__overlay">
          <div
            className="crop-editor__box"
            style={{
              left: display.x,
              top: display.y,
              width: display.width,
              height: display.height,
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              startDrag('move', null, e.clientX, e.clientY);
            }}
            onTouchStart={(e) => {
              const t = e.touches[0];
              startDrag('move', null, t.clientX, t.clientY);
            }}
          >
            {HANDLES.map((handle) => (
              <div
                key={handle}
                className={`crop-editor__handle crop-editor__handle--${handle}`}
                style={{ cursor: getHandleCursor(handle) }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  startDrag('resize', handle, e.clientX, e.clientY);
                }}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  const t = e.touches[0];
                  startDrag('resize', handle, t.clientX, t.clientY);
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
