function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function sampleCornerBackground(data, width, height, sampleSize = 8) {
  const samples = [];

  const corners = [
    [0, 0],
    [width - sampleSize, 0],
    [0, height - sampleSize],
    [width - sampleSize, height - sampleSize],
  ];

  for (const [startX, startY] of corners) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let y = startY; y < startY + sampleSize; y++) {
      for (let x = startX; x < startX + sampleSize; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }

    if (count > 0) {
      samples.push({ r: r / count, g: g / count, b: b / count });
    }
  }

  return {
    r: samples.reduce((sum, s) => sum + s.r, 0) / samples.length,
    g: samples.reduce((sum, s) => sum + s.g, 0) / samples.length,
    b: samples.reduce((sum, s) => sum + s.b, 0) / samples.length,
  };
}

function scanEdgeContent(data, width, height, bg, threshold, edge) {
  const isContent = (x, y) => {
    const i = (y * width + x) * 4;
    return colorDistance(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b) > threshold;
  };

  const rowContentRatio = (y) => {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) count++;
    }
    return count / width;
  };

  const colContentRatio = (x) => {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (isContent(x, y)) count++;
    }
    return count / height;
  };

  const minRatio = 0.04;

  if (edge === 'top') {
    for (let y = 0; y < height; y++) {
      if (rowContentRatio(y) > minRatio) return y;
    }
    return 0;
  }

  if (edge === 'bottom') {
    for (let y = height - 1; y >= 0; y--) {
      if (rowContentRatio(y) > minRatio) return y;
    }
    return height - 1;
  }

  if (edge === 'left') {
    for (let x = 0; x < width; x++) {
      if (colContentRatio(x) > minRatio) return x;
    }
    return 0;
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colContentRatio(x) > minRatio) return x;
  }
  return width - 1;
}

export async function detectDocumentCrop(dataUrl) {
  const img = await loadImage(dataUrl);
  const maxSize = 900;
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const bg = sampleCornerBackground(data, width, height);
  const threshold = 32;

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let contentPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (colorDistance(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b) > threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        contentPixels++;
      }
    }
  }

  const scanMinX = scanEdgeContent(data, width, height, bg, threshold, 'left');
  const scanMaxX = scanEdgeContent(data, width, height, bg, threshold, 'right');
  const scanMinY = scanEdgeContent(data, width, height, bg, threshold, 'top');
  const scanMaxY = scanEdgeContent(data, width, height, bg, threshold, 'bottom');

  minX = Math.min(minX, scanMinX);
  minY = Math.min(minY, scanMinY);
  maxX = Math.max(maxX, scanMaxX);
  maxY = Math.max(maxY, scanMaxY);

  if (contentPixels === 0 || maxX <= minX || maxY <= minY) {
    return null;
  }

  const padX = Math.round(width * 0.012);
  const padY = Math.round(height * 0.012);
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(width - 1, maxX + padX);
  maxY = Math.min(height - 1, maxY + padY);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropArea = cropW * cropH;
  const totalArea = width * height;
  const areaRatio = cropArea / totalArea;

  if (areaRatio > 0.97) return null;
  if (areaRatio < 0.12) return null;
  if (contentPixels / totalArea < 0.03) return null;

  return {
    x: Math.round(minX / scale),
    y: Math.round(minY / scale),
    width: Math.round(cropW / scale),
    height: Math.round(cropH / scale),
  };
}

export function fullCropRect(imgWidth, imgHeight) {
  return { x: 0, y: 0, width: imgWidth, height: imgHeight };
}

export async function getImageDimensions(dataUrl) {
  const img = await loadImage(dataUrl);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

export async function cropImage(dataUrl, cropRect) {
  const img = await loadImage(dataUrl);
  const { x, y, width, height } = clampCropRect(cropRect, img.naturalWidth, img.naturalHeight);

  if (width < 2 || height < 2) {
    return dataUrl;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);

  return canvasToDataUrl(canvas, dataUrl);
}

export function clampCropRect(rect, imgWidth, imgHeight) {
  const minSize = 20;
  let { x, y, width, height } = rect;

  width = Math.max(minSize, Math.min(width, imgWidth));
  height = Math.max(minSize, Math.min(height, imgHeight));
  x = Math.max(0, Math.min(x, imgWidth - width));
  y = Math.max(0, Math.min(y, imgHeight - height));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function canvasToDataUrl(canvas, sourceDataUrl) {
  const type = sourceDataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const quality = type === 'image/jpeg' ? 0.92 : undefined;
  return canvas.toDataURL(type, quality);
}

export async function applyEnhanceFilter(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  const contrast = 1.45;
  const brightness = 12;
  const whiteThreshold = 175;
  const blackThreshold = 95;

  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i];
    const srcG = data[i + 1];
    const srcB = data[i + 2];

    let r = srcR * 0.88 + srcG * 0.06 + srcB * 0.06;
    let g = srcR * 0.06 + srcG * 0.88 + srcB * 0.06;
    let b = srcR * 0.06 + srcG * 0.06 + srcB * 0.88;

    r = (r - 128) * contrast + 128 + brightness;
    g = (g - 128) * contrast + 128 + brightness;
    b = (b - 128) * contrast + 128 + brightness;

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (lum >= whiteThreshold) {
      r = 255;
      g = 255;
      b = 255;
    } else if (lum <= blackThreshold) {
      r = Math.max(0, r * 0.55);
      g = Math.max(0, g * 0.55);
      b = Math.max(0, b * 0.55);
    } else {
      const t = (lum - blackThreshold) / (whiteThreshold - blackThreshold);
      const boost = 1 + t * 0.15;
      r = Math.min(255, r * boost);
      g = Math.min(255, g * boost);
      b = Math.min(255, b * boost);
    }

    data[i] = clampByte(r);
    data[i + 1] = clampByte(g);
    data[i + 2] = clampByte(b);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvasToDataUrl(canvas, dataUrl);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export async function buildProcessedImage(originalDataUrl, cropRect, enhanceEnabled) {
  const dims = await getImageDimensions(originalDataUrl);
  const rect = cropRect ?? fullCropRect(dims.width, dims.height);
  const baseDataUrl = await cropImage(originalDataUrl, rect);
  const dataUrl = enhanceEnabled ? await applyEnhanceFilter(baseDataUrl) : baseDataUrl;

  return { baseDataUrl, dataUrl, cropRect: rect };
}

export async function processUploadedImage(file, originalDataUrl) {
  const dims = await getImageDimensions(originalDataUrl);
  let cropRect = fullCropRect(dims.width, dims.height);
  let autoCropApplied = false;

  try {
    const detected = await detectDocumentCrop(originalDataUrl);
    if (detected) {
      cropRect = detected;
      autoCropApplied = true;
    }
  } catch {
    // Keep original if detection fails
  }

  const { dataUrl } = await buildProcessedImage(originalDataUrl, cropRect, false);

  return {
    originalDataUrl,
    cropRect,
    enhanceEnabled: false,
    autoCropApplied,
    dataUrl,
  };
}
