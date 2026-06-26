import type { DisplayTransform, Point, Rect } from "../types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function centerOf(rect: Rect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function intersectionOverUnion(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = rectArea({
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  });
  const union = rectArea(a) + rectArea(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function buildDisplayTransform(params: {
  sourceWidth: number;
  sourceHeight: number;
  displayWidth: number;
  displayHeight: number;
  zoomScale: number;
  mirrorX: boolean;
  panX?: number;
  panY?: number;
}): DisplayTransform {
  const {
    sourceWidth,
    sourceHeight,
    displayWidth,
    displayHeight,
    mirrorX,
    panX = 0,
    panY = 0,
  } = params;
  const zoomScale = Math.max(1, params.zoomScale);
  const baseScale = Math.max(displayWidth / sourceWidth, displayHeight / sourceHeight);
  const scaledWidth = sourceWidth * baseScale * zoomScale;
  const scaledHeight = sourceHeight * baseScale * zoomScale;

  return {
    sourceWidth,
    sourceHeight,
    displayWidth,
    displayHeight,
    baseScale,
    zoomScale,
    offsetX: (displayWidth - scaledWidth) / 2 + panX,
    offsetY: (displayHeight - scaledHeight) / 2 + panY,
    mirrorX,
    cropX: Math.max(0, (scaledWidth - displayWidth) / 2 - panX),
    cropY: Math.max(0, (scaledHeight - displayHeight) / 2 - panY),
  };
}

export function sourcePointToDisplay(point: Point, transform: DisplayTransform): Point {
  const scale = transform.baseScale * transform.zoomScale;
  let x = transform.offsetX + point.x * scale;
  const y = transform.offsetY + point.y * scale;
  if (transform.mirrorX) {
    x = transform.displayWidth - x;
  }
  return { x, y, z: point.z };
}

export function sourceRectToDisplay(rect: Rect, transform: DisplayTransform): Rect {
  const scale = transform.baseScale * transform.zoomScale;
  let x = transform.offsetX + rect.x * scale;
  const y = transform.offsetY + rect.y * scale;
  const width = rect.width * scale;
  const height = rect.height * scale;
  if (transform.mirrorX) {
    x = transform.displayWidth - (x + width);
  }
  return {
    x,
    y,
    width,
    height,
    angle: transform.mirrorX ? -(rect.angle ?? 0) : rect.angle,
  };
}

export function displayPointToSource(point: Point, transform: DisplayTransform): Point {
  const scale = transform.baseScale * transform.zoomScale;
  const xInDisplay = transform.mirrorX ? transform.displayWidth - point.x : point.x;
  return {
    x: (xInDisplay - transform.offsetX) / scale,
    y: (point.y - transform.offsetY) / scale,
  };
}

export function hitTestFaces(
  point: Point,
  faces: { trackId: number; displayBox: Rect }[],
): number | null {
  const containing = faces.filter(({ displayBox }) => {
    const pad = Math.max(14, Math.min(displayBox.width, displayBox.height) * 0.12);
    return (
      point.x >= displayBox.x - pad &&
      point.x <= displayBox.x + displayBox.width + pad &&
      point.y >= displayBox.y - pad &&
      point.y <= displayBox.y + displayBox.height + pad
    );
  });

  const candidates = containing.length > 0 ? containing : faces;
  let best: { trackId: number; score: number } | null = null;
  for (const face of candidates) {
    const center = centerOf(face.displayBox);
    const score = distance(point, center) / Math.max(1, Math.min(face.displayBox.width, face.displayBox.height));
    if (!best || score < best.score) {
      best = { trackId: face.trackId, score };
    }
  }
  return best && best.score < 2.4 ? best.trackId : null;
}

export function boundsForRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) {
    return null;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function normalizeVector(values: number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const centered = values.map((value) => value - mean);
  const magnitude = Math.hypot(...centered);
  if (magnitude === 0) {
    return centered;
  }
  return centered.map((value) => value / magnitude);
}
