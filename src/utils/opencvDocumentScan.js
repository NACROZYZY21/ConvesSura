import { loadOpenCv } from './opencvLoader.js';
import { orderCorners } from './documentScan.js';

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
function scanForQuads(cv, binary, imageArea, scale) {
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
            const points = extractQuadPoints(cv, approx, scale);
            const score = scoreQuad(points, imageArea / (scale * scale));
            if (score > 0) candidates.push({ corners: points, score });
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
function detectQuadContour(cv, mat, scale) {
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

        allCandidates.push(...scanForQuads(cv, closed, imageArea, scale));

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

    allCandidates.push(...scanForQuads(cv, otsuClosed, imageArea, scale));

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

    allCandidates.push(...scanForQuads(cv, otsuDilated, imageArea, scale));

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

        allCandidates.push(...scanForQuads(cv, blueClosed, imageArea, scale));

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
    if (!corners) {
      corners = detectQuadContour(cv, analyzeMat, analyzeScale);
    }

    if (!corners) return null;

    return warpWithCorners(cv, src, corners, maxOutputSize);
  } finally {
    if (scaledMat) scaledMat.delete();
    src.delete();
  }
}
