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
  const maxW = Math.max(wTop, wBottom);
  const maxH = Math.max(hLeft, hRight);

  if (minW < 40 || minH < 40) return -1;

  const area = Math.abs(
    (tl.x * tr.y - tr.x * tl.y) +
      (tr.x * br.y - br.x * tr.y) +
      (br.x * bl.y - bl.x * br.y) +
      (bl.x * tl.y - tl.x * bl.y),
  ) / 2;
  const areaRatio = area / imageArea;
  if (areaRatio < 0.12 || areaRatio > 0.94) return -1;

  const aspect = minW / minH;
  if (aspect < 0.25 || aspect > 4.5) return -1;

  const parallelScore =
    1 - Math.abs(wTop - wBottom) / Math.max(wTop, wBottom) +
    (1 - Math.abs(hLeft - hRight) / Math.max(hLeft, hRight));

  return areaRatio * 0.55 + parallelScore * 0.25 + (1 - areaRatio) * 0.2;
}

function detectQuadContour(cv, mat, scale) {
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  const imageArea = mat.rows * mat.cols;
  let best = null;
  let bestScore = -1;
  const cannyPairs = [
    [30, 90],
    [50, 150],
    [75, 200],
  ];
  const retrievalModes = [cv.RETR_EXTERNAL, cv.RETR_LIST];

  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    for (const [low, high] of cannyPairs) {
      cv.Canny(blur, edges, low, high);
      cv.dilate(edges, closed, kernel);

      for (const mode of retrievalModes) {
        cv.findContours(closed, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          const area = cv.contourArea(contour);
          if (area < imageArea * 0.1 || area > imageArea * 0.96) continue;

          const peri = cv.arcLength(contour, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, 0.02 * peri, true);

          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const points = extractQuadPoints(cv, approx, scale);
            const score = scoreQuad(points, imageArea / (scale * scale));
            if (score > bestScore) {
              bestScore = score;
              best = points;
            }
          }
          approx.delete();
        }
      }
    }

    return best;
  } finally {
    gray.delete();
    blur.delete();
    edges.delete();
    kernel.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
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
