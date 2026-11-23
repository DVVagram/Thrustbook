/* eslint-disable no-restricted-globals */
/**
 * Classic Web Worker: OpenCV.js is an embedded-WASM build that compiles
 * synchronously, so it must stay off the UI thread. Loaded via ?url and must
 * remain dependency-free plain JavaScript.
 *
 * The worker tracks the previous outline's contour, the object's nose/tail/
 * centre and its reference points between two frames with pyramidal Lucas–Kanade
 * optical flow. Forward–backward tracking removes points that do not come back,
 * and a RANSAC partial-affine fit turns the survivors into the frame-to-frame
 * motion of the object. The renderer uses that motion to predict the outline on
 * frames where SAM 2.1 is deliberately skipped.
 */
'use strict';

let cv = null;
let cvPromise = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadOpenCv(url) {
  if (cv?.Mat) return Promise.resolve();
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    try {
      if (!self.cv) self.importScripts(url);
    } catch (error) {
      reject(new Error(`OpenCV.js could not be loaded: ${error?.message ?? error}`));
      return;
    }
    const module = self.cv;
    if (!module) {
      reject(new Error('OpenCV.js loaded but did not expose the cv global'));
      return;
    }
    if (module.Mat) {
      cv = module;
      resolve();
      return;
    }
    let settled = false;
    const timer = setInterval(() => {
      const ready = module.Mat ? module : self.cv && self.cv.Mat ? self.cv : null;
      if (ready) {
        settled = true;
        clearInterval(timer);
        cv = ready;
        resolve();
        return;
      }
      if (Date.now() - started > 180000) {
        settled = true;
        clearInterval(timer);
        reject(new Error('OpenCV.js timed out while initialising'));
      }
    }, 200);
    const started = Date.now();
    try {
      if (typeof module.then === 'function') {
        module.then((ready) => {
          if (!ready?.Mat || settled) return;
          settled = true;
          clearInterval(timer);
          cv = ready;
          resolve();
        });
      }
    } catch {
      /* polling below still applies */
    }
  });
  return cvPromise;
}

function roiForPolygon(polygon, width, height, margin) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width, height };
  const pad = Math.max(12, Math.max(maxX - minX, maxY - minY) * margin);
  const x = clamp(Math.floor(minX - pad), 0, Math.max(0, width - 8));
  const y = clamp(Math.floor(minY - pad), 0, Math.max(0, height - 8));
  const right = clamp(Math.ceil(maxX + pad), x + 8, width);
  const bottom = clamp(Math.ceil(maxY + pad), y + 8, height);
  return { x, y, width: right - x, height: bottom - y };
}

function copyRoi(source, sourceWidth, roi, target, targetWidth, targetHeight) {
  for (let row = 0; row < targetHeight; row++) {
    const from = ((roi.y + row) * sourceWidth + roi.x) * 4;
    target.set(source.subarray(from, from + targetWidth * 4), row * targetWidth * 4);
  }
}

function flow(request) {
  const { prev, curr, width, height, points, polygon } = request;
  const roi = roiForPolygon(polygon, width, height, 0.5);
  const roiWidth = Math.max(8, Math.round(roi.width));
  const roiHeight = Math.max(8, Math.round(roi.height));
  const mats = [];
  const keep = (mat) => {
    mats.push(mat);
    return mat;
  };
  try {
    const prevRgba = keep(new cv.Mat(roiHeight, roiWidth, cv.CV_8UC4));
    const currRgba = keep(new cv.Mat(roiHeight, roiWidth, cv.CV_8UC4));
    copyRoi(prev, width, roi, prevRgba.data, roiWidth, roiHeight);
    copyRoi(curr, width, roi, currRgba.data, roiWidth, roiHeight);
    const prevGray = keep(new cv.Mat());
    const currGray = keep(new cv.Mat());
    cv.cvtColor(prevRgba, prevGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(currRgba, currGray, cv.COLOR_RGBA2GRAY);

    // Interior features only: a static background must not vote on the object's
    // motion just because it is close to the silhouette.
    const mask = keep(new cv.Mat(roiHeight, roiWidth, cv.CV_8UC1, new cv.Scalar(0)));
    const polygonMat = keep(new cv.Mat(Math.max(1, polygon.length), 1, cv.CV_32SC2));
    polygon.forEach((point, index) => {
      polygonMat.data32S[index * 2] = Math.round(point.x - roi.x);
      polygonMat.data32S[index * 2 + 1] = Math.round(point.y - roi.y);
    });
    const polygonVec = keep(new cv.MatVector());
    polygonVec.push_back(polygonMat);
    cv.fillPoly(mask, polygonVec, new cv.Scalar(255));
    const corners = keep(new cv.Mat());
    cv.goodFeaturesToTrack(prevGray, corners, 120, 0.004, 2, mask, 3, false, 0.04);

    const inputCount = points.length;
    const localPoints = [];
    for (const point of points) {
      localPoints.push({ x: point.x - roi.x, y: point.y - roi.y });
    }
    for (let index = 0; index < corners.rows; index++) {
      const corner = { x: corners.data32F[index * 2], y: corners.data32F[index * 2 + 1] };
      if (localPoints.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) < 1.5)) continue;
      localPoints.push(corner);
    }
    const count = localPoints.length;
    if (count < 4) {
      return { affine: null, points: emptyTracks(points), inlierRatio: 0, fbError: 99, features: 0, confidence: 0, roi };
    }

    const prevPts = keep(new cv.Mat(count, 1, cv.CV_32FC2));
    localPoints.forEach((point, index) => {
      prevPts.data32F[index * 2] = point.x;
      prevPts.data32F[index * 2 + 1] = point.y;
    });
    const nextPts = keep(new cv.Mat());
    const status = keep(new cv.Mat());
    const err = keep(new cv.Mat());
    cv.calcOpticalFlowPyrLK(
      prevGray,
      currGray,
      prevPts,
      nextPts,
      status,
      err,
      new cv.Size(21, 21),
      3,
      new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01),
      0,
    );
    const backPts = keep(new cv.Mat());
    const backStatus = keep(new cv.Mat());
    const backErr = keep(new cv.Mat());
    cv.calcOpticalFlowPyrLK(
      currGray,
      prevGray,
      nextPts,
      backPts,
      backStatus,
      backErr,
      new cv.Size(21, 21),
      3,
      new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01),
      0,
    );

    const forwardStatus = status.data;
    const backwardStatus = backStatus.data;
    const forward = nextPts.data32F;
    const backward = backPts.data32F;
    const tracks = [];
    const fromPoints = [];
    const toPoints = [];
    let fbTotal = 0;
    let fbCount = 0;
    for (let index = 0; index < count; index++) {
      const tracked = forwardStatus[index] === 1 && backwardStatus[index] === 1;
      const nx = forward[index * 2];
      const ny = forward[index * 2 + 1];
      const fbError = tracked ? Math.hypot(localPoints[index].x - backward[index * 2], localPoints[index].y - backward[index * 2 + 1]) : 99;
      const inside = nx >= 0 && ny >= 0 && nx < roiWidth && ny < roiHeight;
      const good = tracked && inside && fbError <= 2.5;
      tracks.push({ found: good, x: nx + roi.x, y: ny + roi.y, fbError: good ? fbError : 99 });
      if (good) {
        fromPoints.push(localPoints[index]);
        toPoints.push({ x: nx, y: ny });
        fbTotal += fbError;
        fbCount++;
      }
    }

    let affine = null;
    let inlierRatio = 0;
    let rotation = { a: 1, b: 0, c: 0, d: 1 };
    if (fromPoints.length >= 4) {
      const fit = fitSimilarity(fromPoints, toPoints);
      if (fit) {
        const [a, b, tx, c, d, ty] = fit.matrix;
        if ([a, b, tx, c, d, ty].every(Number.isFinite)) {
          affine = { a, b, tx, c, d, ty };
          rotation = { a, b, c, d };
          inlierRatio = fit.ratio;
        }
      }
    }
    const localPolygon = polygon.map((point) => ({ x: point.x - roi.x, y: point.y - roi.y }));
    const matched = templateTranslation(prevGray, currGray, localPolygon);
    if (matched && matched.score >= 0.35) {
      // Keep the similarity fit's rotation/scale but move the object by the
      // template match, which does not slide along low-contrast silhouettes.
      let cx = 0;
      let cy = 0;
      for (const point of localPolygon) {
        cx += point.x;
        cy += point.y;
      }
      cx /= Math.max(1, localPolygon.length);
      cy /= Math.max(1, localPolygon.length);
      const dx = matched.dx;
      const dy = matched.dy;
      const mapped = {
        x: rotation.a * cx + rotation.b * cy,
        y: rotation.c * cx + rotation.d * cy,
      };
      affine = {
        a: rotation.a,
        b: rotation.b,
        c: rotation.c,
        d: rotation.d,
        tx: cx + dx - mapped.x,
        ty: cy + dy - mapped.y,
      };
      inlierRatio = Math.max(inlierRatio, clamp((matched.score - 0.2) / 0.7, 0, 1));
    }
    const fbMean = fbCount ? fbTotal / fbCount : 99;
    const confidence = clamp(0.6 * inlierRatio + 0.4 * Math.exp(-fbMean / 1.5), 0, 1);
    return {
      affine,
      points: tracks.slice(0, inputCount).map((track, index) => ({
        index,
        found: track.found,
        point: { x: track.x, y: track.y },
        fbError: track.fbError,
      })),
      inlierRatio,
      fbError: fbMean,
      features: fromPoints.length,
      confidence,
      roi,
      translation: matched ? { dx: matched.dx, dy: matched.dy, score: matched.score } : null,
    };
  } finally {
    for (const mat of mats) {
      try {
        mat.delete();
      } catch {
        /* already freed */
      }
    }
  }
}



function roiBounds(points, width, height, pad = 2) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX)) return null;
  const x = clamp(Math.floor(minX) - pad, 0, width - 8);
  const y = clamp(Math.floor(minY) - pad, 0, height - 8);
  const right = clamp(Math.ceil(maxX) + pad, x + 8, width);
  const bottom = clamp(Math.ceil(maxY) + pad, y + 8, height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Masked template search over the object's own pixels. Lucas–Kanade on a
 * low-texture body can lock onto the static background at the silhouette and
 * under-report motion; matching the masked interior itself is not fooled that
 * way. Returns the translation in ROI pixels and a 0–1 match score.
 */
function templateTranslation(prevGray, currGray, polygon) {
  const bounds = roiBounds(polygon, prevGray.cols, prevGray.rows, 2);
  if (!bounds || bounds.width < 12 || bounds.height < 12) return null;
  const stride = Math.max(1, Math.round(Math.max(bounds.width, bounds.height) / 40));
  const samples = [];
  for (let y = bounds.y + 1; y < bounds.y + bounds.height - 1; y += stride) {
    for (let x = bounds.x + 1; x < bounds.x + bounds.width - 1; x += stride) {
      if (!pointInPolygon(x + 0.5, y + 0.5, polygon)) continue;
      samples.push({ x, y, value: prevGray.data[y * prevGray.cols + x] });
    }
  }
  if (samples.length < 20) return null;
  const radius = Math.max(8, Math.round(Math.max(bounds.width, bounds.height) * 0.2));
  const cost = (dx, dy) => {
    let total = 0;
    let valid = 0;
    for (const sample of samples) {
      const x = sample.x + dx;
      const y = sample.y + dy;
      if (x < 0 || y < 0 || x >= currGray.cols || y >= currGray.rows) continue;
      total += Math.abs(sample.value - currGray.data[y * currGray.cols + x]);
      valid++;
    }
    return valid >= samples.length * 0.9 ? total / Math.max(1, valid) : Infinity;
  };
  let best = null;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const value = cost(dx, dy);
      if (!best || value < best.cost) best = { dx, dy, cost: value };
    }
  }
  if (!best || !Number.isFinite(best.cost)) return null;
  const centre = cost(best.dx, best.dy);
  let shiftX = 0;
  let shiftY = 0;
  const left = cost(best.dx - 1, best.dy);
  const right = cost(best.dx + 1, best.dy);
  const denomX = left - 2 * centre + right;
  if (Number.isFinite(denomX) && denomX > 1e-6) shiftX = clamp((0.5 * (left - right)) / denomX, -0.5, 0.5);
  const up = cost(best.dx, best.dy - 1);
  const down = cost(best.dx, best.dy + 1);
  const denomY = up - 2 * centre + down;
  if (Number.isFinite(denomY) && denomY > 1e-6) shiftY = clamp((0.5 * (up - down)) / denomY, -0.5, 0.5);
  const score = clamp(1 - centre / 60, 0, 1);
  return { dx: best.dx + shiftX, dy: best.dy + shiftY, score };
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function applySimilarity(point, matrix) {
  const [a, b, tx, c, d, ty] = matrix;
  return { x: a * point.x + b * point.y + tx, y: c * point.x + d * point.y + ty };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Robust similarity transform (translation, rotation, uniform scale).
 * OpenCV 4.12 wasm does not expose estimateAffinePartial2D, and a full
 * homography is unstable for small, nearly planar object regions.
 */
function fitSimilarity(from, to) {
  let active = from.map((_, index) => index);
  let matrix = null;
  let residual = Infinity;
  for (let iteration = 0; iteration < 4; iteration++) {
    if (active.length < 4) break;
    let fromX = 0;
    let fromY = 0;
    let toX = 0;
    let toY = 0;
    for (const index of active) {
      fromX += from[index].x;
      fromY += from[index].y;
      toX += to[index].x;
      toY += to[index].y;
    }
    const count = active.length;
    fromX /= count;
    fromY /= count;
    toX /= count;
    toY /= count;
    let dot = 0;
    let cross = 0;
    let norm = 0;
    for (const index of active) {
      const fx = from[index].x - fromX;
      const fy = from[index].y - fromY;
      const tx = to[index].x - toX;
      const ty = to[index].y - toY;
      dot += fx * tx + fy * ty;
      cross += fx * ty - fy * tx;
      norm += fx * fx + fy * fy;
    }
    if (norm < 1e-6) break;
    const a = dot / norm;
    const b = cross / norm;
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) < 1e-6) break;
    matrix = [a, -b, toX - a * fromX + b * fromY, b, a, toY - b * fromX - a * fromY];
    const residuals = active.map((index) => {
      const projected = applySimilarity(from[index], matrix);
      return Math.hypot(projected.x - to[index].x, projected.y - to[index].y);
    });
    residual = median(residuals);
    const limit = Math.max(2.5, residual * 3);
    const kept = active.filter((_, position) => residuals[position] <= limit);
    if (kept.length === active.length) break;
    active = kept;
  }
  if (!matrix || active.length < 4) return null;
  return { matrix, inliers: active.length, ratio: active.length / Math.max(1, from.length), residual };
}

function emptyTracks(points) {
  return points.map((point, index) => ({ index, found: false, point: { ...point }, fbError: 99 }));
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    try {
      await loadOpenCv(message.opencvUrl);
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', error: String(error?.message ?? error) });
    }
    return;
  }
  if (message.type === 'flow') {
    try {
      const result = flow(message);
      self.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
      self.postMessage({ id: message.id, ok: false, error: String(error?.message ?? error) });
    }
  }
};
