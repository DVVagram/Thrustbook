/* eslint-disable no-restricted-globals */
/**
 * Classic Web Worker: OpenCV.js is an embedded-WASM build that compiles
 * synchronously. Keeping it off the UI thread is required for a responsive app.
 * This file is loaded via ?url and must remain dependency-free plain JavaScript.
 */
'use strict';

let cv = null;
let cvPromise = null;
let session = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function polygonCentroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  }
  area *= 0.5;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function polygonBounds(points) {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function loadOpenCv(url) {
  if (cv?.Mat) return Promise.resolve();
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    try {
      if (!self.cv) self.importScripts(url);
    } catch (err) {
      reject(new Error(`OpenCV.js could not be loaded: ${err?.message ?? err}`));
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
    const finish = (candidate) => {
      if (settled) return;
      const ready = candidate && candidate.Mat ? candidate : self.cv && self.cv.Mat ? self.cv : module;
      if (!ready?.Mat) return;
      settled = true;
      cv = ready;
      clearInterval(timer);
      resolve();
    };
    try {
      if (typeof module.then === 'function') {
        module.then((ready) => finish(ready));
      }
    } catch {
      /* fall back to polling */
    }
    const started = Date.now();
    const timer = setInterval(() => {
      finish();
      if (!settled && Date.now() - started > 180000) {
        settled = true;
        clearInterval(timer);
        reject(new Error('OpenCV.js timed out while initialising'));
      }
    }, 200);
  });
  return cvPromise;
}

function matPoints(points) {
  const values = [];
  for (const p of points) values.push(p.x, p.y);
  return cv.matFromArray(points.length, 1, cv.CV_32FC2, values);
}

function readPoints(mat) {
  const data = mat.data32F;
  const out = [];
  for (let i = 0; i + 1 < data.length; i += 2) out.push({ x: data[i], y: data[i + 1] });
  return out;
}

function applyAffine(points, m) {
  return points.map((p) => ({
    x: m[0] * p.x + m[1] * p.y + m[2],
    y: m[3] * p.x + m[4] * p.y + m[5],
  }));
}

function makeMask(polygon, width, height, invert = false) {
  const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
  if (invert) mask.setTo(new cv.Scalar(255, 255, 255, 255));
  const values = [];
  for (const p of polygon) values.push(Math.round(p.x), Math.round(p.y));
  const pts = cv.matFromArray(polygon.length, 1, cv.CV_32SC2, values);
  const vec = new cv.MatVector();
  vec.push_back(pts);
  cv.fillPoly(mask, vec, new cv.Scalar(invert ? 0 : 255, invert ? 0 : 255, invert ? 0 : 255, 255));
  pts.delete();
  vec.delete();
  return mask;
}

function detectFeatures(gray, polygon, width, height, maxFeatures, invert = false) {
  const mask = makeMask(polygon, width, height, invert);
  const corners = new cv.Mat();
  try {
    cv.goodFeaturesToTrack(gray, corners, maxFeatures, 0.01, 7, mask, 3, false, 0.04);
    return readPoints(corners).filter((p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
  } finally {
    corners.delete();
    mask.delete();
  }
}

/**
 * Background translation is estimated from features outside the object mask.
 * This is deliberately translation-only: it cannot represent camera zoom,
 * rotation, rolling shutter or parallax, and is reported as such.
 */
function estimateBackgroundTranslation(prevGray, nextGray, width, height) {
  if (!session.cameraEnabled) return { dx: 0, dy: 0, valid: false, count: 0 };
  if (session.backgroundFeatures.length < 4) {
    session.backgroundFeatures = detectFeatures(
      prevGray,
      session.previousPolygon,
      width,
      height,
      Math.max(80, session.config.maxFeatures),
      true,
    );
  }
  if (session.backgroundFeatures.length < 4) return { dx: 0, dy: 0, valid: false, count: 0 };
  const p0 = matPoints(session.backgroundFeatures);
  const p1 = new cv.Mat();
  const status = new cv.Mat();
  const err = new cv.Mat();
  const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
  try {
    cv.calcOpticalFlowPyrLK(prevGray, nextGray, p0, p1, status, err, new cv.Size(21, 21), 3, criteria);
    const next = readPoints(p1);
    const dx = [];
    const dy = [];
    const tracked = [];
    for (let i = 0; i < session.backgroundFeatures.length; i++) {
      const a = session.backgroundFeatures[i];
      const b = next[i];
      if (!status.data[i] || !b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      if (b.x < -4 || b.y < -4 || b.x > width + 4 || b.y > height + 4) continue;
      dx.push(b.x - a.x);
      dy.push(b.y - a.y);
      tracked.push(b);
    }
    if (dx.length < 4) return { dx: 0, dy: 0, valid: false, count: dx.length };
    const medianX = median(dx);
    const medianY = median(dy);
    // Keep the background cloud coherent; object pixels that leak into the
    // background set are rejected as translation outliers.
    const limit = Math.max(1.5, Math.hypot(medianX, medianY) * 0.5);
    const coherent = [];
    for (let i = 0; i < tracked.length; i++) {
      if (Math.hypot(dx[i] - medianX, dy[i] - medianY) <= limit) coherent.push(tracked[i]);
    }
    session.backgroundFeatures = coherent.length >= 4 ? coherent : tracked;
    return { dx: medianX, dy: medianY, valid: dx.length >= 6, count: dx.length };
  } finally {
    p0.delete();
    p1.delete();
    status.delete();
    err.delete();
  }
}

function geometryScore(polygon, previous, width, height) {
  const oldBounds = polygonBounds(previous);
  const nextBounds = polygonBounds(polygon);
  const oldDiag = Math.max(1, Math.hypot(oldBounds.width, oldBounds.height));
  const nextDiag = Math.max(1, Math.hypot(nextBounds.width, nextBounds.height));
  const oldCenter = polygonCentroid(previous);
  const nextCenter = polygonCentroid(polygon);
  const step = distance(oldCenter, nextCenter) / oldDiag;
  const sizeChange = nextDiag / oldDiag;
  const stepScore = clamp(1 - Math.max(0, step - 0.12) / 0.6, 0, 1);
  const sizeScore = clamp(1 - Math.abs(Math.log(Math.max(sizeChange, 1e-6))) / 0.7, 0, 1);
  const outside = polygon.filter((p) => p.x < -2 || p.y < -2 || p.x > width + 2 || p.y > height + 2).length / Math.max(1, polygon.length);
  return { stepScore, sizeScore, outside };
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
  for (let iteration = 0; iteration < 3; iteration++) {
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
      const p = applyAffine([from[index]], matrix)[0];
      return distance(p, to[index]);
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

function grayFromFrame(frame) {
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(frame.buffer), width: frame.width, height: frame.height });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

function startSession(config) {
  if (session?.prevGray) {
    try {
      session.prevGray.delete();
    } catch {
      /* noop */
    }
  }
  const scale = Math.max(0.05, config.scale);
  const polygon = config.polygon.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const references = config.references.map((r) => ({ ...r, point: { x: r.point.x * scale, y: r.point.y * scale } }));
  session = {
    config,
    scale,
    width: Math.max(1, Math.round(config.sourceWidth * scale)),
    height: Math.max(1, Math.round(config.sourceHeight * scale)),
    polygon,
    references,
    previousPolygon: polygon,
    features: [],
    featureBaseline: 8,
    cameraEnabled: config.compensateCamera === true,
    backgroundFeatures: [],
    prevGray: null,
    started: false,
    lastIndex: config.startFrame,
    stopped: false,
    protectedFrames: new Set(config.protectedFrames || []),
    endFrame: Math.min(config.endFrame, config.frameCount - 1),
  };
}

function firstFrame(frame) {
  const gray = grayFromFrame(frame);
  const features = detectFeatures(gray, session.polygon, session.width, session.height, session.config.maxFeatures);
  if (features.length < 4) {
    gray.delete();
    throw new Error('Too few trackable features were found inside the outline. Choose a more textured object or draw a larger outline.');
  }
  session.prevGray = gray;
  session.features = features;
  session.featureBaseline = Math.max(8, features.length);
  session.backgroundFeatures = session.cameraEnabled
    ? detectFeatures(gray, session.polygon, session.width, session.height, Math.max(80, session.config.maxFeatures), true)
    : [];
  session.started = true;
  return {
    track: {
      frame: frame.index,
      time: frame.time,
      polygon: session.config.polygon.map((p) => ({ ...p })),
      references: session.config.references.map((r) => ({ ...r, point: { ...r.point } })),
      bbox: polygonBounds(session.config.polygon),
      status: 'manual',
      quality: 100,
      qualityNotes: ['Outline supplied by the user'],
      featureCount: features.length,
      inlierRatio: 1,
      fbError: 0,
      cameraDx: 0,
      cameraDy: 0,
      cameraValid: session.cameraEnabled && session.backgroundFeatures.length >= 6,
    },
  };
}

function nextFrame(frame) {
  if (session.stopped) return { stopped: true, reason: 'tracking already stopped' };
  if (frame.index !== session.config.startFrame + 1 && session.lastIndex !== undefined && frame.index !== session.lastIndex + 1) {
    return { stopped: true, reason: 'non-consecutive frame supplied' };
  }
  if (session.protectedFrames.has(frame.index)) {
    session.stopped = true;
    return { stopped: true, stoppedAt: frame.index, reason: `stopped before manual correction at frame ${frame.index}` };
  }
  if (frame.index > session.endFrame) {
    session.stopped = true;
    return { stopped: true, stoppedAt: frame.index, reason: 'reached the end of the selected range' };
  }

  const nextGray = grayFromFrame(frame);
  const p0 = matPoints(session.features);
  const p1 = new cv.Mat();
  const status = new cv.Mat();
  const err = new cv.Mat();
  const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 30, 0.01);
  let matrix = null;
  let nextPolygon = session.previousPolygon;
  let quality = 0;
  let inlierRatio = 0;
  let fbMean = 0;
  let goodCount = 0;
  const notes = [];
  try {
    cv.calcOpticalFlowPyrLK(session.prevGray, nextGray, p0, p1, status, err, new cv.Size(21, 21), 3, criteria);
    const nextAll = readPoints(p1);
    const reversePts = matPoints(nextAll);
    const back = new cv.Mat();
    const backStatus = new cv.Mat();
    const backErr = new cv.Mat();
    cv.calcOpticalFlowPyrLK(nextGray, session.prevGray, reversePts, back, backStatus, backErr, new cv.Size(21, 21), 3, criteria);
    const backAll = readPoints(back);
    const backOk = Array.from(backStatus.data);
    reversePts.delete();
    back.delete();
    backStatus.delete();
    backErr.delete();

    const candidates = [];
    for (let i = 0; i < session.features.length; i++) {
      if (!status.data[i] || !backOk[i]) continue;
      const a = nextAll[i];
      const b = backAll[i];
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      candidates.push({ from: session.features[i], to: a, fb: distance(a, b) });
    }
    // A periodic texture can produce a coherent forward-backward offset that is
    // larger than 3 px even when the geometric fit is correct. Reject relative
    // outliers instead of discarding every feature when the median is elevated.
    const fbMedian = median(candidates.map((candidate) => candidate.fb));
    const fbTolerance = Math.min(8, Math.max(3, fbMedian * 2.2));
    const from = [];
    const to = [];
    let fbTotal = 0;
    for (const candidate of candidates) {
      if (candidate.fb > fbTolerance) continue;
      from.push(candidate.from);
      to.push(candidate.to);
      fbTotal += candidate.fb;
    }
    goodCount = from.length;
    fbMean = goodCount ? fbTotal / goodCount : 999;
    const featureRatio = clamp(goodCount / session.featureBaseline, 0, 1);
    if (goodCount >= 4) {
      const fit = fitSimilarity(from, to);
      if (fit) {
        matrix = fit.matrix;
        const candidate = applyAffine(session.previousPolygon, matrix);
        if (candidate.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) nextPolygon = candidate;
        inlierRatio = clamp(fit.ratio, 0, 1);
      }
    }
    if (nextPolygon === session.previousPolygon) {
      notes.push('Geometric fit failed');
      quality = 0;
    } else {
      const geometry = geometryScore(nextPolygon, session.previousPolygon, session.width, session.height);
      const fbScore = clamp(1 - fbMean / Math.max(3, fbMedian * 2.2), 0, 1);
      quality = 100 * (0.35 * inlierRatio + 0.25 * featureRatio + 0.2 * fbScore + 0.1 * geometry.sizeScore + 0.1 * geometry.stepScore);
      if (geometry.outside > 0) {
        quality *= 1 - Math.min(0.5, geometry.outside);
        notes.push(`${Math.round(geometry.outside * 100)}% of the outline is outside the frame`);
      }
      if (geometry.sizeScore < 0.45) notes.push('Large change in apparent object size');
      if (geometry.stepScore < 0.4) notes.push('Abrupt position change');
      if (featureRatio < 0.5) notes.push('Many tracking features were lost');
      if (fbMean > 1.2) notes.push(`Forward-backward error ${fbMean.toFixed(2)} px`);
      if (inlierRatio < 0.6) notes.push('Low geometric inlier ratio');
    }
    if (quality < Math.max(15, session.config.qualityThreshold * 0.45) || goodCount < 4) {
      session.stopped = true;
      return { stopped: true, stoppedAt: frame.index, reason: `tracking lost at frame ${frame.index}` };
    }

    const camera = estimateBackgroundTranslation(session.prevGray, nextGray, session.width, session.height);
    if (session.cameraEnabled && !camera.valid) notes.push('Background motion could not be estimated');
    const transformedReferences = session.references.map((r) => ({
      ...r,
      point: matrix ? applyAffine([r.point], matrix)[0] : r.point,
    }));
    const nextReferences = transformedReferences.map((r) => ({ ...r, point: { x: r.point.x / session.scale, y: r.point.y / session.scale } }));
    const nextOriginal = nextPolygon.map((p) => ({ x: p.x / session.scale, y: p.y / session.scale }));
    const trackStatus = quality >= session.config.qualityThreshold ? 'tracked' : 'uncertain';
    if (trackStatus === 'uncertain') notes.unshift('Tracking confidence is below the review threshold');
    const track = {
      frame: frame.index,
      time: frame.time,
      polygon: nextOriginal,
      references: nextReferences,
      bbox: polygonBounds(nextOriginal),
      status: trackStatus,
      quality,
      qualityNotes: notes,
      featureCount: goodCount,
      inlierRatio,
      fbError: fbMean,
      cameraDx: camera.dx / session.scale,
      cameraDy: camera.dy / session.scale,
      cameraValid: session.cameraEnabled && camera.valid,
    };
    session.previousPolygon = nextPolygon;
    session.references = transformedReferences;
    session.features = to;
    session.lastIndex = frame.index;

    if (session.features.length < Math.max(8, session.featureBaseline * 0.35) || frame.index % 45 === 0) {
      const fresh = detectFeatures(nextGray, nextPolygon, session.width, session.height, session.config.maxFeatures);
      if (fresh.length >= 4) {
        session.features = fresh;
        session.featureBaseline = Math.max(8, fresh.length);
      }
    }
    return { track };
  } finally {
    p0.delete();
    p1.delete();
    status.delete();
    err.delete();
    session.prevGray.delete();
    session.prevGray = nextGray;
  }
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  const { id, type } = message;
  try {
    if (type === 'load') {
      await loadOpenCv(message.opencvUrl);
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type === 'start') {
      await loadOpenCv(message.opencvUrl);
      startSession(message.config);
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type === 'frame') {
      if (!session) throw new Error('No tracking session is active');
      if (!cv?.Mat) throw new Error('OpenCV.js is not ready');
      const result = !session.started ? firstFrame(message.frame) : nextFrame(message.frame);
      if (result.stopped) {
        self.postMessage({ id, type: 'stopped', stoppedAt: result.stoppedAt ?? null, reason: result.reason });
      } else {
        self.postMessage({ id, type: 'track', track: result.track });
      }
      return;
    }
    if (type === 'reset') {
      if (session?.prevGray) {
        try {
          session.prevGray.delete();
        } catch {
          /* noop */
        }
      }
      session = null;
      self.postMessage({ id, type: 'ready' });
      return;
    }
    throw new Error(`Unknown tracker message: ${type}`);
  } catch (err) {
    session = null;
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err), stack: err?.stack });
  }
});
