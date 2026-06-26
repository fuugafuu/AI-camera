export type CameraMode = "photo" | "video" | "search" | "settings";

export type PerformanceMode = "powerSave" | "normal" | "max";

export type LandmarkLevel = "low" | "medium" | "high";
export type StabilizationLevel = "light" | "medium" | "high";
export type AnimationLevel = "reduced" | "standard" | "premium";
export type RecognitionMode = "tapOnly" | "tapOrLock" | "tapLockAndPrefetch";

export type VideoQualityId = "light" | "standard" | "high" | "max";
export type VideoStabilizationId = "off" | "weak" | "standard" | "strong" | "lock";

export interface PerformanceProfile {
  label: string;
  description: string;
  detectionFps: number;
  renderFps: number;
  maxFaces: number;
  landmarkLevel: LandmarkLevel;
  recognitionMode: RecognitionMode;
  stabilizationLevel: StabilizationLevel;
  tiltCorrectionLevel: StabilizationLevel;
  animationLevel: AnimationLevel;
  highQualityZoom: boolean;
  autoZoom: boolean;
  bestFrameBufferMs: number;
  lostFrameTolerance: number;
}

export interface VideoQualityProfile {
  label: string;
  description: string;
  idealWidth: number;
  idealHeight: number;
  idealFps: number;
  bitrate: number;
  detectionScale: number;
}

export interface VideoStabilizationProfile {
  label: string;
  cropPadding: number;
  smoothing: number;
  lockPriority: boolean;
  description: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
}

export interface Point {
  x: number;
  y: number;
  z?: number;
}

export interface FaceAnalysis {
  brightness: "dark" | "ok" | "bright";
  blur: "low" | "medium" | "high";
  pose: "front" | "turned";
  focus: "ok" | "soft";
  registrationQuality: "good" | "retry";
  trackingStability: number;
  warnings: string[];
}

export interface RawFaceDetection {
  id: number;
  box: Rect;
  landmarks: Point[];
  confidence: number;
  angle: number;
  descriptor: number[];
  analysis: FaceAnalysis;
}

export interface TrackedFace {
  trackId: number;
  box: Rect;
  rawBox: Rect;
  landmarks: Point[];
  confidence: number;
  angle: number;
  velocity: Point;
  status: "active" | "predicted" | "lost";
  lostFrames: number;
  ageFrames: number;
  lastSeenAt: number;
  matchScore: number;
  matchReason: {
    iou: number;
    center: number;
    size: number;
    landmarks: number;
    descriptor: number;
  };
  descriptor: number[];
  analysis: FaceAnalysis;
}

export interface VisionMetrics {
  cameraWidth: number;
  cameraHeight: number;
  detectionFps: number;
  renderFps: number;
  trackedFaces: number;
  lostTracks: number;
  averageInferenceMs: number;
  workerLatencyMs: number;
  memoryEstimateMb: number;
}

export interface VisionInitMessage {
  type: "INIT";
  detectorModelUrl: string;
  landmarkerModelUrl: string;
  wasmBaseUrl: string;
  profile: PerformanceProfile;
}

export interface VisionFrameMessage {
  type: "FRAME";
  bitmap: ImageBitmap;
  timestamp: number;
  sourceWidth: number;
  sourceHeight: number;
  profile: PerformanceProfile;
  maxFaces: number;
}

export interface VisionConfigMessage {
  type: "CONFIG";
  profile: PerformanceProfile;
  maxFaces: number;
}

export interface VisionResetMessage {
  type: "RESET";
}

export type VisionRequestMessage =
  | VisionInitMessage
  | VisionFrameMessage
  | VisionConfigMessage
  | VisionResetMessage;

export interface VisionReadyMessage {
  type: "READY";
  backend: "mediapipe" | "native-face-detector" | "demo";
}

export interface VisionResultMessage {
  type: "RESULT";
  tracks: TrackedFace[];
  rawFaces: RawFaceDetection[];
  metrics: VisionMetrics;
  timestamp: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface VisionErrorMessage {
  type: "ERROR";
  message: string;
}

export type VisionResponseMessage =
  | VisionReadyMessage
  | VisionResultMessage
  | VisionErrorMessage;

export interface RegisteredFaceDescriptor {
  id: string;
  vector: number[];
  quality: number;
  createdAt: string;
  source: "registration" | "additional";
}

export interface RegisteredPerson {
  id: string;
  name: string;
  descriptors: RegisteredFaceDescriptor[];
  iconDataUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatchCandidate {
  personId: string;
  name: string;
  confidence: number;
  descriptorId: string;
}

export interface FaceMatchResult {
  trackId: number;
  status: "matched" | "candidate" | "multiple" | "none";
  candidates: MatchCandidate[];
  matchedName?: string;
}

export interface DisplayTransform {
  sourceWidth: number;
  sourceHeight: number;
  displayWidth: number;
  displayHeight: number;
  baseScale: number;
  zoomScale: number;
  offsetX: number;
  offsetY: number;
  mirrorX: boolean;
  cropX: number;
  cropY: number;
}
