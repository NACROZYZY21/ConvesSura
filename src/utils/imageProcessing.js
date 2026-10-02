import {
  collectCornerCandidates,
  detectCornersFromAnalysis,
  outsetCorners,
} from './documentScan.js';
import { tryOpenCvDocumentWarp } from './opencvDocumentScan.js';
import {
  hasGeminiApiKey,
  detectDocumentCornersWithGemini,
} from './geminiVision.js';

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function getLuminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function sampleCornerBackground(data, width, height, sampleSize = 10) {
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

function buildAnalysisCanvas(img, maxSize = 900) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = getLuminance(data[i], data[i + 1], data[i + 2]);
  }

  return { data, gray, width, height, scale };
}

function scanEdgeByGray(gray, width, height, bgLum, threshold, edge) {
  const isContent = (x, y) => Math.abs(gray[y * width + x] - bgLum) > threshold;

  const rowRatio = (y) => {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (isContent(x, y)) count++;
    }
    return count / width;
  };

  const colRatio = (x) => {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (isContent(x, y)) count++;
    }
    return count / height;
  };

  const minRatio = 0.035;

  if (edge === 'top') {
    for (let y = 0; y < height; y++) {
      if (rowRatio(y) > minRatio) return y;
    }
    return 0;
  }

  if (edge === 'bottom') {
    for (let y = height - 1; y >= 0; y--) {
      if (rowRatio(y) > minRatio) return y;
    }
    return height - 1;
  }

  if (edge === 'left') {
    for (let x = 0; x < width; x++) {
      if (colRatio(x) > minRatio) return x;
    }
    return 0;
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colRatio(x) > minRatio) return x;
  }
  return width - 1;
}

function computeBoundingBox(data, gray, width, height, bg, threshold) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let contentPixels = 0;
  const bgLum = getLuminance(bg.r, bg.g, bg.b);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const colorDiff = colorDistance(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b);
      const lumDiff = Math.abs(gray[y * width + x] - bgLum);

      if (colorDiff > threshold || lumDiff > threshold * 0.85) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        contentPixels++;
      }
    }
  }

  return {
    minX: Math.min(minX, scanEdgeByGray(gray, width, height, bgLum, threshold, 'left')),
    minY: Math.min(minY, scanEdgeByGray(gray, width, height, bgLum, threshold, 'top')),
    maxX: Math.max(maxX, scanEdgeByGray(gray, width, height, bgLum, threshold, 'right')),
    maxY: Math.max(maxY, scanEdgeByGray(gray, width, height, bgLum, threshold, 'bottom')),
    contentPixels,
  };
}

function validateCropBox(minX, minY, maxX, maxY, width, height, contentPixels) {
  if (contentPixels === 0 || maxX <= minX || maxY <= minY) return null;

  const shrinkX = Math.round(width * 0.008);
  const shrinkY = Math.round(height * 0.008);
  minX = Math.min(maxX - 20, minX + shrinkX);
  minY = Math.min(maxY - 20, minY + shrinkY);
  maxX = Math.max(minX + 20, maxX - shrinkX);
  maxY = Math.max(minY + 20, maxY - shrinkY);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const totalArea = width * height;
  const areaRatio = (cropW * cropH) / totalArea;

  if (areaRatio > 0.96 || areaRatio < 0.1) return null;
  if (contentPixels / totalArea < 0.025) return null;

  return { minX, minY, maxX, maxY, cropW, cropH };
}

function sampleBorderBackground(gray, width, height, stripRatio = 0.04) {
  const stripX = Math.max(2, Math.round(width * stripRatio));
  const stripY = Math.max(2, Math.round(height * stripRatio));
  const samples = [];

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < stripY; y++) samples.push(gray[y * width + x]);
    for (let y = height - stripY; y < height; y++) samples.push(gray[y * width + x]);
  }

  for (let y = stripY; y < height - stripY; y++) {
    for (let x = 0; x < stripX; x++) samples.push(gray[y * width + x]);
    for (let x = width - stripX; x < width; x++) samples.push(gray[y * width + x]);
  }

  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0 ? (samples[mid - 1] + samples[mid]) / 2 : samples[mid];
}

function isPaperPixel(lum, bgLum) {
  const threshold = Math.max(115, bgLum + 15);
  return lum > threshold;
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]);
}

function tightenCropBox(gray, width, height, box, bgLum) {
  let { minX, minY, maxX, maxY } = box;
  const strip = Math.max(2, Math.round(Math.min(width, height) * 0.012));
  const minPaper = 0.94;
  const maxIter = Math.round(Math.min(width, height) * 0.08);

  const rowPaperRatio = (y, x0, x1) => {
    let count = 0;
    let paper = 0;
    for (let x = x0; x <= x1; x++) {
      for (let s = 0; s < strip; s++) {
        const yy = Math.min(height - 1, y + s);
        count++;
        if (isPaperPixel(gray[yy * width + x], bgLum)) paper++;
      }
    }
    return count ? paper / count : 0;
  };

  const colPaperRatio = (x, y0, y1) => {
    let count = 0;
    let paper = 0;
    for (let y = y0; y <= y1; y++) {
      for (let s = 0; s < strip; s++) {
        const xx = Math.min(width - 1, x + s);
        count++;
        if (isPaperPixel(gray[y * width + xx], bgLum)) paper++;
      }
    }
    return count ? paper / count : 0;
  };

  for (let i = 0; i < maxIter && minY < maxY - 24; i++) {
    if (rowPaperRatio(minY, minX, maxX) >= minPaper) break;
    minY++;
  }

  for (let i = 0; i < maxIter && minY < maxY - 24; i++) {
    if (rowPaperRatio(maxY - strip + 1, minX, maxX) >= minPaper) break;
    maxY--;
  }

  for (let i = 0; i < maxIter && minX < maxX - 24; i++) {
    if (colPaperRatio(minX, minY, maxY) >= minPaper) break;
    minX++;
  }

  for (let i = 0; i < maxIter && minX < maxX - 24; i++) {
    if (colPaperRatio(maxX - strip + 1, minY, maxY) >= minPaper) break;
    maxX--;
  }

  return { minX, minY, maxX, maxY };
}

function detectPaperEdgesByScan(gray, width, height, bgLum) {
  const minRatio = 0.34;

  const rowPaperRatio = (y) => {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (isPaperPixel(gray[y * width + x], bgLum)) count++;
    }
    return count / width;
  };

  const colPaperRatio = (x) => {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (isPaperPixel(gray[y * width + x], bgLum)) count++;
    }
    return count / height;
  };

  let minY = 0;
  let maxY = height - 1;
  let minX = 0;
  let maxX = width - 1;

  for (let y = 0; y < height; y++) {
    if (rowPaperRatio(y) > minRatio) {
      minY = y;
      break;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    if (rowPaperRatio(y) > minRatio) {
      maxY = y;
      break;
    }
  }

  for (let x = 0; x < width; x++) {
    if (colPaperRatio(x) > minRatio) {
      minX = x;
      break;
    }
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colPaperRatio(x) > minRatio) {
      maxX = x;
      break;
    }
  }

  return tightenCropBox(gray, width, height, { minX, minY, maxX, maxY }, bgLum);
}

function boxToCropRect(box, width, height, scale) {
  const valid = validateCropBox(
    box.minX,
    box.minY,
    box.maxX,
    box.maxY,
    width,
    height,
    (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1),
  );

  if (!valid) return null;

  return {
    x: Math.round(valid.minX / scale),
    y: Math.round(valid.minY / scale),
    width: Math.round(valid.cropW / scale),
    height: Math.round(valid.cropH / scale),
    areaRatio: (valid.cropW * valid.cropH) / (width * height),
  };
}

function scoreCropResult(crop, width, height) {
  if (!crop) return -1;
  const areaRatio = crop.areaRatio ?? (crop.width * crop.height) / ((width / 1) * (height / 1));
  if (areaRatio > 0.94 || areaRatio < 0.2) return -1;
  return (1 - areaRatio) * 0.82 + areaRatio * 0.18;
}

function detectCropBounds(gray, width, height, bgLum) {
  const bandY0 = Math.round(height * 0.04);
  const bandY1 = Math.round(height * 0.96);
  const paperCutoff = Math.max(158, bgLum + 32);

  const colPaperRatio = (x) => {
    let paper = 0;
    const total = bandY1 - bandY0 + 1;
    for (let y = bandY0; y <= bandY1; y++) {
      if (gray[y * width + x] >= paperCutoff) paper++;
    }
    return paper / total;
  };

  const rowPaperRatio = (y) => {
    const x0 = Math.round(width * 0.06);
    const x1 = Math.round(width * 0.94);
    let paper = 0;
    for (let x = x0; x <= x1; x++) {
      if (gray[y * width + x] >= paperCutoff) paper++;
    }
    return paper / (x1 - x0 + 1);
  };

  let minY = 0;
  let maxY = height - 1;
  let minX = 0;
  let maxX = width - 1;

  for (let y = 0; y < height; y++) {
    if (rowPaperRatio(y) >= 0.32) {
      minY = y;
      break;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    if (rowPaperRatio(y) >= 0.32) {
      maxY = y;
      break;
    }
  }

  for (let x = 0; x < width; x++) {
    if (colPaperRatio(x) >= 0.52) {
      minX = x;
      break;
    }
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colPaperRatio(x) >= 0.52) {
      maxX = x;
      break;
    }
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const fill = (cropW * cropH) / (width * height);
  if (fill < 0.1 || cropW < 40 || cropH < 40) return null;

  return { minX, minY, maxX, maxY, width, height };
}

async function analyzeImageGray(dataUrl) {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = getLuminance(data[i], data[i + 1], data[i + 2]);
  }

  const bgLum = sampleBorderBackground(gray, width, height);
  return { gray, width, height, bgLum };
}

function detectContentCropRectFromGray(gray, width, height) {
  const isContent = (x, y) => {
    const lum = gray[y * width + x];
    return lum > 50 && lum < 252;
  };

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isContent(x, y)) continue;
      found = true;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (!found) return fullCropRect(width, height);

  const pad = Math.max(6, Math.round(Math.min(width, height) * 0.012));
  return clampCropRect(
    {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + 1 + pad * 2,
      height: maxY - minY + 1 + pad * 2,
    },
    width,
    height,
  );
}

export async function detectContentCropRect(dataUrl) {
  const { gray, width, height } = await analyzeImageGray(dataUrl);
  return detectContentCropRectFromGray(gray, width, height);
}

export async function detectSuggestedCropRect(dataUrl) {
  const { gray, width, height, bgLum } = await analyzeImageGray(dataUrl);
  const bounds = detectCropBounds(gray, width, height, bgLum);

  if (bounds) {
    const rect = clampCropRect(
      {
        x: bounds.minX,
        y: bounds.minY,
        width: bounds.maxX - bounds.minX + 1,
        height: bounds.maxY - bounds.minY + 1,
      },
      width,
      height,
    );
    return insetCropRect(rect, width, height);
  }

  return detectContentCropRectFromGray(gray, width, height);
}

function insetCropRect(rect, imgWidth, imgHeight) {
  const fillRatio = (rect.width * rect.height) / (imgWidth * imgHeight);
  if (fillRatio <= 0.9) return rect;

  const pad = Math.max(8, Math.round(Math.min(imgWidth, imgHeight) * 0.022));
  return clampCropRect(
    {
      x: rect.x + pad,
      y: rect.y + pad,
      width: rect.width - pad * 2,
      height: rect.height - pad * 2,
    },
    imgWidth,
    imgHeight,
  );
}

async function trimDocumentEdges(dataUrl) {
  const { gray, width, height, bgLum } = await analyzeImageGray(dataUrl);
  const bounds = detectCropBounds(gray, width, height, bgLum);

  if (!bounds) {
    return { dataUrl, width, height };
  }

  const cropW = bounds.maxX - bounds.minX + 1;
  const cropH = bounds.maxY - bounds.minY + 1;
  const trimmed = await cropImage(dataUrl, {
    x: bounds.minX,
    y: bounds.minY,
    width: cropW,
    height: cropH,
  });

  return {
    dataUrl: trimmed,
    width: cropW,
    height: cropH,
  };
}

export function cropRectToCorners(rect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

async function detectAllCornerCandidateSets(dataUrl, maxSize = 1200) {
  const img = await loadImage(dataUrl);
  const analysis = buildAnalysisCanvas(img, maxSize);
  const candidates = collectCornerCandidates(
    analysis.data,
    analysis.gray,
    analysis.width,
    analysis.height,
  );
  const scaleBack = 1 / analysis.scale;

  const sets = candidates.map((item) => ({
    score: item.score,
    corners: item.corners.map((point) => ({
      x: point.x * scaleBack,
      y: point.y * scaleBack,
    })),
  }));

  const crop = await detectDocumentCrop(dataUrl);
  if (crop && (sets.length === 0 || sets[0].score < 0.42)) {
    const imgDims = await getImageDimensions(dataUrl);
    const fill = (crop.width * crop.height) / (imgDims.width * imgDims.height);
    if (fill >= 0.12 && fill <= 0.88) {
      sets.push({ score: fill * 0.45, corners: cropRectToCorners(crop) });
    }
  }

  sets.sort((a, b) => b.score - a.score);

  const unique = [];
  for (const item of sets) {
    const dup = unique.some((u) => {
      const d =
        Math.abs(u.corners[0].x - item.corners[0].x) +
        Math.abs(u.corners[0].y - item.corners[0].y);
      return d < Math.min(img.naturalWidth, img.naturalHeight) * 0.05;
    });
    if (!dup) unique.push(item);
  }

  return unique;
}

async function detectDocumentCornersFromDataUrl(dataUrl, maxSize = 1200) {
  const sets = await detectAllCornerCandidateSets(dataUrl, maxSize);
  return sets[0]?.corners ?? null;
}

async function measureWarpBorderQuality(dataUrl) {
  const { gray, width, height } = await analyzeImageGray(dataUrl);
  const strip = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  let nonPaper = 0;
  let total = 0;
  /* Relaxed from 118 — warped edges often have shadow/color artefacts */
  const paperCutoff = 95;

  const sample = (x, y) => {
    if (gray[y * width + x] < paperCutoff) nonPaper++;
    total++;
  };

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < strip; y++) sample(x, y);
    for (let y = height - strip; y < height; y++) sample(x, y);
  }
  for (let y = strip; y < height - strip; y++) {
    for (let x = 0; x < strip; x++) sample(x, y);
    for (let x = width - strip; x < width; x++) sample(x, y);
  }

  return total ? 1 - nonPaper / total : 0.5;
}

async function scorePerspectivePackage(packaged, originalDataUrl) {
  if (!packaged?.scanBaseDataUrl || packaged.scanBaseDataUrl === originalDataUrl) return -1;

  const orig = await getImageDimensions(originalDataUrl);
  const warped = await getImageDimensions(packaged.scanBaseDataUrl);
  const origArea = orig.width * orig.height;
  const warpedArea = warped.width * warped.height;
  const areaRatio = warpedArea / origArea;

  if (areaRatio > 1.06 || areaRatio < 0.06) return -1;
  /* Relaxed from 0.28 — paper may occupy a smaller portion of the photo */
  if (areaRatio < 0.12) return -1;

  const cropFill =
    (packaged.cropRect.width * packaged.cropRect.height) / (warped.width * warped.height);
  /* Relaxed from 0.28 — post-warp content detection can be conservative */
  if (cropFill < 0.15) return -1;

  const borderQuality = await measureWarpBorderQuality(packaged.scanBaseDataUrl);
  const aspect = warped.width / Math.max(1, warped.height);
  const aspectScore =
    aspect >= 0.48 && aspect <= 0.82
      ? 1 - Math.abs(aspect - 0.68) / 0.34
      : aspect > 0.82
        ? Math.max(0, 0.35 - (aspect - 0.82) * 1.4)
        : Math.max(0, aspect / 0.48);

  const areaBell =
    areaRatio >= 0.38 && areaRatio <= 0.82
      ? 1 - Math.abs(areaRatio - 0.58) / 0.44
      : Math.max(0, 0.45 - Math.abs(areaRatio - 0.58) * 0.6);

  return cropFill * 0.46 + borderQuality * 0.24 + aspectScore * 0.18 + areaBell * 0.12;
}

async function tryWarpWithCorners(originalDataUrl, corners) {
  const candidates = [];

  const addCandidate = async (packaged) => {
    if (!packaged) return;
    const score = await scorePerspectivePackage(packaged, originalDataUrl);
    if (score > 0) candidates.push({ packaged, score });
  };

  try {
    const opencvWarped = await withTimeout(
      tryOpenCvDocumentWarp(originalDataUrl, 2400, corners),
      20000,
      'OpenCV rapikan',
    );
    if (opencvWarped) await addCandidate(await packageWarpResult(opencvWarped));
  } catch (err) {
    console.warn('OpenCV rapikan gagal:', err);
  }

  await addCandidate(await tryCanvasPerspectiveWarp(originalDataUrl, corners));

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].packaged;
}

async function tryPerspectiveWarp(originalDataUrl) {
  const cornerSets = await detectAllCornerCandidateSets(originalDataUrl, 1200);
  const tried = [];

  for (const { corners } of cornerSets.slice(0, 5)) {
    const result = await tryWarpWithCorners(originalDataUrl, corners);
    if (!result) continue;
    const score = await scorePerspectivePackage(result, originalDataUrl);
    if (score > 0) tried.push({ result, score });
  }

  if (tried.length === 0) {
    try {
      const opencvAuto = await withTimeout(
        tryOpenCvDocumentWarp(originalDataUrl, 2400),
        20000,
        'OpenCV auto rapikan',
      );
      if (opencvAuto) {
        const packaged = await packageWarpResult(opencvAuto);
        const score = await scorePerspectivePackage(packaged, originalDataUrl);
        if (score > 0) tried.push({ result: packaged, score });
      }
    } catch {
      /* ignore */
    }
  }

  if (tried.length === 0) return null;

  tried.sort((a, b) => b.score - a.score);
  return tried[0].result;
}

export async function warpWithExactCorners(originalDataUrl, corners) {
  try {
    const opencvWarped = await withTimeout(
      tryOpenCvDocumentWarp(originalDataUrl, 2400, corners),
      15000,
      'OpenCV exact warp',
    );
    if (opencvWarped) {
      const dims = await getImageDimensions(opencvWarped);
      const full = fullCropRect(dims.width, dims.height);
      return {
        scanBaseDataUrl: opencvWarped,
        cropRect: full,
        autoCropRect: full,
        autoCropApplied: true,
      };
    }
  } catch (err) {
    console.warn('OpenCV exact warp gagal, beralih ke canvas:', err);
  }

  try {
    const canvasWarped = await tryCanvasPerspectiveWarp(originalDataUrl, corners);
    if (canvasWarped) {
      return canvasWarped;
    }
  } catch (err) {
    console.warn('Canvas exact warp gagal:', err);
  }

  return null;
}

export async function tryGeminiDocumentWarp(originalDataUrl) {
  if (!hasGeminiApiKey()) return null;

  try {
    const aiResult = await detectDocumentCornersWithGemini(originalDataUrl);
    if (!aiResult?.corners || aiResult.corners.length !== 4) return null;

    let warped = await warpWithExactCorners(originalDataUrl, aiResult.corners);
    if (!warped) return null;

    if (aiResult.rotation && [90, 180, 270].includes(aiResult.rotation)) {
      const rotatedUrl = await rotateDataUrl(warped.scanBaseDataUrl, aiResult.rotation);
      const rDims = await getImageDimensions(rotatedUrl);
      const rFull = fullCropRect(rDims.width, rDims.height);
      warped = {
        ...warped,
        scanBaseDataUrl: rotatedUrl,
        cropRect: rFull,
        autoCropRect: rFull,
      };
    }

    return {
      ...warped,
      usedGeminiAi: true,
      detectedCorners: aiResult.corners,
      model: aiResult.model,
    };
  } catch (err) {
    console.warn('Gagal memproses dengan Gemini AI:', err);
    throw err;
  }
}

function skewProjectionScore(binary, width, height, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const projection = new Float32Array(height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!binary[y * width + x]) continue;
      const dx = x - cx;
      const dy = y - cy;
      const row = dy * cos + dx * sin + cy;
      const iy = Math.round(row);
      if (iy >= 0 && iy < height) projection[iy] += 1;
    }
  }

  let mean = 0;
  for (let i = 0; i < height; i++) mean += projection[i];
  mean /= height;

  let variance = 0;
  for (let i = 0; i < height; i++) {
    const delta = projection[i] - mean;
    variance += delta * delta;
  }
  return variance;
}

function estimateDocumentSkewAngle(gray, width, height) {
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    binary[i] = gray[i] < 182 ? 1 : 0;
  }

  let bestAngle = 0;
  let bestScore = -1;
  for (let angle = -9; angle <= 9; angle += 0.35) {
    const score = skewProjectionScore(binary, width, height, angle);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  if (Math.abs(bestAngle) < 0.45) return 0;
  return bestAngle;
}

export async function rotateDataUrl(dataUrl, angleDeg) {
  if (Math.abs(angleDeg) < 0.2) return dataUrl;

  const img = await loadImage(dataUrl);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const outW = Math.max(1, Math.round(srcW * cos + srcH * sin));
  const outH = Math.max(1, Math.round(srcW * sin + srcH * cos));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fefefe';
  ctx.fillRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -srcW / 2, -srcH / 2);
  return canvasToDataUrl(canvas, dataUrl, { lossless: true });
}

export async function rotateImageItem(item, angleDeg = 90) {
  const currentSource = item.scanBaseDataUrl || item.originalDataUrl;
  const rotatedBase = await rotateDataUrl(currentSource, angleDeg);
  const dims = await getImageDimensions(rotatedBase);
  const newFull = fullCropRect(dims.width, dims.height);

  let newOriginal = item.originalDataUrl;
  if (!item.scanBaseDataUrl || item.scanBaseDataUrl === item.originalDataUrl) {
    newOriginal = rotatedBase;
  }

  const updatedItem = {
    ...item,
    originalDataUrl: newOriginal,
    scanBaseDataUrl: rotatedBase,
    cropRect: newFull,
    autoCropRect: newFull,
  };

  const { dataUrl } = await buildProcessedImage(
    updatedItem,
    newFull,
    item.enhanceEnabled ?? false,
  );

  return {
    ...updatedItem,
    dataUrl,
  };
}

async function deskewDocumentImage(dataUrl) {
  const img = await loadImage(dataUrl);
  const maxDim = 560;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = getLuminance(data[i], data[i + 1], data[i + 2]);
  }

  const angle = estimateDocumentSkewAngle(gray, width, height);
  if (Math.abs(angle) < 0.45) return dataUrl;

  const rotated = await rotateDataUrl(dataUrl, -angle);
  const trimmed = await trimDocumentEdges(rotated);
  return trimmed.dataUrl;
}

async function packageWarpResult(warped) {
  let trimmed = await trimDocumentEdges(warped);
  trimmed = {
    ...trimmed,
    dataUrl: await deskewDocumentImage(trimmed.dataUrl),
  };
  const deskewedDims = await getImageDimensions(trimmed.dataUrl);
  trimmed.width = deskewedDims.width;
  trimmed.height = deskewedDims.height;
  const innerCrop = normalizeCropRectForSource(
    await detectSuggestedCropRect(trimmed.dataUrl),
    trimmed.width,
    trimmed.height,
  );
  const innerFill =
    (innerCrop.width * innerCrop.height) / (trimmed.width * trimmed.height);
  if (innerFill >= 0.35 && innerFill <= 0.98) {
    trimmed = {
      dataUrl: await cropImage(trimmed.dataUrl, innerCrop, { lossless: true }),
      width: innerCrop.width,
      height: innerCrop.height,
    };
  }

  const contentCrop = fullCropRect(trimmed.width, trimmed.height);

  return {
    scanBaseDataUrl: trimmed.dataUrl,
    cropRect: contentCrop,
    autoCropRect: contentCrop,
    autoCropApplied: true,
  };
}

async function tryCanvasPerspectiveWarp(originalDataUrl, presetCorners = null) {
  const img = await loadImage(originalDataUrl);
  const analysis = buildAnalysisCanvas(img, 900);

  let fullCorners = presetCorners ?? null;
  if (!fullCorners) {
    const corners = detectCornersFromAnalysis(
      analysis.data,
      analysis.gray,
      analysis.width,
      analysis.height,
    );
    if (!corners) return null;
    const scaleBack = 1 / analysis.scale;
    fullCorners = corners.map((point) => ({
      x: point.x * scaleBack,
      y: point.y * scaleBack,
    }));
    fullCorners = outsetCorners(fullCorners);
  }

  const maxDim = 2400;
  const renderScale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * renderScale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * renderScale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const renderCorners = fullCorners.map((point) => ({
    x: point.x * renderScale,
    y: point.y * renderScale,
  }));

  if (!warped) return null;

  if (presetCorners) {
    const dims = await getImageDimensions(warped);
    const full = fullCropRect(dims.width, dims.height);
    return {
      scanBaseDataUrl: warped,
      cropRect: full,
      autoCropRect: full,
      autoCropApplied: true,
    };
  }

  return packageWarpResult(warped);
}

function detectTintedFormBox(data, gray, width, height, bg) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = gray[y * width + x];
      const blueForm = b > r + 4 && b > g + 1 && lum > 88 && lum < 245;
      const greenForm = g > r + 5 && g >= b - 3 && lum > 85 && lum < 245;

      if (blueForm || greenForm) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count++;
      }
    }
  }

  if (count < width * height * 0.015) return null;

  const validated = validateCropBox(minX, minY, maxX, maxY, width, height, count);
  if (!validated) return null;

  return boxToCropRect(validated, width, height, 1);
}

export async function detectDocumentCrop(dataUrl) {
  const img = await loadImage(dataUrl);
  const { data, gray, width, height, scale } = buildAnalysisCanvas(img);
  const candidates = [];

  const bgCorner = sampleCornerBackground(data, width, height);
  const bgBorderLum = sampleBorderBackground(gray, width, height);
  const tinted = detectTintedFormBox(data, gray, width, height, bgCorner);
  if (tinted) candidates.push({ ...tinted, method: 'tinted-form' });

  const edgeBox = detectPaperEdgesByScan(gray, width, height, bgBorderLum);
  const edgeCrop = boxToCropRect(edgeBox, width, height, scale);
  if (edgeCrop) candidates.push({ ...edgeCrop, method: 'paper-scan' });

  const thresholds = [20, 26, 32, 38, 44];

  for (const threshold of thresholds) {
    const box = computeBoundingBox(data, gray, width, height, bgCorner, threshold);
    const crop = boxToCropRect(box, width, height, scale);
    if (crop) candidates.push({ ...crop, method: 'color-diff' });
  }

  let best = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreCropResult(candidate, width, height);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best) return null;

  return {
    x: best.x,
    y: best.y,
    width: best.width,
    height: best.height,
  };
}

let lastGeminiError = null;

export function getLastGeminiError() {
  return lastGeminiError;
}

export function clearLastGeminiError() {
  lastGeminiError = null;
}

export async function autoScanDocument(originalDataUrl, autoCrop = true) {
  const dims = await getImageDimensions(originalDataUrl);
  const fullRect = fullCropRect(dims.width, dims.height);

  if (!autoCrop) {
    return {
      scanBaseDataUrl: originalDataUrl,
      cropRect: fullRect,
      autoCropRect: fullRect,
      autoCropApplied: false,
    };
  }

  // 1. Prioritaskan Gemini Vision AI jika API Key tersedia
  if (hasGeminiApiKey()) {
    try {
      clearLastGeminiError();
      const geminiWarped = await tryGeminiDocumentWarp(originalDataUrl);
      if (geminiWarped) {
        return geminiWarped;
      }
    } catch (err) {
      lastGeminiError = err.message || 'Gagal memproses dengan Gemini AI';
      console.warn('Gemini AI gagal, beralih ke deteksi lokal:', err);
    }
  }

  const warped = await tryPerspectiveWarp(originalDataUrl);
  if (warped) return warped;

  const detected = await detectDocumentCrop(originalDataUrl);
  if (detected) {
    const fillRatio = (detected.width * detected.height) / (dims.width * dims.height);
    if (fillRatio < 0.95) {
      return {
        scanBaseDataUrl: originalDataUrl,
        cropRect: detected,
        autoCropRect: detected,
        autoCropApplied: true,
      };
    }
  }

  return {
    scanBaseDataUrl: originalDataUrl,
    cropRect: fullRect,
    autoCropRect: fullRect,
    autoCropApplied: false,
  };
}

export function fullCropRect(imgWidth, imgHeight) {
  return { x: 0, y: 0, width: imgWidth, height: imgHeight };
}

export async function getImageDimensions(dataUrl) {
  const img = await loadImage(dataUrl);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

export async function cropImage(dataUrl, cropRect, options = {}) {
  const { lossless = false } = options;
  const img = await loadImage(dataUrl);
  const { x, y, width, height } = clampCropRect(cropRect, img.naturalWidth, img.naturalHeight);

  if (width < 2 || height < 2) return dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);

  return canvasToDataUrl(canvas, dataUrl, { lossless });
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

function canvasToDataUrl(canvas, sourceDataUrl, options = {}) {
  const { lossless = false } = options;
  if (lossless) {
    return canvas.toDataURL('image/png');
  }
  const type = sourceDataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const quality = type === 'image/jpeg' ? 0.95 : undefined;
  return canvas.toDataURL(type, quality);
}

function boxBlur(src, width, height, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      if (x === 0) {
        for (let k = -radius; k <= radius; k++) {
          const cx = Math.max(0, Math.min(width - 1, k));
          sum += src[y * width + cx];
        }
      } else {
        const addX = Math.min(width - 1, x + radius);
        const remX = Math.max(0, x - radius - 1);
        sum += src[y * width + addX] - src[y * width + remX];
      }
      tmp[y * width + x] = sum / win;
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      if (y === 0) {
        for (let k = -radius; k <= radius; k++) {
          const cy = Math.max(0, Math.min(height - 1, k));
          sum += tmp[cy * width + x];
        }
      } else {
        const addY = Math.min(height - 1, y + radius);
        const remY = Math.max(0, y - radius - 1);
        sum += tmp[addY * width + x] - tmp[remY * width + x];
      }
      out[y * width + x] = sum / win;
    }
  }

  return out;
}

function getSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min;
}

function boostSaturation(r, g, b, amount) {
  const lum = getLuminance(r, g, b);
  return [
    clampByte(lum + (r - lum) * amount),
    clampByte(lum + (g - lum) * amount),
    clampByte(lum + (b - lum) * amount),
  ];
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mixChannel(from, to, amount) {
  return clampByte(from + (to - from) * amount);
}

function smoothPaperSpeckle(data, width, height) {
  const copy = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      const lum = getLuminance(copy[i], copy[i + 1], copy[i + 2]);
      const sat = getSaturation(copy[i], copy[i + 1], copy[i + 2]);
      if (lum < 232 || sat > 28) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const j = ((y + ky) * width + (x + kx)) * 4;
          r += copy[j];
          g += copy[j + 1];
          b += copy[j + 2];
        }
      }

      data[i] = r / 9;
      data[i + 1] = g / 9;
      data[i + 2] = b / 9;
    }
  }
}

function applyDocumentScanLook(data, width, height) {
  const pixelCount = width * height;
  const lum = new Float32Array(pixelCount);
  const paperTone = [255, 255, 255];

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = getLuminance(data[i], data[i + 1], data[i + 2]);
  }

  const blurRadius = Math.max(10, Math.round(Math.min(width, height) * 0.024));
  const bgLum = boxBlur(lum, width, height, blurRadius);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    const bg = Math.max(bgLum[p], 50);
    const flatten = Math.min(1.4, 235 / bg);
    r = clampByte(r * flatten);
    g = clampByte(g * flatten);
    b = clampByte(b * flatten);

    let nl = getLuminance(r, g, b);
    let sat = getSaturation(r, g, b);

    const greenWeight =
      smoothstep(8, 28, g - r) * smoothstep(60, 200, nl) * (1 - smoothstep(18, 40, sat));
    if (greenWeight > 0) {
      const gr = clampByte(r * 0.82);
      const gg = clampByte(g * 1.05 + 5);
      const gb = clampByte(b * 0.88);
      r = mixChannel(r, gr, greenWeight);
      g = mixChannel(g, gg, greenWeight);
      b = mixChannel(b, gb, greenWeight);
      nl = getLuminance(r, g, b);
      sat = getSaturation(r, g, b);
    }

    const blueWeight =
      smoothstep(18, 40, b - r) * smoothstep(70, 210, nl) * (1 - smoothstep(18, 40, sat));
    if (blueWeight > 0) {
      const br = clampByte(r * 0.94);
      const bgC = clampByte(g * 0.97);
      const bb = clampByte(b * 1.04 + 4);
      r = mixChannel(r, br, blueWeight);
      g = mixChannel(g, bgC, blueWeight);
      b = mixChannel(b, bb, blueWeight);
      nl = getLuminance(r, g, b);
      sat = getSaturation(r, g, b);
    }

    // CamScanner-style "Ajaib Pro":
    // 1. Text / Ink: darken to crisp deep contrast
    const inkTarget = [12, 12, 14];
    const inkWeight = (1 - smoothstep(75, 195, nl)) * (1 - smoothstep(16, 44, sat));
    r = mixChannel(r, inkTarget[0], inkWeight * 0.88);
    g = mixChannel(g, inkTarget[1], inkWeight * 0.88);
    b = mixChannel(b, inkTarget[2], inkWeight * 0.88);

    nl = getLuminance(r, g, b);

    // 2. Paper background: clean white
    const paperWeight = smoothstep(160, 215, nl) * (1 - smoothstep(15, 38, sat));
    r = mixChannel(r, paperTone[0], paperWeight * 0.98);
    g = mixChannel(g, paperTone[1], paperWeight * 0.98);
    b = mixChannel(b, paperTone[2], paperWeight * 0.98);

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  smoothPaperSpeckle(data, width, height);
}

function applyColorClarity(data, width, height) {
  applyDocumentScanLook(data, width, height);
}

export async function applyEnhanceFilter(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyColorClarity(imageData.data, canvas.width, canvas.height);
  applySharpen(imageData.data, canvas.width, canvas.height, 0.4);
  ctx.putImageData(imageData, 0, 0);
  return canvasToDataUrl(canvas, dataUrl, { lossless: false });
}

function applySharpen(data, width, height, amount = 0.4) {
  const copy = new Uint8ClampedArray(data);
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += copy[((y + ky) * width + (x + kx)) * 4 + c] * kernel[ki];
            ki++;
          }
        }
        const sharpened = clampByte(sum);
        data[i + c] = clampByte(copy[i + c] + (sharpened - copy[i + c]) * amount);
      }
    }
  }
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const A4_RATIO = 210 / 297;
const A4_LONG_EDGE = 1754;

/** Sesuaikan dokumen ke kanvas A4 (portrait/landscape) seperti CamScanner. */
export async function fitToA4Page(dataUrl, options = {}) {
  const { marginRatio = 0.028, paper = [254, 254, 252] } = options;
  const img = await loadImage(dataUrl);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const portrait = srcH >= srcW;
  const pageW = portrait ? Math.round(A4_LONG_EDGE * A4_RATIO) : A4_LONG_EDGE;
  const pageH = portrait ? A4_LONG_EDGE : Math.round(A4_LONG_EDGE * A4_RATIO);
  const margin = Math.round(Math.min(pageW, pageH) * marginRatio);
  const innerW = pageW - margin * 2;
  const innerH = pageH - margin * 2;
  const scale = Math.min(innerW / srcW, innerH / srcH);
  const drawW = Math.max(1, Math.round(srcW * scale));
  const drawH = Math.max(1, Math.round(srcH * scale));
  const drawX = Math.round((pageW - drawW) / 2);
  const drawY = Math.round((pageH - drawH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = pageW;
  canvas.height = pageH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${paper.join(',')})`;
  ctx.fillRect(0, 0, pageW, pageH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  return canvasToDataUrl(canvas, dataUrl, { lossless: true });
}

export async function buildProcessedImage(item, cropRect, enhanceEnabled) {
  const sourceUrl = item.scanBaseDataUrl || item.originalDataUrl;
  const dims = await getImageDimensions(sourceUrl);
  const rect = cropRect ?? fullCropRect(dims.width, dims.height);
  const baseDataUrl = await cropImage(sourceUrl, rect, { lossless: true });

  const dataUrl = enhanceEnabled ? await applyEnhanceFilter(baseDataUrl) : baseDataUrl;

  return { baseDataUrl, dataUrl, cropRect: rect };
}

export async function prepareUploadedImage(originalDataUrl) {
  const dims = await getImageDimensions(originalDataUrl);
  const fullRect = fullCropRect(dims.width, dims.height);

  return {
    originalDataUrl,
    scanBaseDataUrl: originalDataUrl,
    dataUrl: originalDataUrl,
    cropRect: fullRect,
    autoCropRect: fullRect,
    autoCropApplied: false,
    enhanceEnabled: false,
    autoEnhanceApplied: false,
  };
}

export async function rapikanImage(originalDataUrl, enhanceEnabled = false) {
  const scanned = await autoScanDocument(originalDataUrl, true);
  const item = { originalDataUrl, ...scanned };
  const { dataUrl } = await buildProcessedImage(item, scanned.cropRect, enhanceEnabled);

  return {
    originalDataUrl,
    ...scanned,
    enhanceEnabled,
    autoEnhanceApplied: enhanceEnabled,
    dataUrl,
    geminiError: getLastGeminiError(),
  };
}

export async function autoTidyImage(originalDataUrl, options = {}) {
  const { autoCrop = true, autoEnhance = false } = options;
  if (!autoCrop) {
    return prepareUploadedImage(originalDataUrl);
  }
  return rapikanImage(originalDataUrl, autoEnhance);
}

export async function processUploadedImage(_file, originalDataUrl) {
  try {
    const result = await autoTidyImage(originalDataUrl, { autoCrop: true, autoEnhance: true });
    if (isRapikanDone(result)) return result;
  } catch (err) {
    console.warn('Auto scan gagal:', err);
  }
  return prepareUploadedImage(originalDataUrl);
}

export function isRapikanDone(item) {
  return !!(
    item?.autoCropApplied &&
    item?.scanBaseDataUrl &&
    (item.scanBaseDataUrl !== item.originalDataUrl ||
      (item.cropRect && (item.cropRect.x > 0 || item.cropRect.y > 0 || item.cropRect.width > 0)))
  );
}

export function getCropSourceUrl(item) {
  return item.scanBaseDataUrl || item.originalDataUrl;
}

export function normalizeCropRectForSource(cropRect, sourceWidth, sourceHeight) {
  const full = fullCropRect(sourceWidth, sourceHeight);
  if (!cropRect || cropRect.width < 1 || cropRect.height < 1) return full;

  const overflows =
    cropRect.x >= sourceWidth ||
    cropRect.y >= sourceHeight ||
    cropRect.x + cropRect.width > sourceWidth + 1 ||
    cropRect.y + cropRect.height > sourceHeight + 1;

  if (overflows) return full;

  const fillRatio = (cropRect.width * cropRect.height) / (sourceWidth * sourceHeight);
  if (fillRatio < 0.2) return full;

  const widthRatio = cropRect.width / sourceWidth;
  if (widthRatio < 0.35 || widthRatio > 1.01) return full;

  return clampCropRect(cropRect, sourceWidth, sourceHeight);
}

export function getResetCropRect(item, sourceWidth, sourceHeight) {
  const rect = item.autoCropRect || item.cropRect;
  if (sourceWidth && sourceHeight) {
    return normalizeCropRectForSource(rect, sourceWidth, sourceHeight);
  }
  return rect;
}
