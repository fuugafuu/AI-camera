import type { FaceAnalysis, Point, RawFaceDetection, Rect, TrackedFace } from "../types";
import {
  centerOf,
  clamp,
  cosineSimilarity,
  distance,
  intersectionOverUnion,
} from "./geometry";

class LowPassFilter {
  private initialized = false;
  private previous = 0;

  filter(value: number, alpha: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.previous = value;
      return value;
    }
    const result = alpha * value + (1 - alpha) * this.previous;
    this.previous = result;
    return result;
  }

  last(): number {
    return this.previous;
  }
}

class OneEuroFilter {
  private valueFilter = new LowPassFilter();
  private derivativeFilter = new LowPassFilter();
  private lastTime = 0;
  private minCutoff: number;
  private beta: number;
  private derivativeCutoff: number;

  constructor(minCutoff = 1.25, beta = 0.018, derivativeCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
  }

  filter(value: number, timestamp: number, speedBoost = 1): number {
    const deltaTime = this.lastTime > 0 ? Math.max(1 / 240, (timestamp - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = timestamp;
    const derivative = (value - this.valueFilter.last()) / deltaTime;
    const filteredDerivative = this.derivativeFilter.filter(
      derivative,
      this.alpha(deltaTime, this.derivativeCutoff),
    );
    const cutoff = this.minCutoff * speedBoost + this.beta * Math.abs(filteredDerivative);
    return this.valueFilter.filter(value, this.alpha(deltaTime, cutoff));
  }

  private alpha(deltaTime: number, cutoff: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / deltaTime);
  }
}

interface InternalTrack {
  trackId: number;
  box: Rect;
  rawBox: Rect;
  landmarks: Point[];
  descriptor: number[];
  confidence: number;
  angle: number;
  velocity: Point;
  lostFrames: number;
  ageFrames: number;
  lastSeenAt: number;
  status: "active" | "predicted" | "lost";
  matchScore: number;
  matchReason: TrackedFace["matchReason"];
  analysis: FaceAnalysis;
  filters: {
    x: OneEuroFilter;
    y: OneEuroFilter;
    width: OneEuroFilter;
    height: OneEuroFilter;
    angle: OneEuroFilter;
  };
}

export interface TrackerOptions {
  maxFaces: number;
  lostFrameTolerance: number;
  timestamp: number;
  sourceWidth: number;
  sourceHeight: number;
}

const DEFAULT_ANALYSIS: FaceAnalysis = {
  brightness: "ok",
  blur: "medium",
  pose: "front",
  focus: "ok",
  registrationQuality: "retry",
  trackingStability: 0,
  warnings: [],
};

export class FaceTrackManager {
  private tracks = new Map<number, InternalTrack>();
  private nextTrackId = 1;

  reset(): void {
    this.tracks.clear();
    this.nextTrackId = 1;
  }

  update(detections: RawFaceDetection[], options: TrackerOptions): TrackedFace[] {
    const activeTracks = [...this.tracks.values()].filter((track) => track.status !== "lost");
    const assignments = this.assignDetections(activeTracks, detections, options);
    const assignedTracks = new Set<number>();
    const assignedDetections = new Set<number>();

    for (const assignment of assignments) {
      const track = assignment.track;
      const detection = assignment.detection;
      assignedTracks.add(track.trackId);
      assignedDetections.add(detection.id);
      this.updateMatchedTrack(track, detection, assignment, options.timestamp);
    }

    for (const track of activeTracks) {
      if (!assignedTracks.has(track.trackId)) {
        this.predictLostTrack(track, options);
      }
    }

    for (const detection of detections) {
      if (!assignedDetections.has(detection.id)) {
        this.createTrack(detection, options.timestamp);
      }
    }

    const visibleTracks = [...this.tracks.values()]
      .filter((track) => track.status !== "lost")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, options.maxFaces);

    for (const [id, track] of this.tracks) {
      if (track.status === "lost" || track.lostFrames > options.lostFrameTolerance * 2) {
        this.tracks.delete(id);
      }
    }

    return visibleTracks.map(toPublicTrack);
  }

  private assignDetections(
    tracks: InternalTrack[],
    detections: RawFaceDetection[],
    options: TrackerOptions,
  ): Array<{
    track: InternalTrack;
    detection: RawFaceDetection;
    score: number;
    reason: TrackedFace["matchReason"];
  }> {
    const pairs: Array<{
      track: InternalTrack;
      detection: RawFaceDetection;
      score: number;
      reason: TrackedFace["matchReason"];
    }> = [];

    for (const track of tracks) {
      const predictedBox = predictBox(track, options.timestamp);
      for (const detection of detections) {
        const reason = scoreComponents(track, predictedBox, detection, options);
        const score =
          reason.iou * 0.4 +
          reason.center * 0.25 +
          reason.size * 0.15 +
          reason.landmarks * 0.12 +
          reason.descriptor * 0.08;
        if (score > 0.34) {
          pairs.push({ track, detection, score, reason });
        }
      }
    }

    pairs.sort((a, b) => b.score - a.score);
    const usedTracks = new Set<number>();
    const usedDetections = new Set<number>();
    const assignments: typeof pairs = [];
    for (const pair of pairs) {
      if (usedTracks.has(pair.track.trackId) || usedDetections.has(pair.detection.id)) {
        continue;
      }
      usedTracks.add(pair.track.trackId);
      usedDetections.add(pair.detection.id);
      assignments.push(pair);
    }
    return assignments;
  }

  private createTrack(detection: RawFaceDetection, timestamp: number): void {
    const track: InternalTrack = {
      trackId: this.nextTrackId,
      box: detection.box,
      rawBox: detection.box,
      landmarks: detection.landmarks,
      descriptor: detection.descriptor,
      confidence: detection.confidence,
      angle: detection.angle,
      velocity: { x: 0, y: 0 },
      lostFrames: 0,
      ageFrames: 1,
      lastSeenAt: timestamp,
      status: "active",
      matchScore: 1,
      matchReason: {
        iou: 1,
        center: 1,
        size: 1,
        landmarks: 1,
        descriptor: 1,
      },
      analysis: detection.analysis,
      filters: createFilters(),
    };
    this.nextTrackId += 1;
    this.tracks.set(track.trackId, track);
  }

  private updateMatchedTrack(
    track: InternalTrack,
    detection: RawFaceDetection,
    assignment: { score: number; reason: TrackedFace["matchReason"] },
    timestamp: number,
  ): void {
    const previousCenter = centerOf(track.box);
    const incomingCenter = centerOf(detection.box);
    const speed = distance(previousCenter, incomingCenter);
    const size = Math.max(1, Math.min(detection.box.width, detection.box.height));
    const speedRatio = clamp(speed / size, 0, 1.8);
    const speedBoost = 1 + speedRatio * 1.8;
    const dt = Math.max(1, timestamp - track.lastSeenAt);
    const alpha = clamp(0.18 + speedRatio * 0.46, 0.18, 0.68);

    const filteredBox: Rect = {
      x: track.filters.x.filter(lerp(track.box.x, detection.box.x, alpha), timestamp, speedBoost),
      y: track.filters.y.filter(lerp(track.box.y, detection.box.y, alpha), timestamp, speedBoost),
      width: track.filters.width.filter(
        lerp(track.box.width, detection.box.width, alpha),
        timestamp,
        speedBoost,
      ),
      height: track.filters.height.filter(
        lerp(track.box.height, detection.box.height, alpha),
        timestamp,
        speedBoost,
      ),
      angle: track.filters.angle.filter(
        lerp(track.box.angle ?? 0, detection.angle, alpha),
        timestamp,
        speedBoost,
      ),
    };

    track.velocity = {
      x: ((incomingCenter.x - previousCenter.x) / dt) * 16.67,
      y: ((incomingCenter.y - previousCenter.y) / dt) * 16.67,
    };
    track.box = filteredBox;
    track.rawBox = detection.box;
    track.landmarks = smoothLandmarks(track.landmarks, detection.landmarks, alpha);
    track.descriptor = detection.descriptor;
    track.confidence = detection.confidence;
    track.angle = filteredBox.angle ?? detection.angle;
    track.lostFrames = 0;
    track.ageFrames += 1;
    track.lastSeenAt = timestamp;
    track.status = "active";
    track.matchScore = assignment.score;
    track.matchReason = assignment.reason;
    track.analysis = {
      ...detection.analysis,
      trackingStability: clamp(assignment.score, 0, 1),
    };
  }

  private predictLostTrack(track: InternalTrack, options: TrackerOptions): void {
    track.lostFrames += 1;
    track.ageFrames += 1;
    const predicted = predictBox(track, options.timestamp);
    track.box = {
      x: clamp(predicted.x, -predicted.width * 0.5, options.sourceWidth - predicted.width * 0.5),
      y: clamp(predicted.y, -predicted.height * 0.5, options.sourceHeight - predicted.height * 0.5),
      width: predicted.width,
      height: predicted.height,
      angle: predicted.angle,
    };
    track.confidence = Math.max(0, track.confidence * 0.92);
    track.status = track.lostFrames > options.lostFrameTolerance ? "lost" : "predicted";
    track.analysis = {
      ...track.analysis,
      trackingStability: clamp(track.analysis.trackingStability * 0.86, 0, 1),
    };
  }
}

function createFilters(): InternalTrack["filters"] {
  return {
    x: new OneEuroFilter(),
    y: new OneEuroFilter(),
    width: new OneEuroFilter(1.05, 0.012),
    height: new OneEuroFilter(1.05, 0.012),
    angle: new OneEuroFilter(1.4, 0.01),
  };
}

function predictBox(track: InternalTrack, timestamp: number): Rect {
  const elapsedFrames = Math.min(8, Math.max(0, (timestamp - track.lastSeenAt) / 16.67));
  return {
    x: track.box.x + track.velocity.x * elapsedFrames,
    y: track.box.y + track.velocity.y * elapsedFrames,
    width: track.box.width,
    height: track.box.height,
    angle: track.box.angle,
  };
}

function scoreComponents(
  track: InternalTrack,
  predictedBox: Rect,
  detection: RawFaceDetection,
  options: TrackerOptions,
): TrackedFace["matchReason"] {
  const iou = intersectionOverUnion(predictedBox, detection.box);
  const trackCenter = centerOf(predictedBox);
  const detectionCenter = centerOf(detection.box);
  const diagonal = Math.hypot(options.sourceWidth, options.sourceHeight);
  const normalizedDistance = distance(trackCenter, detectionCenter) / Math.max(1, diagonal * 0.18);
  const center = clamp(1 - normalizedDistance, 0, 1);
  const trackSize = Math.sqrt(rectAreaSafe(predictedBox));
  const detectionSize = Math.sqrt(rectAreaSafe(detection.box));
  const size = clamp(1 - Math.abs(trackSize - detectionSize) / Math.max(trackSize, detectionSize, 1), 0, 1);
  const landmarks = landmarkSimilarity(track.landmarks, detection.landmarks, predictedBox, detection.box);
  const descriptor = clamp((cosineSimilarity(track.descriptor, detection.descriptor) + 1) / 2, 0, 1);
  return { iou, center, size, landmarks, descriptor };
}

function landmarkSimilarity(
  previous: Point[],
  next: Point[],
  previousBox: Rect,
  nextBox: Rect,
): number {
  const count = Math.min(previous.length, next.length, 18);
  if (count < 4) {
    return 0.5;
  }
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const a = previous[index];
    const b = next[index];
    const ax = (a.x - previousBox.x) / Math.max(1, previousBox.width);
    const ay = (a.y - previousBox.y) / Math.max(1, previousBox.height);
    const bx = (b.x - nextBox.x) / Math.max(1, nextBox.width);
    const by = (b.y - nextBox.y) / Math.max(1, nextBox.height);
    total += Math.hypot(ax - bx, ay - by);
  }
  return clamp(1 - total / count / 0.22, 0, 1);
}

function smoothLandmarks(previous: Point[], next: Point[], alpha: number): Point[] {
  if (previous.length !== next.length) {
    return next;
  }
  return next.map((point, index) => ({
    x: lerp(previous[index].x, point.x, alpha),
    y: lerp(previous[index].y, point.y, alpha),
    z:
      previous[index].z !== undefined || point.z !== undefined
        ? lerp(previous[index].z ?? 0, point.z ?? 0, alpha)
        : undefined,
  }));
}

function toPublicTrack(track: InternalTrack): TrackedFace {
  return {
    trackId: track.trackId,
    box: track.box,
    rawBox: track.rawBox,
    landmarks: track.landmarks,
    confidence: track.confidence,
    angle: track.angle,
    velocity: track.velocity,
    status: track.status,
    lostFrames: track.lostFrames,
    ageFrames: track.ageFrames,
    lastSeenAt: track.lastSeenAt,
    matchScore: track.matchScore,
    matchReason: track.matchReason,
    descriptor: track.descriptor,
    analysis: track.analysis ?? DEFAULT_ANALYSIS,
  };
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function rectAreaSafe(rect: Rect): number {
  return Math.max(1, rect.width) * Math.max(1, rect.height);
}
