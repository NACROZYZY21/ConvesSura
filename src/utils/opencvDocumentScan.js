import { loadOpenCv } from './opencvLoader.js';
import { orderCorners } from './documentScan.js';
import {
  collectPaperQuadCandidates,
  estimatePaperLum,
  orderQuad,
  scorePaperQuad,
  tightenQuadSides,
} from './paperQuad.js';

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function orderPoints(points) {
  return orderCorners(points);
}

function matToDataUrl(cv, mat) {
  const canvas = document.createElement('canvas');
  cv.imshow(canvas, mat);
  return canvas.toDataURL('image/png');
}

function extractQuadPoints(cv, approx, scale) {
  const points = [];
  for (let j = 0; j < 4; j++) {
    points.push({
      x: approx.intPtr(j, 0)[0] / scale,
      y: approx.intPtr(j, 0)[1] / scale,
    });
  }
  return orderPoints(points);
}

function scoreQuad(corners, imageArea) {
  const [tl, tr, br, bl] = orderPoints(corners);
  const wTop = dist(tl, tr);
  const wBottom = dist(bl, br);
  const hLeft = dist(tl, bl);
  const hRight = dist(tr, br);
  const minW = Math.min(wTop, wBottom);
  const minH = Math.min(hLeft, hRight);

  /* Relaxed min-size — smaller paper at distance still valid */
  if (minW < 30 || minH < 30) return -1;

  const area = Math.abs(
    (tl.x * tr.y - tr.x * tl.y) +
      (tr.x * br.y - br.x * tr.y) +
      (br.x * bl.y - bl.x * br.y) +
      (bl.x * tl.y - tl.x * bl.y),
  ) / 2;
  const areaRatio = area / imageArea;

  /* Relaxed: accept quads covering 8–96 % of image */
  if (areaRatio < 0.08 || areaRatio > 0.96) return -1;

  const aspect = minW / minH;
  if (aspect < 0.2 || aspect > 5.0) return -1;

  const parallelScore =
    1 - Math.abs(wTop - wBottom) / Math.max(wTop, wBottom) +
    (1 - Math.abs(hLeft - hRight) / Math.max(hLeft, hRight));

  return areaRatio * 0.55 + parallelScore * 0.25 + (1 - areaRatio) * 0.2;
}

/* ───────────────────────────────────────────────────────────
   scanForQuads — find quadrilateral contours in a binary image
   Shared helper used by all detection strategies.
   ─────────────────────────────────────────────────────────── */
function interiorWhiteness(cv, rgba, points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const cy = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const spanW = Math.max(...xs) - Math.min(...xs);
  const spanH = Math.max(...ys) - Math.min(...ys);
  const boxW = Math.max(8, Math.round(spanW * 0.42));
  const boxH = Math.max(8, Math.round(spanH * 0.42));
  const minX = Math.max(0, Math.round(cx - boxW / 2));
  const minY = Math.max(0, Math.round(cy - boxH / 2));
  const maxX = Math.min(rgba.cols - 1, minX + boxW);
  const maxY = Math.min(rgba.rows - 1, minY + boxH);
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 8 || h < 8) return 0.5;

  const roi = rgba.roi(new cv.Rect(minX, minY, w, h));
  const mean = cv.mean(roi);
  roi.delete();

  const r = mean[0];
  const g = mean[1];
  const b = mean[2];
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const sat = maxC - minC;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const bright = Math.max(0, Math.min(1, (lum - 70) / 170));
  const neutral = Math.max(0, Math.min(1, 1 - sat / 140));
  return bright * 0.55 + neutral * 0.45;
}

function scanForQuads(cv, binary, rgba, imageArea, scale) {
  const candidates = [];

  for (const mode of [cv.RETR_EXTERNAL, cv.RETR_LIST]) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    try {
      cv.findContours(binary, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < imageArea * 0.08 || area > imageArea * 0.96) continue;

        const peri = cv.arcLength(contour, true);

        /* Try multiple epsilon values — looser eps helps when
           edges are slightly noisy or rounded */
        for (const eps of [0.02, 0.035, 0.05]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, eps * peri, true);

          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const matPoints = [];
            for (let j = 0; j < 4; j++) {
              matPoints.push({
                x: approx.intPtr(j, 0)[0],
                y: approx.intPtr(j, 0)[1],
              });
            }
            const points = extractQuadPoints(cv, approx, scale);
            const geometric = scoreQuad(points, imageArea / (scale * scale));
            if (geometric > 0) {
              const white = interiorWhiteness(cv, rgba, matPoints);
              const score = geometric * (0.42 + 0.58 * white);
              candidates.push({ corners: points, score });
            }
          }
          approx.delete();
        }
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  return candidates;
}

/* ───────────────────────────────────────────────────────────
   detectQuadContour — multi-strategy document quad detection

   Strategy 1:  Canny edge detection with MULTIPLE blur levels
                (larger blur suppresses batik/cloth texture)
   Strategy 2:  OTSU thresholding — separates white paper from
                colorful/dark background even with heavy texture
   Strategy 3:  Canny on cleaned OTSU result for sharp edges
   ─────────────────────────────────────────────────────────── */
function longestRun(scores, threshold) {
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let start = -1;

  for (let i = 0; i <= scores.length; i++) {
    const active = i < scores.length && scores[i] >= threshold;
    if (active && start < 0) start = i;
    if (!active && start >= 0) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
        bestEnd = i - 1;
      }
      start = -1;
    }
  }

  if (bestStart < 0) return null;
  return { start: bestStart, end: bestEnd };
}

function expandRun(scores, run, softThreshold, maxPad) {
  let start = run.start;
  let end = run.end;
  while (start > 0 && run.start - start < maxPad && scores[start - 1] >= softThreshold) start--;
  while (end < scores.length - 1 && end - run.end < maxPad && scores[end + 1] >= softThreshold) end++;
  return { start, end };
}

function outsideColorRatio(mat, points) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))));
  const maxX = Math.min(mat.cols - 1, Math.ceil(Math.max(...points.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
  const maxY = Math.min(mat.rows - 1, Math.ceil(Math.max(...points.map((p) => p.y))));
  let colored = 0;
  let total = 0;
  const step = 6;

  for (let y = 0; y < mat.rows; y += step) {
    for (let x = 0; x < mat.cols; x += step) {
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
      const p = mat.ucharPtr(y, x);
      const sat = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
      if (sat > 42) colored++;
      total++;
    }
  }

  return total ? colored / total : 0;
}

function findWhitePaperQuad(cv, mat, scale) {
  const rows = mat.rows;
  const cols = mat.cols;
  const paper = new Uint8Array(rows * cols);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = mat.ucharPtr(y, x);
      const r = p[0];
      const g = p[1];
      const b = p[2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 168 && Math.max(r, g, b) - Math.min(r, g, b) < 52 && b > 135) {
        paper[y * cols + x] = 1;
      }
    }
  }

  const yBand0 = Math.round(rows * 0.14);
  const yBand1 = Math.round(rows * 0.86);
  const colScore = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    let count = 0;
    for (let y = yBand0; y < yBand1; y++) count += paper[y * cols + x];
    colScore[x] = count / Math.max(1, yBand1 - yBand0);
  }

  const colCore = longestRun(colScore, 0.55);
  if (!colCore) return null;
  const colRun = expandRun(colScore, colCore, 0.34, Math.round(cols * 0.06));
  const colWidth = colRun.end - colRun.start + 1;
  if (colWidth < cols * 0.12 || colWidth > cols * 0.86) return null;

  const rowScore = new Float32Array(rows);
  for (let y = 0; y < rows; y++) {
    let count = 0;
    for (let x = colRun.start; x <= colRun.end; x++) count += paper[y * cols + x];
    rowScore[y] = count / colWidth;
  }

  const rowCore = longestRun(rowScore, 0.42);
  if (!rowCore) return null;
  const rowRun = expandRun(rowScore, rowCore, 0.2, Math.round(rows * 0.04));
  const rowHeight = rowRun.end - rowRun.start + 1;
  if (rowHeight < rows * 0.18) return null;

  const filtered = new cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  for (let y = rowRun.start; y <= rowRun.end; y++) {
    for (let x = colRun.start; x <= colRun.end; x++) {
      if (paper[y * cols + x]) filtered.ucharPtr(y, x)[0] = 255;
    }
  }

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const closed = new cv.Mat();
  cv.morphologyEx(filtered, closed, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  filtered.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let corners = null;

  try {
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let bestArea = 0;
    let bestPoints = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area <= bestArea) continue;
      const rect = cv.minAreaRect(contour);
      const shortSide = Math.min(rect.size.width, rect.size.height);
      const longSide = Math.max(rect.size.width, rect.size.height);
      if (shortSide < 30 || longSide / shortSide > 8) continue;
      bestArea = area;
      bestPoints = cv.RotatedRect.points(rect).map((point) => ({ x: point.x, y: point.y }));
    }

    if (!bestPoints) return null;
    const areaRatio = bestArea / (rows * cols);
    if (areaRatio < 0.06 || areaRatio > 0.7) return null;
    if (interiorWhiteness(cv, mat, bestPoints) < 0.68) return null;
    if (outsideColorRatio(mat, bestPoints) < 0.18) return null;

    const cx = bestPoints.reduce((sum, point) => sum + point.x, 0) / bestPoints.length;
    const cy = bestPoints.reduce((sum, point) => sum + point.y, 0) / bestPoints.length;
    const outset = 1.025;
    corners = orderPoints(
      bestPoints.map((point) => ({
        x: (cx + (point.x - cx) * outset) / scale,
        y: (cy + (point.y - cy) * outset) / scale,
      })),
    );
  } finally {
    closed.delete();
    contours.delete();
    hierarchy.delete();
  }

  return corners;
}

function detectQuadContour(cv, mat, scale) {
  const whitePaper = findWhitePaperQuad(cv, mat, scale);
  if (whitePaper) return whitePaper;

  const gray = new cv.Mat();
  const imageArea = mat.rows * mat.cols;
  const allCandidates = [];

  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    /* ── Strategy 1: Canny with multiple blur levels ──────────
       Larger Gaussian kernels suppress busy background textures
       (batik, tablecloths, patterned surfaces) so the real paper
       edges stand out in the Canny output. */
    const blurSizes = [5, 9, 15];
    const cannyPairs = [
      [20, 60],   /* very sensitive — catches subtle paper edges */
      [30, 90],
      [50, 150],
      [75, 200],
    ];

    for (const ksize of blurSizes) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(ksize, ksize), 0);

      for (const [low, high] of cannyPairs) {
        const edges = new cv.Mat();
        cv.Canny(blurred, edges, low, high);

        /* Morphological CLOSE (dilate → erode) instead of bare dilate.
           Connects fragmented edges while removing small noise dots. */
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        const closed = new cv.Mat();
        cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
        kernel.delete();

        allCandidates.push(...scanForQuads(cv, closed, mat, imageArea, scale));

        edges.delete();
        closed.delete();
      }

      blurred.delete();
    }

    /* ── Strategy 2: OTSU thresholding ──────────────────────
       Best for white paper on busy/colorful backgrounds.
       Heavy blur (21×21) crushes the background texture,
       then OTSU automatically finds the brightness threshold
       that separates paper (bright) from background (darker). */
    const heavyBlur = new cv.Mat();
    cv.GaussianBlur(gray, heavyBlur, new cv.Size(21, 21), 0);

    const otsu = new cv.Mat();
    cv.threshold(heavyBlur, otsu, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    heavyBlur.delete();

    /* Morphological close fills holes inside the paper region
       and smooths the boundary for cleaner contour detection */
    const otsuKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11));
    const otsuClosed = new cv.Mat();
    cv.morphologyEx(otsu, otsuClosed, cv.MORPH_CLOSE, otsuKernel);
    otsuKernel.delete();
    otsu.delete();

    allCandidates.push(...scanForQuads(cv, otsuClosed, mat, imageArea, scale));

    /* ── Strategy 3: Canny on cleaned OTSU ────────────────
       The OTSU binary mask has clean paper/background separation.
       Applying Canny on this gives crisp quad edges even when
       the original image had noisy edges. */
    const otsuEdges = new cv.Mat();
    cv.Canny(otsuClosed, otsuEdges, 50, 150);

    const dilKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    const otsuDilated = new cv.Mat();
    cv.dilate(otsuEdges, otsuDilated, dilKernel);
    dilKernel.delete();

    allCandidates.push(...scanForQuads(cv, otsuDilated, mat, imageArea, scale));

    otsuEdges.delete();
    otsuDilated.delete();
    otsuClosed.delete();

    /* ── Strategy 4: Blue-channel isolation ───────────────
       Yellow, orange, wooden tables have very low blue values (B < 70)
       while white paper receipts have high blue (B > 180).
       This cleanly isolates receipts from colorful/warm tables! */
    try {
      const channels = new cv.MatVector();
      cv.split(mat, channels);
      if (channels.size() >= 3) {
        const blueMat = channels.get(2);
        const blueBlur = new cv.Mat();
        cv.GaussianBlur(blueMat, blueBlur, new cv.Size(15, 15), 0);
        const blueOtsu = new cv.Mat();
        cv.threshold(blueBlur, blueOtsu, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
        const bKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
        const blueClosed = new cv.Mat();
        cv.morphologyEx(blueOtsu, blueClosed, cv.MORPH_CLOSE, bKernel);

        allCandidates.push(...scanForQuads(cv, blueClosed, mat, imageArea, scale));

        bKernel.delete();
        blueBlur.delete();
        blueOtsu.delete();
        blueClosed.delete();
      }
      channels.delete();
    } catch {
      /* ignore channel split error */
    }

    /* Pick the best-scoring quad from all strategies */
    if (allCandidates.length === 0) return null;

    allCandidates.sort((a, b) => b.score - a.score);
    return allCandidates[0].corners;

  } finally {
    gray.delete();
  }
}

/* ───────────────────────────────────────────────────────────
   refineQuadEdges — presisikan quad kasar ke tepi kertas asli

   Tiap sisi di-sampling sepanjang garis normalnya; posisi transisi
   "kertas putih (dalam) → latar (luar)" dicatat sebagai kandidat,
   lalu garis sisi di-fit dengan RANSAC (tahan teks/garis putus-putus
   di dekat tepi). Sudut baru = perpotongan sisi yang bertetangga.
   ─────────────────────────────────────────────────────────── */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function pixelWhiteness(data, width, height, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return 0;
  const i = (yi * width + xi) * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return clamp01((lum - 110) / 90) * clamp01(1 - (sat - 18) / 40);
}

function edgeCandidatesAlongNormal(data, width, height, origin, normal, range) {
  const win = 3;
  const profile = [];
  for (let d = -range - win; d <= range + win; d++) {
    profile.push(pixelWhiteness(data, width, height, origin.x + normal.x * d, origin.y + normal.y * d));
  }

  const steps = [];
  for (let d = -range; d <= range; d++) {
    const c = d + range + win;
    let inner = 0;
    let outer = 0;
    for (let k = 1; k <= win; k++) {
      inner += profile[c - k];
      outer += profile[c + k];
    }
    steps.push({ d, step: (inner - outer) / win });
  }

  const peaks = [];
  for (let j = 0; j < steps.length; j++) {
    const s = steps[j].step;
    if (s < 0.35) continue;
    if (j > 0 && steps[j - 1].step > s) continue;
    if (j < steps.length - 1 && steps[j + 1].step >= s) continue;
    peaks.push(steps[j]);
  }
  peaks.sort((a, b) => b.step - a.step);

  return peaks.slice(0, 3).map(({ d, step }) => ({
    x: origin.x + normal.x * d,
    y: origin.y + normal.y * d,
    weight: step,
  }));
}

function fitLine(points) {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function lineDistance(line, point) {
  return Math.abs((point.x - line.p.x) * line.dir.y - (point.y - line.p.y) * line.dir.x);
}

function ransacEdgeLine(candidates, sampleCount, tolerance) {
  const flat = candidates.flatMap((list, idx) => list.map((pt) => ({ ...pt, idx })));
  if (flat.length < 2) return null;

  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let best = null;
  for (let iter = 0; iter < 200; iter++) {
    const a = flat[Math.floor(rand() * flat.length)];
    const b = flat[Math.floor(rand() * flat.length)];
    if (a.idx === b.idx) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const line = { p: a, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };

    const bestPerSample = new Map();
    for (const pt of flat) {
      if (lineDistance(line, pt) > tolerance) continue;
      const prev = bestPerSample.get(pt.idx);
      if (!prev || pt.weight > prev.weight) bestPerSample.set(pt.idx, pt);
    }
    let score = 0;
    for (const pt of bestPerSample.values()) score += pt.weight;
    if (!best || score > best.score) best = { score, inliers: [...bestPerSample.values()] };
  }

  if (!best || best.inliers.length < sampleCount * 0.35) return null;
  return fitLine(best.inliers);
}

/**
 * Pilih quad kertas terbaik dari kandidat mask + Hough, plus detectQuadContour (lama)
 * bila hasil awal belum meyakinkan. Semua dinilai dengan bukti tepi keliling;
 * 4 teratas dicoba apa adanya / dirapatkan / diperhalus lalu dinilai ulang.
 * @param {() => Array<{x:number,y:number}>|null} getLegacyCorners koordinat `src`
 * @returns {{corners: Array<{x:number,y:number}>, confident: boolean, score: number}|null}
 *   corners dalam koordinat `src`
 */
function selectPaperQuad(cv, src, getLegacyCorners) {
  const scale = Math.min(1, 640 / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  cv.resize(src, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

  try {
    const { data, cols: width, rows: height } = small;
    const paperLum = estimatePaperLum(data, width, height);

    const pickBest = (candidates) => {
      /* Saring cepat (10 titik/sisi), lalu nilai penuh 30 teratas */
      const coarse = [];
      for (const quad of candidates) {
        const result = scorePaperQuad(data, width, height, quad, paperLum, 10);
        if (result) coarse.push({ quad, score: result.score });
      }
      coarse.sort((a, b) => b.score - a.score);
      const scored = [];
      for (const { quad } of coarse.slice(0, 30)) {
        const result = scorePaperQuad(data, width, height, quad, paperLum);
        if (result) scored.push({ quad, score: result.score });
      }
      scored.sort((a, b) => b.score - a.score);

      let best = null;
      const tried = [];
      for (const cand of scored) {
        if (tried.length >= 4) break;
        if (tried.some((q) => q.every((p, i) => Math.hypot(p.x - cand.quad[i].x, p.y - cand.quad[i].y) < 4))) {
          continue;
        }
        tried.push(cand.quad);
        const variants = [cand.quad, orderQuad(tightenQuadSides(data, width, height, cand.quad))];
        for (const variant of variants) {
          for (const quad of [variant, orderQuad(refineQuadEdges(data, width, height, variant).corners)]) {
            const result = scorePaperQuad(data, width, height, quad, paperLum);
            if (result && (!best || result.score > best.score)) best = { quad, score: result.score };
          }
        }
      }
      return best;
    };

    let best = pickBest(collectPaperQuadCandidates(cv, small, paperLum));
    /* Detektor lama mahal (belasan Canny) — hanya bila kandidat baru belum meyakinkan */
    if (!best || best.score < 0.8) {
      const legacy = getLegacyCorners();
      if (legacy) {
        const legacyBest = pickBest([orderQuad(legacy.map((p) => ({ x: p.x * scale, y: p.y * scale })))]);
        if (legacyBest && (!best || legacyBest.score > best.score)) best = legacyBest;
      }
    }

    if (!best) return null;
    const confident = best.score >= 0.6;
    /* Tepi terkunci → tarik sedikit ke dalam agar pita tipis latar tidak ikut (dihitamkan filter) */
    const inset = confident ? 0.992 : 1;
    const cx = best.quad.reduce((sum, p) => sum + p.x, 0) / 4;
    const cy = best.quad.reduce((sum, p) => sum + p.y, 0) / 4;
    return {
      corners: best.quad.map((p) => ({
        x: (cx + (p.x - cx) * inset) / scale,
        y: (cy + (p.y - cy) * inset) / scale,
      })),
      confident,
      score: best.score,
    };
  } finally {
    small.delete();
  }
}

/** Rata-rata keputihan pita 4–12 px di luar garis sisi; rendah = benar-benar latar. */
function outsideWhiteness(data, width, height, line, a, b, normal) {
  let sum = 0;
  let count = 0;
  for (let k = 0; k < 24; k++) {
    const t = 0.1 + (0.8 * k) / 23;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const along = (q.x - line.p.x) * line.dir.x + (q.y - line.p.y) * line.dir.y;
    const onLine = { x: line.p.x + line.dir.x * along, y: line.p.y + line.dir.y * along };
    for (let d = 4; d <= 12; d += 2) {
      sum += pixelWhiteness(data, width, height, onLine.x + normal.x * d, onLine.y + normal.y * d);
      count++;
    }
  }
  return count ? sum / count : 1;
}

function intersectLines(l1, l2) {
  const det = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(det) < 1e-6) return null;
  const dx = l2.p.x - l1.p.x;
  const dy = l2.p.y - l1.p.y;
  const t = (dx * l2.dir.y - dy * l2.dir.x) / det;
  return { x: l1.p.x + l1.dir.x * t, y: l1.p.y + l1.dir.y * t };
}

function quadArea(pts) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function isConvexQuad(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * @param {Uint8Array|Uint8ClampedArray} data RGBA
 * @param {Array<{x:number,y:number}>} corners dalam koordinat `data`
 * @returns {{corners: Array<{x:number,y:number}>, confident: boolean}}
 *   confident = keempat sisi menemukan tepi kertas yang jelas.
 */
function refineQuadEdges(data, width, height, corners) {
  const quad = orderPoints(corners);
  const center = {
    x: quad.reduce((s, p) => s + p.x, 0) / 4,
    y: quad.reduce((s, p) => s + p.y, 0) / 4,
  };
  const range = Math.max(6, Math.round(Math.max(width, height) * 0.035));
  const sampleCount = 48;
  const outset = 0.75;

  const lines = [];
  let fittedSides = 0;
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    let normal = { x: -dir.y, y: dir.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((mid.x - center.x) * normal.x + (mid.y - center.y) * normal.y < 0) {
      normal = { x: -normal.x, y: -normal.y };
    }

    const candidates = [];
    for (let k = 0; k < sampleCount; k++) {
      const t = 0.06 + (0.88 * k) / (sampleCount - 1);
      const origin = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      candidates.push(edgeCandidatesAlongNormal(data, width, height, origin, normal, range));
    }

    const fitted = ransacEdgeLine(candidates, sampleCount, 1.25);
    /* Garis tabel/bingkai tercetak juga memberi transisi tajam, tapi di luarnya masih kertas */
    if (fitted && outsideWhiteness(data, width, height, fitted, a, b, normal) < 0.45) fittedSides++;
    const line = fitted ?? { p: a, dir };
    lines.push({
      p: { x: line.p.x + normal.x * outset, y: line.p.y + normal.y * outset },
      dir: line.dir,
    });
  }

  const unchanged = { corners: quad, confident: false };
  const refined = [];
  for (let s = 0; s < 4; s++) {
    const pt = intersectLines(lines[(s + 3) % 4], lines[s]);
    if (!pt) return unchanged;
    refined.push(pt);
  }

  const maxShift = range * 1.6;
  if (refined.some((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > maxShift)) return unchanged;
  if (!isConvexQuad(refined)) return unchanged;
  const areaRatio = quadArea(refined) / Math.max(1, quadArea(quad));
  if (areaRatio < 0.8 || areaRatio > 1.25) return unchanged;

  return { corners: refined, confident: fittedSides === 4 };
}

/**
 * Presisikan sudut (koordinat penuh) ke tepi kertas — dipakai jalur kandidat sudut.
 * @returns {Promise<{corners: Array<{x:number,y:number}>, confident: boolean}>}
 */
export async function refineDocumentCorners(dataUrl, corners, maxSize = 900) {
  if (!corners || corners.length !== 4) return { corners, confident: false };
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const scaled = corners.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const refined = refineQuadEdges(data, width, height, scaled);
  return {
    corners: refined.corners.map((p) => ({ x: p.x / scale, y: p.y / scale })),
    confident: refined.confident,
  };
}

function warpDocument(cv, src, corners, maxOutputSize) {
  const [tl, tr, br, bl] = orderPoints(corners);
  const maxWidth = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const maxHeight = Math.round(Math.max(dist(tl, bl), dist(tr, br)));

  if (maxWidth < 40 || maxHeight < 40) return null;

  const scale = Math.min(1, maxOutputSize / Math.max(maxWidth, maxHeight));
  const destW = Math.max(1, Math.round(maxWidth * scale));
  const destH = Math.max(1, Math.round(maxHeight * scale));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, destW, 0, destW, destH, 0, destH,
  ]);

  const transform = cv.getPerspectiveTransform(srcTri, dstTri);
  const warped = new cv.Mat();

  cv.warpPerspective(
    src,
    warped,
    transform,
    new cv.Size(destW, destH),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255),
  );

  srcTri.delete();
  dstTri.delete();
  transform.delete();

  return warped;
}

async function warpWithCorners(cv, src, corners, maxOutputSize) {
  const warped = warpDocument(cv, src, corners, maxOutputSize);
  if (!warped) return null;
  const dataUrl = matToDataUrl(cv, warped);
  warped.delete();
  return dataUrl;
}

/**
 * Deteksi kertas + perspective warp via OpenCV.
 * @param {string} originalDataUrl
 * @param {number} maxOutputSize
 * @param {Array<{x:number,y:number}>|null} externalCorners sudah dalam koordinat penuh
 */
export async function tryOpenCvDocumentWarp(originalDataUrl, maxOutputSize = 2200, externalCorners = null) {
  const result = await tryOpenCvDocumentWarpDetailed(originalDataUrl, maxOutputSize, externalCorners);
  return result?.dataUrl ?? null;
}

/**
 * Sama seperti tryOpenCvDocumentWarp, plus `confident` = tepi kertas hasil deteksi
 * otomatis terbukti kuat di keempat sisi (hasil warp tidak perlu di-trim lagi).
 * @returns {Promise<{dataUrl: string, confident: boolean, score: number|null, corners: Array<{x:number,y:number}>}|null>}
 */
export async function tryOpenCvDocumentWarpDetailed(
  originalDataUrl,
  maxOutputSize = 2200,
  externalCorners = null,
) {
  const cv = await loadOpenCv();
  const img = await loadImage(originalDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);

  const src = cv.imread(canvas);
  const maxAnalyze = 900;
  const analyzeScale = Math.min(1, maxAnalyze / Math.max(src.cols, src.rows));

  let analyzeMat = src;
  let scaledMat = null;

  if (analyzeScale < 1) {
    scaledMat = new cv.Mat();
    cv.resize(
      src,
      scaledMat,
      new cv.Size(0, 0),
      analyzeScale,
      analyzeScale,
      cv.INTER_AREA,
    );
    analyzeMat = scaledMat;
  }

  try {
    let corners = externalCorners;
    let confident = false;
    let score = null;
    if (!corners) {
      const selected = selectPaperQuad(cv, src, () => detectQuadContour(cv, analyzeMat, analyzeScale));
      if (selected) ({ corners, confident, score } = selected);
    }

    if (!corners) return null;

    const dataUrl = await warpWithCorners(cv, src, corners, maxOutputSize);
    return dataUrl ? { dataUrl, confident, score, corners } : null;
  } finally {
    if (scaledMat) scaledMat.delete();
    src.delete();
  }
}
