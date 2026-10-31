/* ───────────────────────────────────────────────────────────
   paperQuad — kandidat & penilaian quad kertas

   Kandidat dikumpulkan dari beberapa sumber (mask "area putih"
   dengan beberapa ambang + garis lurus Hough), lalu dinilai
   dengan bukti tepi di sepanjang keliling: tepi kertas asli
   tajam & lurus di keempat sisi, sedangkan bayangan, halaman
   tertekuk, atau garis tabel/teks di dalam kertas tidak.
   ─────────────────────────────────────────────────────────── */

export function orderQuad(pts) {
  const c = {
    x: pts.reduce((s, p) => s + p.x, 0) / 4,
    y: pts.reduce((s, p) => s + p.y, 0) / 4,
  };
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x),
  );
  let start = 0;
  sorted.forEach((p, i) => {
    if (p.x + p.y < sorted[start].x + sorted[start].y) start = i;
  });
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

function colorAt(data, width, height, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null;
  const i = (yi * width + xi) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function luminance(c) {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

function saturation(c) {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

export function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Luminance kertas acuan: persentil-80 piksel netral di area tengah foto. */
export function estimatePaperLum(data, width, height) {
  const vals = [];
  for (let y = Math.floor(height * 0.25); y < height * 0.75; y += 2) {
    for (let x = Math.floor(width * 0.25); x < width * 0.75; x += 2) {
      const c = colorAt(data, width, height, x, y);
      if (saturation(c) < 40) vals.push(luminance(c));
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length * 0.8)] : 200;
}

/**
 * Bukti tepi per sisi (0..1). Pita 2–8 px di dalam vs di luar sisi dibandingkan;
 * garis tabel/teks tipis tidak lolos karena kedua pitanya sama-sama kertas.
 */
function sideSupport(data, width, height, quad, paperLum, samples) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const result = [];

  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((mx - cx) * n.x + (my - cy) * n.y < 0) n = { x: -n.x, y: -n.y };

    let hit = 0;
    for (let k = 0; k < samples; k++) {
      const t = 0.05 + (0.9 * k) / (samples - 1);
      const o = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      let best = 0;
      let outside = false;

      for (let off = -3; off <= 3; off++) {
        const inn = [0, 0, 0];
        const out = [0, 0, 0];
        let ni = 0;
        let no = 0;
        for (let w = 2; w <= 8; w++) {
          const ci = colorAt(data, width, height, o.x + n.x * (off - w), o.y + n.y * (off - w));
          const co = colorAt(data, width, height, o.x + n.x * (off + w), o.y + n.y * (off + w));
          if (ci) {
            inn[0] += ci[0];
            inn[1] += ci[1];
            inn[2] += ci[2];
            ni++;
          }
          if (co) {
            out[0] += co[0];
            out[1] += co[1];
            out[2] += co[2];
            no++;
          }
        }
        if (!ni) continue;
        if (!no) {
          outside = true;
          continue;
        }
        const innMean = [inn[0] / ni, inn[1] / ni, inn[2] / ni];
        const outMean = [out[0] / no, out[1] / no, out[2] / no];
        const diff = Math.hypot(innMean[0] - outMean[0], innMean[1] - outMean[1], innMean[2] - outMean[2]);
        if (diff <= 25) continue;
        /* Luar masih mirip kertas tapi lebih gelap (mis. di balik baris teks) → bukti setengah.
           Latar terang (lantai putih) di luar formulir berwarna tetap bukti penuh. */
        const outerIsInk =
          luminance(outMean) >= paperLum - 30 &&
          saturation(outMean) < 30 &&
          luminance(outMean) < luminance(innMean);
        best = Math.max(best, outerIsInk ? 0.5 : 1);
      }

      if (best > 0) hit += best;
      else if (outside) hit += 0.5;
    }
    result.push(hit / samples);
  }
  return result;
}

function isPaperLike(c) {
  return luminance(c) > 100 && saturation(c) < 70;
}

function quadPoint(q, u, v) {
  return {
    x: (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x),
    y: (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y),
  };
}

/** Porsi isi quad yang tampak seperti kertas (terang & tidak terlalu berwarna). */
function interiorPaperRatio(data, width, height, q) {
  let ok = 0;
  let total = 0;
  for (let u = 0.08; u < 0.93; u += 0.06) {
    for (let v = 0.08; v < 0.93; v += 0.06) {
      const { x, y } = quadPoint(q, u, v);
      const c = colorAt(data, width, height, x, y);
      if (!c) continue;
      total++;
      if (isPaperLike(c)) ok++;
    }
  }
  return total ? ok / total : 0;
}

/**
 * Pojok dokumen hampir selalu margin kertas. Quad yang pojoknya jatuh di latar
 * (mis. gabungan dengan halaman tertekuk) mendapat nilai rendah. Ambil pojok terburuk.
 */
function worstCornerPaperRatio(data, width, height, q) {
  const offsets = [0.04, 0.07, 0.1];
  let worst = 1;
  for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    let ok = 0;
    let total = 0;
    for (const du of offsets) {
      for (const dv of offsets) {
        const { x, y } = quadPoint(q, cu ? 1 - du : du, cv ? 1 - dv : dv);
        const c = colorAt(data, width, height, x, y);
        if (!c) continue;
        total++;
        if (isPaperLike(c)) ok++;
      }
    }
    if (total) worst = Math.min(worst, ok / total);
  }
  return worst;
}

/**
 * Geser tiap sisi sejajar ke dalam selama pita yang dilewati bukan kertas
 * (mis. strip batik/latar yang ikut masuk). Maksimal 18% dimensi gambar.
 */
export function tightenQuadSides(data, width, height, quad) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const maxShift = Math.max(width, height) * 0.18;
  const lines = [];

  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    let inward = { x: -dir.y, y: dir.x };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((cx - mx) * inward.x + (cy - my) * inward.y < 0) inward = { x: -inward.x, y: -inward.y };

    let shift = 0;
    for (let d = 1; d <= maxShift; d += 2) {
      let ok = 0;
      let total = 0;
      for (let k = 0; k < 30; k++) {
        const t = 0.15 + (0.7 * k) / 29;
        const c = colorAt(
          data,
          width,
          height,
          a.x + (b.x - a.x) * t + inward.x * d,
          a.y + (b.y - a.y) * t + inward.y * d,
        );
        if (!c) continue;
        total++;
        if (isPaperLike(c)) ok++;
      }
      if (total && ok / total >= 0.75) break;
      shift = d;
    }
    lines.push({ p: { x: a.x + inward.x * shift, y: a.y + inward.y * shift }, dir });
  }

  const out = [];
  for (let s = 0; s < 4; s++) {
    const pt = intersect(lines[(s + 3) % 4], lines[s]);
    if (!pt) return quad;
    out.push(pt);
  }
  return out;
}

/** Bentuk wajar kertas difoto: sudut dalam 45°–135°, tiap sisi ≥ 15% dimensi gambar. */
function isPlausibleShape(q, width, height) {
  const minSide = Math.min(width, height) * 0.15;
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    const ax = prev.x - cur.x;
    const ay = prev.y - cur.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (lb < minSide) return false;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (Math.abs(cos) > Math.cos((45 * Math.PI) / 180)) return false;
  }
  return true;
}

/**
 * @param {number} [samples] titik per sisi — kecil untuk penyaringan cepat
 * @returns {{score:number, sides:number[]}|null}
 */
export function scorePaperQuad(data, width, height, quad, paperLum, samples = 40) {
  if (!isConvexQuad(quad) || !isPlausibleShape(quad, width, height)) return null;
  const area = quadArea(quad) / (width * height);
  if (area < 0.08 || area > 0.995) return null;
  const sides = sideSupport(data, width, height, quad, paperLum, samples);
  const minSide = Math.min(...sides);
  const meanSide = sides.reduce((a, b) => a + b, 0) / 4;
  const inner = interiorPaperRatio(data, width, height, quad);
  const corner = worstCornerPaperRatio(data, width, height, quad);
  const score =
    (0.6 * minSide + 0.4 * meanSide) *
    Math.pow(area, 0.15) *
    Math.min(1, (inner / 0.9) ** 2) *
    Math.min(1, corner / 0.45);
  return { score, sides };
}

function contourQuads(cv, contour) {
  const out = [];
  const hull = new cv.Mat();
  cv.convexHull(contour, hull);
  const peri = cv.arcLength(hull, true);
  for (const eps of [0.01, 0.02, 0.03, 0.045, 0.06, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, eps * peri, true);
    if (approx.rows === 4) {
      const q = [];
      for (let j = 0; j < 4; j++) q.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      out.push(orderQuad(q));
    }
    approx.delete();
  }
  const rect = cv.minAreaRect(hull);
  out.push(orderQuad(cv.RotatedRect.points(rect).map((p) => ({ x: p.x, y: p.y }))));
  hull.delete();
  return out;
}

/**
 * Kandidat dari mask "piksel mirip kertas" dengan beberapa ambang (toleran bayangan).
 * Dikerjakan di setengah resolusi (morfologi mahal di wasm); sudut diperhalus belakangan.
 */
function maskQuadCandidates(cv, src, paperLum) {
  const half = new cv.Mat();
  cv.resize(src, half, new cv.Size(0, 0), 0.5, 0.5, cv.INTER_AREA);
  const width = half.cols;
  const height = half.rows;
  const total = width * height;
  const data = half.data;
  const lum = new Float32Array(total);
  const sat = new Float32Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    lum[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  half.delete();

  const quads = [];
  const mask = new cv.Mat(height, width, cv.CV_8UC1);
  const maskData = mask.data;
  const minDim = Math.min(width, height);
  const closeSize = Math.max(3, Math.round(minDim * 0.02)) | 1;
  const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeSize, closeSize));

  for (const [lumDrop, maxSat] of [[12, 25], [25, 30], [38, 38], [60, 32], [90, 28]]) {
    const minLum = paperLum - lumDrop;
    for (let p = 0; p < total; p++) maskData[p] = lum[p] >= minLum && sat[p] < maxSat ? 255 : 0;
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);

    for (const openFactor of [0.012, 0.03]) {
      const work = new cv.Mat();
      const openSize = Math.max(3, Math.round(minDim * openFactor)) | 1;
      const openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(openSize, openSize));
      cv.morphologyEx(mask, work, cv.MORPH_OPEN, openKernel);
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(work, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        if (cv.contourArea(c) >= total * 0.08) quads.push(...contourQuads(cv, c));
        c.delete();
      }
      contours.delete();
      hierarchy.delete();
      openKernel.delete();
      work.delete();
    }
  }

  closeKernel.delete();
  mask.delete();
  return quads.map((q) => q.map((p) => ({ x: p.x * 2, y: p.y * 2 })));
}

function lineFromSegment(x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const dir = { x: (x2 - x1) / len, y: (y2 - y1) / len };
  const nrm = { x: -dir.y, y: dir.x };
  return { p: { x: x1, y: y1 }, dir, nrm, rho: nrm.x * x1 + nrm.y * y1, len };
}

function intersect(l1, l2) {
  const det = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
  if (Math.abs(det) < 1e-6) return null;
  const dx = l2.p.x - l1.p.x;
  const dy = l2.p.y - l1.p.y;
  const t = (dx * l2.dir.y - dy * l2.dir.x) / det;
  return { x: l1.p.x + l1.dir.x * t, y: l1.p.y + l1.dir.y * t };
}

/** Gabungkan segmen segaris (sudut < ±4°, jarak < 8 px), urut total panjang. */
function clusterLines(lines) {
  lines.sort((a, b) => b.len - a.len);
  const out = [];
  for (const l of lines) {
    const match = out.find(
      (o) =>
        Math.abs(o.dir.x * l.dir.y - o.dir.y * l.dir.x) < 0.07 &&
        Math.abs(o.nrm.x * l.p.x + o.nrm.y * l.p.y - o.rho) < 8,
    );
    if (match) match.total += l.len;
    else out.push({ ...l, total: l.len });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** Kandidat dari pasangan garis lurus panjang (2 horizontal × 2 vertikal). */
function houghQuadCandidates(cv, src) {
  const width = src.cols;
  const height = src.rows;
  const minDim = Math.min(width, height);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const segments = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  cv.Canny(gray, edges, 40, 120);

  /* Kanal saturasi: tepi formulir berwarna muda di atas latar putih nyaris tak terlihat di gray */
  const sat = new cv.Mat(src.rows, src.cols, cv.CV_8UC1);
  const satData = sat.data;
  const srcData = src.data;
  for (let p = 0, i = 0; p < satData.length; p++, i += 4) {
    const r = srcData[i];
    const g = srcData[i + 1];
    const b = srcData[i + 2];
    satData[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const satEdges = new cv.Mat();
  cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
  cv.Canny(sat, satEdges, 20, 60);
  cv.bitwise_or(edges, satEdges, edges);
  sat.delete();
  satEdges.delete();

  cv.HoughLinesP(edges, segments, 1, Math.PI / 180, 50, minDim * 0.12, minDim * 0.03);

  const horizontal = [];
  const vertical = [];
  const s = segments.data32S;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const line = lineFromSegment(s[i], s[i + 1], s[i + 2], s[i + 3]);
    (Math.abs(line.dir.x) >= Math.abs(line.dir.y) ? horizontal : vertical).push(line);
  }
  gray.delete();
  edges.delete();
  segments.delete();

  const hs = clusterLines(horizontal).slice(0, 8);
  const vs = clusterLines(vertical).slice(0, 8);
  const quads = [];
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      for (let k = 0; k < vs.length; k++) {
        for (let l = k + 1; l < vs.length; l++) {
          const pts = [
            intersect(hs[i], vs[k]),
            intersect(hs[i], vs[l]),
            intersect(hs[j], vs[l]),
            intersect(hs[j], vs[k]),
          ];
          const outOfFrame = pts.some(
            (p) => !p || p.x < -width * 0.03 || p.y < -height * 0.03 || p.x > width * 1.03 || p.y > height * 1.03,
          );
          if (!outOfFrame) quads.push(orderQuad(pts));
        }
      }
    }
  }
  return quads;
}

/** Semua kandidat quad (koordinat `src`). */
export function collectPaperQuadCandidates(cv, src, paperLum) {
  return [...maskQuadCandidates(cv, src, paperLum), ...houghQuadCandidates(cv, src)];
}
