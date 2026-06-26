/// <reference lib="webworker" />

import {
  FaceDetector,
  FaceLandmarker,
  FilesetResolver,
  type Detection,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type {
  FaceAnalysis,
  Point,
  RawFaceDetection,
  Rect,
  VisionRequestMessage,
  VisionResponseMessage,
} from "../types";
import { normalizeVector } from "../lib/geometry";
import { FaceTrackManager } from "../lib/tracker";

declare const self: DedicatedWorkerGlobalScope;

type Backend = "mediapipe" | "native-face-detector" | "demo";

const tracker = new FaceTrackManager();
let detector: FaceDetector | null = null;
let landmarker: FaceLandmarker | null = null;
let backend: Backend = "demo";
let configuredMaxFaces = 5;
let lastDetectionAt = 0;
let frameCounter = 0;
let fpsWindowStartedAt = performance.now();
let detectionFps = 0;
let averageInferenceMs = 0;
let sourceWidth = 0;
let sourceHeight = 0;
let sampleCanvas: OffscreenCanvas | null = null;
let sampleContext: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (event: MessageEvent<VisionRequestMessage>) => {
  const message = event.data;
  if (message.type === "INIT") {
    configuredMaxFaces = message.profile.maxFaces;
    await initialize(message.detectorModelUrl, message.landmarkerModelUrl, message.wasmBaseUrl);
    post({ type: "READY", backend });
    return;
  }

  if (message.type === "CONFIG") {
    if (message.maxFaces !== configuredMaxFaces) {
      configuredMaxFaces = message.maxFaces;
      await landmarker?.setOptions({ numFaces: configuredMaxFaces });
    }
    return;
  }

  if (message.type === "RESET") {
    tracker.reset();
    return;
  }

  if (message.type === "FRAME") {
    await processFrame(message);
  }
};

async function initialize(
  detectorModelUrl: string,
  landmarkerModelUrl: string,
  wasmBaseUrl: string,
): Promise<void> {
  try {
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl);
    detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: detectorModelUrl,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
      minSuppressionThreshold: 0.28,
    });
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: landmarkerModelUrl,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numFaces: configuredMaxFaces,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    backend = "mediapipe";
  } catch (error) {
    if ("FaceDetector" in self) {
      backend = "native-face-detector";
    } else {
      backend = "demo";
    }
    post({
      type: "ERROR",
      message: `MediaPipe モデルを読み込めませんでした。${error instanceof Error ? error.message : ""}`,
    });
  }
}

async function processFrame(message: Extract<VisionRequestMessage, { type: "FRAME" }>): Promise<void> {
  sourceWidth = message.sourceWidth;
  sourceHeight = message.sourceHeight;
  configuredMaxFaces = message.maxFaces;

  const interval = 1000 / Math.max(1, message.profile.detectionFps);
  if (message.timestamp - lastDetectionAt < interval) {
    message.bitmap.close();
    return;
  }
  lastDetectionAt = message.timestamp;

  const startedAt = performance.now();
  let rawFaces: RawFaceDetection[] = [];
  try {
    rawFaces = await detectFaces(message.bitmap, message.timestamp, message.maxFaces);
  } catch (error) {
    post({
      type: "ERROR",
      message: `顔検出に失敗しました。${error instanceof Error ? error.message : ""}`,
    });
  }
  const inferenceMs = performance.now() - startedAt;
  averageInferenceMs = averageInferenceMs === 0 ? inferenceMs : averageInferenceMs * 0.88 + inferenceMs * 0.12;
  frameCounter += 1;
  if (performance.now() - fpsWindowStartedAt > 1000) {
    detectionFps = frameCounter;
    frameCounter = 0;
    fpsWindowStartedAt = performance.now();
  }

  const tracks = tracker.update(rawFaces, {
    maxFaces: message.maxFaces,
    lostFrameTolerance: message.profile.lostFrameTolerance,
    timestamp: message.timestamp,
    sourceWidth: message.sourceWidth,
    sourceHeight: message.sourceHeight,
  });

  message.bitmap.close();
  post({
    type: "RESULT",
    tracks,
    rawFaces,
    timestamp: message.timestamp,
    sourceWidth: message.sourceWidth,
    sourceHeight: message.sourceHeight,
    metrics: {
      cameraWidth: message.sourceWidth,
      cameraHeight: message.sourceHeight,
      detectionFps,
      renderFps: message.profile.renderFps,
      trackedFaces: tracks.filter((track) => track.status !== "lost").length,
      lostTracks: tracks.filter((track) => track.status === "predicted").length,
      averageInferenceMs,
      workerLatencyMs: performance.now() - message.timestamp,
      memoryEstimateMb: Math.round((tracks.length * 36 + rawFaces.length * 28 + 24) * 10) / 10,
    },
  });
}

async function detectFaces(
  bitmap: ImageBitmap,
  timestamp: number,
  maxFaces: number,
): Promise<RawFaceDetection[]> {
  prepareSample(bitmap);
  if (backend === "mediapipe" && landmarker) {
    try {
      const result = landmarker.detectForVideo(bitmap, timestamp);
      if (result.faceLandmarks.length > 0) {
        return facesFromLandmarks(result, maxFaces);
      }
    } catch {
      if (detector) {
        const result = detector.detectForVideo(bitmap, timestamp);
        return facesFromDetections(result.detections, maxFaces);
      }
    }
  }

  if (backend === "native-face-detector") {
    const NativeFaceDetector = (self as unknown as { FaceDetector?: new (options: unknown) => unknown })
      .FaceDetector;
    if (NativeFaceDetector) {
      const nativeDetector = new NativeFaceDetector({ fastMode: true, maxDetectedFaces: maxFaces }) as {
        detect: (source: ImageBitmap) => Promise<Array<{ boundingBox: DOMRectReadOnly; landmarks?: unknown[] }>>;
      };
      const detections = await nativeDetector.detect(bitmap);
      return detections.slice(0, maxFaces).map((detection, index) => {
        const box = domRectToRect(detection.boundingBox);
        const landmarks = synthesizeLandmarks(box);
        return {
          id: index,
          box,
          landmarks,
          confidence: 0.65,
          angle: 0,
          descriptor: descriptorFromLandmarks(landmarks, box),
          analysis: analyzeFace(box, landmarks),
        };
      });
    }
  }

  return demoFaces(timestamp, maxFaces);
}

function facesFromLandmarks(result: FaceLandmarkerResult, maxFaces: number): RawFaceDetection[] {
  return result.faceLandmarks.slice(0, maxFaces).map((landmarks, index) => {
    const points = landmarksToPoints(landmarks);
    const box = boxFromPoints(points);
    const angle = estimateRoll(points);
    return {
      id: index,
      box: { ...box, angle },
      landmarks: points,
      confidence: 0.9,
      angle,
      descriptor: descriptorFromLandmarks(points, box),
      analysis: analyzeFace(box, points),
    };
  });
}

function facesFromDetections(detections: Detection[], maxFaces: number): RawFaceDetection[] {
  return detections
    .filter((detection) => detection.boundingBox)
    .slice(0, maxFaces)
    .map((detection, index) => {
      const box = {
        x: detection.boundingBox?.originX ?? 0,
        y: detection.boundingBox?.originY ?? 0,
        width: detection.boundingBox?.width ?? 1,
        height: detection.boundingBox?.height ?? 1,
        angle: 0,
      };
      const landmarks = detection.keypoints?.length
        ? detection.keypoints.map((point) => ({
            x: point.x * sourceWidth,
            y: point.y * sourceHeight,
          }))
        : synthesizeLandmarks(box);
      return {
        id: index,
        box,
        landmarks,
        confidence: detection.categories[0]?.score ?? 0.7,
        angle: 0,
        descriptor: descriptorFromLandmarks(landmarks, box),
        analysis: analyzeFace(box, landmarks),
      };
    });
}

function landmarksToPoints(landmarks: NormalizedLandmark[]): Point[] {
  return landmarks.map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
    z: point.z,
  }));
}

function boxFromPoints(points: Point[]): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const right = Math.min(sourceWidth, Math.max(...xs));
  const bottom = Math.min(sourceHeight, Math.max(...ys));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const padX = width * 0.12;
  const padY = height * 0.16;
  return {
    x: Math.max(0, left - padX),
    y: Math.max(0, top - padY),
    width: Math.min(sourceWidth - left, width + padX * 2),
    height: Math.min(sourceHeight - top, height + padY * 2),
  };
}

function estimateRoll(points: Point[]): number {
  const leftEye = averagePoints(points.slice(33, 134));
  const rightEye = averagePoints(points.slice(263, 363));
  if (!leftEye || !rightEye) {
    return 0;
  }
  return Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
}

function descriptorFromLandmarks(points: Point[], box: Rect): number[] {
  const samples = points.length > 60 ? [1, 33, 61, 98, 133, 152, 199, 263, 291, 327, 362] : undefined;
  const selected = samples ? samples.map((index) => points[index]).filter(Boolean) : points.slice(0, 12);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const values: number[] = [
    box.width / Math.max(1, sourceWidth),
    box.height / Math.max(1, sourceHeight),
    box.width / Math.max(1, box.height),
  ];
  for (const point of selected) {
    values.push((point.x - center.x) / Math.max(1, box.width));
    values.push((point.y - center.y) / Math.max(1, box.height));
  }
  return normalizeVector(values);
}

function synthesizeLandmarks(box: Rect): Point[] {
  return [
    { x: box.x + box.width * 0.32, y: box.y + box.height * 0.38 },
    { x: box.x + box.width * 0.68, y: box.y + box.height * 0.38 },
    { x: box.x + box.width * 0.5, y: box.y + box.height * 0.52 },
    { x: box.x + box.width * 0.38, y: box.y + box.height * 0.7 },
    { x: box.x + box.width * 0.62, y: box.y + box.height * 0.7 },
  ];
}

function analyzeFace(box: Rect, landmarks: Point[]): FaceAnalysis {
  const sample = sampleFacePixels(box);
  const widthRatio = box.width / Math.max(1, sourceWidth);
  const heightRatio = box.height / Math.max(1, sourceHeight);
  const roll = Math.abs(estimateRoll(landmarks));
  const warnings: string[] = [];
  const brightness = sample.luminance < 72 ? "dark" : sample.luminance > 208 ? "bright" : "ok";
  const blur = sample.sharpness < 12 ? "high" : sample.sharpness < 28 ? "medium" : "low";
  const pose = roll > 0.35 ? "turned" : "front";
  if (brightness === "dark") warnings.push("顔が暗いです");
  if (blur === "high") warnings.push("顔がブレています");
  if (widthRatio < 0.11 || heightRatio < 0.11) warnings.push("少し近づく");
  if (box.x < sourceWidth * 0.05) warnings.push("少し右へ");
  if (box.x + box.width > sourceWidth * 0.95) warnings.push("少し左へ");
  if (box.y < sourceHeight * 0.05) warnings.push("少し下へ");
  if (box.y + box.height > sourceHeight * 0.95) warnings.push("少し上へ");
  if (pose === "turned") warnings.push("顔の向きが外れています");
  return {
    brightness,
    blur,
    pose,
    focus: blur === "high" ? "soft" : "ok",
    registrationQuality: brightness === "ok" && blur !== "high" && pose === "front" ? "good" : "retry",
    trackingStability: 0.75,
    warnings: [...new Set(warnings)].slice(0, 3),
  };
}

function prepareSample(bitmap: ImageBitmap): void {
  const sampleWidth = 320;
  const sampleHeight = Math.max(1, Math.round((bitmap.height / bitmap.width) * sampleWidth));
  if (!sampleCanvas || sampleCanvas.width !== sampleWidth || sampleCanvas.height !== sampleHeight) {
    sampleCanvas = new OffscreenCanvas(sampleWidth, sampleHeight);
    sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  }
  sampleContext?.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
}

function sampleFacePixels(box: Rect): { luminance: number; sharpness: number } {
  if (!sampleCanvas || !sampleContext || sourceWidth === 0 || sourceHeight === 0) {
    return { luminance: 128, sharpness: 20 };
  }
  const scaleX = sampleCanvas.width / sourceWidth;
  const scaleY = sampleCanvas.height / sourceHeight;
  const x = Math.max(0, Math.floor(box.x * scaleX));
  const y = Math.max(0, Math.floor(box.y * scaleY));
  const width = Math.max(4, Math.min(sampleCanvas.width - x, Math.floor(box.width * scaleX)));
  const height = Math.max(4, Math.min(sampleCanvas.height - y, Math.floor(box.height * scaleY)));
  const data = sampleContext.getImageData(x, y, width, height).data;
  let luminance = 0;
  let sharpness = 0;
  let previous = 0;
  const pixels = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const value = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
    luminance += value;
    sharpness += Math.abs(value - previous);
    previous = value;
  }
  return {
    luminance: luminance / Math.max(1, pixels),
    sharpness: sharpness / Math.max(1, pixels),
  };
}

function demoFaces(timestamp: number, maxFaces: number): RawFaceDetection[] {
  const count = Math.min(maxFaces, 2 + Math.floor((Math.sin(timestamp / 2400) + 1) * 1.5));
  return Array.from({ length: count }, (_, index) => {
    const phase = timestamp / 900 + index * 1.9;
    const width = sourceWidth * (0.16 + index * 0.018);
    const height = width * 1.18;
    const x = sourceWidth * (0.28 + index * 0.18) + Math.sin(phase) * sourceWidth * 0.035;
    const y = sourceHeight * (0.32 + index * 0.06) + Math.cos(phase * 0.8) * sourceHeight * 0.035;
    const box = { x, y, width, height, angle: Math.sin(phase) * 0.08 };
    const landmarks = synthesizeLandmarks(box);
    return {
      id: index,
      box,
      landmarks,
      confidence: 0.62,
      angle: box.angle ?? 0,
      descriptor: descriptorFromLandmarks(landmarks, box),
      analysis: analyzeFace(box, landmarks),
    };
  });
}

function averagePoints(points: Point[]): Point | null {
  if (points.length === 0) {
    return null;
  }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function domRectToRect(rect: DOMRectReadOnly): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, angle: 0 };
}

function post(message: VisionResponseMessage): void {
  self.postMessage(message);
}
