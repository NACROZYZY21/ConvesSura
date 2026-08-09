function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function orderCorners(points) {
  const sorted = [...points];
  let tl = sorted[0];
  let tr = sorted[0];
  let br = sorted[0];
  let bl = sorted[0];

  for (const p of sorted) {
    const sum = p.x + p.y;
    const diff = p.x - p.y;
    if (sum < tl.x + tl.y) tl = p;
    if (sum > br.x + br.y) br = p;
    if (diff > tr.x - tr.y) tr = p;
    if (diff < bl.x - bl.y) bl = p;
  }

  return [tl, tr, br, bl];
}

function colorDist(r1, g1, b1, r2, g2, b2) {
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

export function sampleImageCornerBackground(data, width, height, sampleSize = 12) {
  const size = Math.max(4, Math.min(sampleSize, Math.round(Math.min(width, height) * 0.06)));
  const regions = [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const [sx, sy] of regions) {
    for (let y = sy; y < sy + size; y++) {
      for (let x = sx; x < sx + size; x++) {
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }
  }

  return { r: r / count, g: g / count, b: b / count };
}

export function buildContentMask(data, width, height, bg, threshold = 22) {
  const bgLum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
  let mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const diff = colorDist(r, g, b, bg.r, bg.g, bg.b);
      const tintedForm = b > r + 4 && b > g + 1 && lum > 95;
      if (diff > threshold || Math.abs(lum - bgLum) > threshold * 0.85 || tintedForm) {
        mask[y * width + x] = 1;
      }
    }
  }

  mask = closeMask(mask, width, height, 4);
  return mask;
}

function isContentPixel(data, gray, width, x, y, bg, threshold = 20) {
  const i = (y * width + x) * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const lum = gray[y * width + x];
  const bgLum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
  const diff = colorDist(r, g, b, bg.r, bg.g, bg.b);
  const blueForm = b > r + 4 && b > g + 1 && lum > 88 && lum < 245;
  const greenForm = g > r + 5 && g >= b - 3 && lum > 85 && lum < 245;
  return blueForm || greenForm || diff > threshold || Math.abs(lum - bgLum) > threshold * 0.85;
}

function rowDocRatio(data, gray, width, left, right, y, bg, threshold = 18) {
  if (right <= left) return 0;
  let count = 0;
  for (let x = left; x <= right; x++) {
    if (isContentPixel(data, gray, width, x, y, bg, threshold)) count++;
  }
  return count / (right - left + 1);
}

export function refineCornersWithColorDiff(data, gray, width, height, bg) {
  const bandY0 = Math.round(height * 0.04);
  const bandY1 = Math.round(height * 0.96);
  const bandX0 = Math.round(width * 0.04);
  const bandX1 = Math.round(width * 0.96);

  const colRatio = (x) => {
    let count = 0;
    for (let y = bandY0; y <= bandY1; y++) {
      if (isContentPixel(data, gray, width, x, y, bg)) count++;
    }
    return count / (bandY1 - bandY0 + 1);
  };

  const rowRatio = (y) => {
    let count = 0;
    for (let x = bandX0; x <= bandX1; x++) {
      if (isContentPixel(data, gray, width, x, y, bg)) count++;
    }
    return count / (bandX1 - bandX0 + 1);
  };

  let left = 0;
  let right = width - 1;
  let top = 0;
  let bottom = height - 1;

  for (let x = 0; x < width; x++) {
    if (colRatio(x) >= 0.38) {
      left = x;
      break;
    }
  }
  for (let x = width - 1; x >= 0; x--) {
    if (colRatio(x) >= 0.38) {
      right = x;
      break;
    }
  }
  for (let y = 0; y < height; y++) {
    if (rowRatio(y) >= 0.24) {
      top = y;
      break;
    }
  }

  const minBottomY = top + Math.round(height * 0.18);
  for (let y = height - 1; y >= minBottomY; y--) {
    if (rowDocRatio(data, gray, width, left, right, y, bg) >= 0.52) {
      bottom = y;
      break;
    }
  }

  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function isFullFrameCorners(corners, width, height) {
  const [tl, tr, br, bl] = corners;
  const area = Math.abs(
    (tl.x * tr.y - tr.x * tl.y) +
      (tr.x * br.y - br.x * tr.y) +
      (br.x * bl.y - bl.x * br.y) +
      (bl.x * tl.y - tl.x * bl.y),
  ) / 2;
  return area / (width * height) > 0.92;
}

function validateCornerGeometry(corners, width, height) {
  const [tl, tr, br, bl] = orderCorners(corners);
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;

  if (cx < width * 0.12 || cx > width * 0.88) return false;
  if (cy < height * 0.08 || cy > height * 0.92) return false;
  if (tl.y >= bl.y - height * 0.12) return false;
  if (tl.x >= tr.x - width * 0.12) return false;

  const wTop = dist(tl, tr);
  const wBottom = dist(bl, br);
  if (Math.min(wTop, wBottom) < width * 0.18) return false;

  return true;
}

function scoreCornerSet(corners, width, height) {
  if (!corners || isFullFrameCorners(corners, width, height)) return -1;
  if (!validateCornerGeometry(corners, width, height)) return -1;

  const [tl, tr, br, bl] = orderCorners(corners);
  const area = polygonArea(corners);
  const areaRatio = area / (width * height);
  if (areaRatio < 0.1 || areaRatio > 0.92) return -1;

  const wTop = dist(tl, tr);
  const wBottom = dist(bl, br);
  const hLeft = dist(tl, bl);
  const hRight = dist(tr, br);
  if (Math.min(wTop, wBottom) < width * 0.22) return -1;
  if (Math.min(hLeft, hRight) < height * 0.18) return -1;

  const parallel =
    (1 - Math.abs(wTop - wBottom) / Math.max(wTop, wBottom)) * 0.5 +
    (1 - Math.abs(hLeft - hRight) / Math.max(hLeft, hRight)) * 0.5;

  const skewRatio = Math.abs(wTop - wBottom) / Math.max(wTop, wBottom);
  const trapezoidBonus = skewRatio > 0.035 && skewRatio < 0.45 ? 0.12 : 0;
  const axisAligned =
    Math.abs(tl.y - tr.y) < 3 &&
    Math.abs(bl.y - br.y) < 3 &&
    Math.abs(tl.x - bl.x) < 3 &&
    Math.abs(tr.x - br.x) < 3;
  const axisPenalty = axisAligned && skewRatio < 0.02 ? -0.08 : 0;

  const idealArea = areaRatio >= 0.22 && areaRatio <= 0.82 ? 1 : 0.5;
  const marginPenalty =
    (tl.x + tl.y) / (width + height) +
    (width - tr.x + tr.y) / (width + height) +
    (width - br.x + height - br.y) / (width + height) +
    (bl.x + height - bl.y) / (width + height);

  return areaRatio * 0.35 + parallel * 0.35 + idealArea * 0.2 + trapezoidBonus + axisPenalty - marginPenalty * 0.02;
}

function paperThreshold(bgLum) {
  if (bgLum < 105) return Math.max(90, bgLum + 10);
  if (bgLum < 140) return Math.max(112, bgLum + 16);
  return Math.max(125, bgLum + 22);
}

function isPaperLike(lum, bgLum) {
  return lum >= paperThreshold(bgLum);
}

function isolateMainPaperBlob(mask, width, height) {
  const eroded = erodeMask(mask, width, height, 5);
  let bestBox = null;
  let bestSize = 0;
  const visited = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!eroded[start] || visited[start]) continue;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let size = 0;
      const queue = [start];
      visited[start] = 1;

      for (let qi = 0; qi < queue.length; qi++) {
        const i = queue[qi];
        size++;
        const cx = i % width;
        const cy = (i / width) | 0;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        if (cx > 0) {
          const ni = i - 1;
          if (eroded[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
        if (cx < width - 1) {
          const ni = i + 1;
          if (eroded[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
        if (cy > 0) {
          const ni = i - width;
          if (eroded[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
        if (cy < height - 1) {
          const ni = i + width;
          if (eroded[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      if (size > bestSize) {
        bestSize = size;
        bestBox = { minX, minY, maxX, maxY };
      }
    }
  }

  if (!bestBox || bestSize < width * height * 0.04) return mask;

  const out = new Uint8Array(width * height);
  const pad = 3;
  const x0 = Math.max(0, bestBox.minX - pad);
  const y0 = Math.max(0, bestBox.minY - pad);
  const x1 = Math.min(width - 1, bestBox.maxX + pad);
  const y1 = Math.min(height - 1, bestBox.maxY + pad);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask[y * width + x]) out[y * width + x] = 1;
    }
  }

  return closeMask(out, width, height, 2);
}

function columnPaperRatio(gray, width, height, x, y0, y1, bgLum) {
  let count = 0;
  const total = y1 - y0 + 1;
  for (let y = y0; y <= y1; y++) {
    if (isPaperLike(gray[y * width + x], bgLum)) count++;
  }
  return count / total;
}

function rowPaperRatio(gray, width, height, y, x0, x1, bgLum) {
  let count = 0;
  const total = x1 - x0 + 1;
  for (let x = x0; x <= x1; x++) {
    if (isPaperLike(gray[y * width + x], bgLum)) count++;
  }
  return count / total;
}

function findLeftPaperEdge(gray, width, height, bgLum) {
  const y0 = Math.round(height * 0.06);
  const y1 = Math.round(height * 0.94);
  for (let x = 0; x < width; x++) {
    if (columnPaperRatio(gray, width, height, x, y0, y1, bgLum) >= 0.52) return x;
  }
  return 0;
}

function findRightPaperEdge(gray, width, height, bgLum) {
  const y0 = Math.round(height * 0.06);
  const y1 = Math.round(height * 0.94);
  for (let x = width - 1; x >= 0; x--) {
    if (columnPaperRatio(gray, width, height, x, y0, y1, bgLum) >= 0.72) return x;
  }
  return width - 1;
}

function findTopAtColumn(gray, width, height, x, bgLum, xSpread = 10) {
  const x0 = Math.max(0, x - xSpread);
  const x1 = Math.min(width - 1, x + xSpread);
  const maxY = Math.round(height * 0.55);
  for (let y = 0; y <= maxY; y++) {
    if (rowPaperRatio(gray, width, height, y, x0, x1, bgLum) >= 0.42) return y;
  }
  return 0;
}

function findBottomAtColumn(gray, width, height, x, bgLum, xSpread = 12) {
  const x0 = Math.max(0, x - xSpread);
  const x1 = Math.min(width - 1, x + xSpread);
  const minY = Math.round(height * 0.18);
  for (let y = height - 1; y >= minY; y--) {
    if (rowPaperRatio(gray, width, height, y, x0, x1, bgLum) >= 0.38) return y;
  }
  return height - 1;
}

export function refineDetectedQuad(gray, width, height, bgLum, corners) {
  const [tl0, tr0, br0, bl0] = orderCorners(corners);
  const leftX = Math.min(tl0.x, bl0.x);
  let rightX = Math.max(tr0.x, br0.x);

  const tightRight = findRightPaperEdge(gray, width, height, bgLum);
  if (tightRight < rightX) rightX = tightRight;

  const bottomLeft = Math.max(findBottomAtColumn(gray, width, height, leftX, bgLum), bl0.y);
  const bottomRight = Math.max(findBottomAtColumn(gray, width, height, rightX, bgLum), br0.y);

  return [
    { x: leftX, y: tl0.y },
    { x: rightX, y: tr0.y },
    { x: rightX, y: Math.max(bottomRight, br0.y) },
    { x: leftX, y: Math.max(bottomLeft, bl0.y) },
  ];
}

function pushCornerCandidate(list, corners, width, height) {
  if (!corners) return;
  const score = scoreCornerSet(corners, width, height);
  if (score <= 0) return;
  list.push({ corners, score });
}

export function collectCornerCandidates(data, gray, width, height) {
  const bg = sampleImageCornerBackground(data, width, height);
  const bgLum = sampleBorderLuminance(gray, width, height);
  const candidates = [];

  for (const threshold of [14, 18, 22, 28, 34, 42]) {
    const mask = buildContentMask(data, width, height, bg, threshold);
    const detected = findDocumentCorners(mask, width, height);
    if (detected) {
      const refined = refineDetectedQuad(gray, width, height, bgLum, detected);
      pushCornerCandidate(
        candidates,
        outsetCorners(refined, 0.022),
        width,
        height,
      );
    }
  }

  const paperMask = buildPaperMask(gray, width, height, bgLum);
  const paperDetected = findDocumentCorners(paperMask, width, height);
  if (paperDetected) {
    const refined = refineDetectedQuad(gray, width, height, bgLum, paperDetected);
    pushCornerCandidate(candidates, outsetCorners(refined, 0.022), width, height);
    pushCornerCandidate(candidates, outsetCorners(paperDetected, 0.018), width, height);
  }

  pushCornerCandidate(
    candidates,
    outsetCorners(refineCornersWithColorDiff(data, gray, width, height, bg), 0.035),
    width,
    height,
  );

  const box = refineCornersWithColorDiff(data, gray, width, height, bg);
  if (!isFullFrameCorners(box, width, height) && validateCornerGeometry(box, width, height)) {
    const areaRatio = polygonArea(box) / (width * height);
    if (areaRatio >= 0.08) {
      candidates.push({ corners: outsetCorners(box, 0.03), score: areaRatio * 0.6 });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const unique = [];
  for (const item of candidates) {
    const dup = unique.some((u) => {
      const d =
        Math.abs(u.corners[0].x - item.corners[0].x) +
        Math.abs(u.corners[0].y - item.corners[0].y) +
        Math.abs(u.corners[2].x - item.corners[2].x) +
        Math.abs(u.corners[2].y - item.corners[2].y);
      return d < Math.min(width, height) * 0.04;
    });
    if (!dup) unique.push(item);
  }

  return unique;
}

export function detectCornersFromAnalysis(data, gray, width, height) {
  const candidates = collectCornerCandidates(data, gray, width, height);
  return candidates[0]?.corners ?? null;
}

function sampleBorderLuminance(gray, width, height) {
  const samples = [];
  const strip = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < strip; y++) samples.push(gray[y * width + x]);
    for (let y = height - strip; y < height; y++) samples.push(gray[y * width + x]);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function dilateMask(mask, width, height, radius) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            out[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function erodeMask(mask, width, height, radius) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      let keep = true;
      for (let dy = -radius; dy <= radius && keep; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) {
            keep = false;
            break;
          }
        }
      }
      if (keep) out[y * width + x] = 1;
    }
  }
  return out;
}

function closeMask(mask, width, height, radius = 2) {
  return erodeMask(dilateMask(mask, width, height, radius), width, height, radius);
}

export function buildPaperMask(gray, width, height, bgLum) {
  const threshold = paperThreshold(bgLum);
  let mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] > threshold) {
        mask[y * width + x] = 1;
      }
    }
  }

  mask = closeMask(mask, width, height, 3);
  mask = isolateMainPaperBlob(mask, width, height);
  return mask;
}

function getBoundaryPoints(mask, width, height) {
  const marginX = Math.max(2, Math.round(width * 0.015));
  const marginY = Math.max(2, Math.round(height * 0.015));
  const points = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;

      const isEdge = !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width];
      if (!isEdge) continue;
      if (x < marginX || x > width - 1 - marginX || y < marginY || y > height - 1 - marginY) continue;

      points.push({ x, y });
    }
  }

  return points;
}

function pickCorner(points, predicate, score) {
  const filtered = points.filter(predicate);
  if (!filtered.length) return null;

  return filtered.reduce((best, point) => (score(point) < score(best) ? point : best));
}

function isConvexQuad(corners) {
  let sign = 0;

  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }

  return sign !== 0;
}

export function insetCorners(corners, insetRatio = 0.006) {
  const cx = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
  const cy = corners.reduce((sum, point) => sum + point.y, 0) / corners.length;

  return corners.map((point) => ({
    x: point.x + (cx - point.x) * insetRatio,
    y: point.y + (cy - point.y) * insetRatio,
  }));
}

export function outsetCorners(corners, outsetRatio = 0.028) {
  const cx = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
  const cy = corners.reduce((sum, point) => sum + point.y, 0) / corners.length;

  return corners.map((point) => ({
    x: point.x + (point.x - cx) * outsetRatio,
    y: point.y + (point.y - cy) * outsetRatio,
  }));
}

function isPaperPixel(lum, bgLum) {
  const threshold = Math.max(115, bgLum + 15);
  return lum > threshold;
}

function findPaperEdge(gray, width, height, bgLum, side) {
  const rowRatio = (y) => {
    let paper = 0;
    for (let x = 0; x < width; x++) {
      if (isPaperPixel(gray[y * width + x], bgLum)) paper++;
    }
    return paper / width;
  };

  const colRatio = (x) => {
    let paper = 0;
    for (let y = 0; y < height; y++) {
      if (isPaperPixel(gray[y * width + x], bgLum)) paper++;
    }
    return paper / height;
  };

  const minCol = 0.72;
  const minRow = 0.28;

  if (side === 'left') {
    for (let x = 0; x < width; x++) {
      if (colRatio(x) >= minCol) return x;
    }
    return 0;
  }

  if (side === 'right') {
    for (let x = width - 1; x >= 0; x--) {
      if (colRatio(x) >= minCol) return x;
    }
    return width - 1;
  }

  if (side === 'top') {
    for (let y = 0; y < height; y++) {
      if (rowRatio(y) >= minRow) return y;
    }
    return 0;
  }

  for (let y = height - 1; y >= 0; y--) {
    if (rowRatio(y) >= minRow) return y;
  }
  return height - 1;
}

function findTightPaperEdge(gray, width, height, bgLum, side) {
  const bandY0 = Math.round(height * 0.06);
  const bandY1 = Math.round(height * 0.94);

  const colRatio = (x) => {
    let paper = 0;
    const total = bandY1 - bandY0 + 1;
    for (let y = bandY0; y <= bandY1; y++) {
      if (isPaperPixel(gray[y * width + x], bgLum)) paper++;
    }
    return paper / total;
  };

  const isCleanLeftEdge = (x) => {
    const lums = [];
    for (let y = bandY0; y <= bandY1; y++) lums.push(gray[y * width + x]);
    lums.sort((a, b) => a - b);
    const p10 = lums[Math.floor(lums.length * 0.1)];
    const med = lums[Math.floor(lums.length * 0.5)];
    return colRatio(x) >= 0.88 && p10 >= 185 && med >= 198;
  };

  if (side === 'left') {
    for (let x = 0; x < width; x++) {
      if (isCleanLeftEdge(x)) return x;
    }
    return 0;
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colRatio(x) >= 0.9) return x;
  }
  return width - 1;
}

function findTightBottomEdge(gray, width, height) {
  const bandX0 = Math.round(width * 0.12);
  const bandX1 = Math.round(width * 0.88);

  for (let y = height - 1; y >= 0; y--) {
    const lums = [];
    for (let x = bandX0; x <= bandX1; x++) lums.push(gray[y * width + x]);
    lums.sort((a, b) => a - b);
    const med = lums[Math.floor(lums.length * 0.5)];
    if (med >= 170) return y;
  }

  return height - 1;
}

export function refineCornersWithEdges(gray, width, height, corners, bgLum) {
  const [tl, tr, br, bl] = corners;
  const left = findTightPaperEdge(gray, width, height, bgLum, 'left');
  const right = findTightPaperEdge(gray, width, height, bgLum, 'right');
  const top = findPaperEdge(gray, width, height, bgLum, 'top');
  const bottom = findTightBottomEdge(gray, width, height);
  const padX = 0;
  const padY = 1;

  return [
    { x: left + padX, y: Math.max(tl.y, top + padY) },
    { x: right - padX, y: Math.max(tr.y, top + padY) },
    { x: right - padX, y: Math.min(br.y, bottom - padY) },
    { x: left + padX, y: Math.min(bl.y, bottom - padY) },
  ];
}

export function findDocumentCorners(mask, width, height) {
  const boundary = getBoundaryPoints(mask, width, height);
  if (boundary.length < 25) return null;

  const tl = pickCorner(
    boundary,
    (p) => p.x < width * 0.48 && p.y < height * 0.48,
    (p) => p.x + p.y,
  );
  const tr = pickCorner(
    boundary,
    (p) => p.x > width * 0.52 && p.y < height * 0.48,
    (p) => -p.x + p.y,
  );
  const br = pickCorner(
    boundary,
    (p) => p.x > width * 0.48 && p.y > height * 0.52,
    (p) => -(p.x + p.y),
  );
  const bl = pickCorner(
    boundary,
    (p) => p.x < width * 0.52 && p.y > height * 0.52,
    (p) => p.x - p.y,
  );

  if (!tl || !tr || !br || !bl) return null;

  const corners = [tl, tr, br, bl];
  if (!isConvexQuad(corners)) return null;

  const area = polygonArea(corners);
  const imageArea = width * height;

  if (area / imageArea < 0.1 || area / imageArea > 0.96) return null;

  const wTop = dist(corners[0], corners[1]);
  const wBottom = dist(corners[3], corners[2]);
  const hLeft = dist(corners[0], corners[3]);
  const hRight = dist(corners[1], corners[2]);

  if (Math.min(wTop, wBottom) < width * 0.18) return null;
  if (Math.min(hLeft, hRight) < height * 0.15) return null;

  return corners;
}

function polygonArea(corners) {
  let area = 0;
  for (let i = 0; i < corners.length; i++) {
    const j = (i + 1) % corners.length;
    area += corners[i].x * corners[j].y - corners[j].x * corners[i].y;
  }
  return Math.abs(area) / 2;
}

function solveLinearSystem(a, b) {
  const n = b.length;
  const m = a.map((row, index) => [...row, b[index]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const div = m[col][col];
    if (Math.abs(div) < 1e-8) return null;

    for (let j = col; j <= n; j++) m[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
    }
  }

  return m.map((row) => row[n]);
}

function getPerspectiveTransform(srcQuad, dstQuad) {
  const a = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const u = dstQuad[i * 2];
    const v = dstQuad[i * 2 + 1];
    const sx = srcQuad[i * 2];
    const sy = srcQuad[i * 2 + 1];

    a.push([u, v, 1, 0, 0, 0, -u * sx, -v * sx]);
    b.push(sx);
    a.push([0, 0, 0, u, v, 1, -u * sy, -v * sy]);
    b.push(sy);
  }

  const h = solveLinearSystem(a, b);
  if (!h) return null;

  return [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], 1,
  ];
}

function applyHomography(h, x, y) {
  const denom = h[6] * x + h[7] * y + h[8];
  if (Math.abs(denom) < 1e-8) return null;
  return [(h[0] * x + h[1] * y + h[2]) / denom, (h[3] * x + h[4] * y + h[5]) / denom];
}

function bilinearSample(data, width, height, x, y) {
  x = Math.max(0, Math.min(width - 1.001, x));
  y = Math.max(0, Math.min(height - 1.001, y));

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const idx = (px, py) => (py * width + px) * 4;
  const out = [0, 0, 0, 255];

  for (let c = 0; c < 3; c++) {
    const v00 = data[idx(x0, y0) + c];
    const v10 = data[idx(x1, y0) + c];
    const v01 = data[idx(x0, y1) + c];
    const v11 = data[idx(x1, y1) + c];
    out[c] = Math.round(
      v00 * (1 - tx) * (1 - ty) +
        v10 * tx * (1 - ty) +
        v01 * (1 - tx) * ty +
        v11 * tx * ty,
    );
  }

  return out;
}

function countFilledPixels(data) {
  let filled = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] > 60) filled++;
  }
  return filled;
}

export function cleanWarpCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const paper = [252, 251, 248];
  const margin = Math.max(3, Math.round(Math.min(width, height) * 0.035));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const inMargin = x < margin || x >= width - margin || y < margin || y >= height - margin;

      if (lum < 40 || (inMargin && lum < 120)) {
        data[i] = paper[0];
        data[i + 1] = paper[1];
        data[i + 2] = paper[2];
      }
    }
  }

  const isFringe = (x, y) => {
    const i = (y * width + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    return (lum > 55 && lum < 210 && sat < 42) || (lum < 175 && sat < 55);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < margin; x++) {
      if (!isFringe(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = paper[0];
      data[i + 1] = paper[1];
      data[i + 2] = paper[2];
    }
    for (let x = width - margin; x < width; x++) {
      if (!isFringe(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = paper[0];
      data[i + 1] = paper[1];
      data[i + 2] = paper[2];
    }
  }

  for (let y = 0; y < margin; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFringe(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = paper[0];
      data[i + 1] = paper[1];
      data[i + 2] = paper[2];
    }
  }

  for (let y = height - margin; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFringe(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = paper[0];
      data[i + 1] = paper[1];
      data[i + 2] = paper[2];
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export function perspectiveWarpCanvas(sourceCanvas, corners, sourceDataUrl, maxOutputSize = 1400) {
  const [tl, tr, br, bl] = orderCorners(corners);
  const outWidth = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const outHeight = Math.round(Math.max(dist(tl, bl), dist(tr, br)));

  if (outWidth < 40 || outHeight < 40) return null;

  const scale = Math.min(1, maxOutputSize / Math.max(outWidth, outHeight));
  const destW = Math.max(1, Math.round(outWidth * scale));
  const destH = Math.max(1, Math.round(outHeight * scale));

  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const dst = [0, 0, destW, 0, destW, destH, 0, destH];
  const src = [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y];
  const h = getPerspectiveTransform(src, dst);
  if (!h) return null;

  const destCanvas = document.createElement('canvas');
  destCanvas.width = destW;
  destCanvas.height = destH;
  const destCtx = destCanvas.getContext('2d');
  const destImage = destCtx.createImageData(destW, destH);

  for (let y = 0; y < destH; y++) {
    for (let x = 0; x < destW; x++) {
      const mapped = applyHomography(h, x, y);
      if (!mapped) continue;
      const color = bilinearSample(srcData, srcW, srcH, mapped[0], mapped[1]);
      if (!color) continue;
      const i = (y * destW + x) * 4;
      destImage.data[i] = color[0];
      destImage.data[i + 1] = color[1];
      destImage.data[i + 2] = color[2];
      destImage.data[i + 3] = 255;
    }
  }

  destCtx.putImageData(destImage, 0, 0);
  cleanWarpCanvas(destCanvas);

  const cleanedData = destCtx.getImageData(0, 0, destW, destH).data;
  const filledRatio = countFilledPixels(cleanedData) / (destW * destH);
  if (filledRatio < 0.55) return null;

  return destCanvas.toDataURL('image/png');
}
