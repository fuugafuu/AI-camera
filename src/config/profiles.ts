import type {
  PerformanceMode,
  PerformanceProfile,
  VideoQualityId,
  VideoQualityProfile,
  VideoStabilizationId,
  VideoStabilizationProfile,
} from "../types";

export const PERFORMANCE_PROFILES: Record<PerformanceMode, PerformanceProfile> = {
  powerSave: {
    label: "省電力",
    description: "バッテリー優先",
    detectionFps: 8,
    renderFps: 30,
    maxFaces: 3,
    landmarkLevel: "low",
    recognitionMode: "tapOnly",
    stabilizationLevel: "light",
    tiltCorrectionLevel: "light",
    animationLevel: "reduced",
    highQualityZoom: false,
    autoZoom: false,
    bestFrameBufferMs: 300,
    lostFrameTolerance: 12,
  },
  normal: {
    label: "通常",
    description: "おすすめ",
    detectionFps: 15,
    renderFps: 60,
    maxFaces: 5,
    landmarkLevel: "medium",
    recognitionMode: "tapOrLock",
    stabilizationLevel: "medium",
    tiltCorrectionLevel: "medium",
    animationLevel: "standard",
    highQualityZoom: true,
    autoZoom: true,
    bestFrameBufferMs: 700,
    lostFrameTolerance: 18,
  },
  max: {
    label: "最大",
    description: "高性能・高負荷",
    detectionFps: 30,
    renderFps: 60,
    maxFaces: 8,
    landmarkLevel: "high",
    recognitionMode: "tapLockAndPrefetch",
    stabilizationLevel: "high",
    tiltCorrectionLevel: "high",
    animationLevel: "premium",
    highQualityZoom: true,
    autoZoom: true,
    bestFrameBufferMs: 1200,
    lostFrameTolerance: 24,
  },
};

export const VIDEO_QUALITY_PROFILES: Record<VideoQualityId, VideoQualityProfile> = {
  light: {
    label: "軽量",
    description: "長時間録画向け",
    idealWidth: 1280,
    idealHeight: 720,
    idealFps: 30,
    bitrate: 1_600_000,
    detectionScale: 0.65,
  },
  standard: {
    label: "標準",
    description: "初期設定",
    idealWidth: 1920,
    idealHeight: 1080,
    idealFps: 30,
    bitrate: 4_500_000,
    detectionScale: 1,
  },
  high: {
    label: "高画質",
    description: "1080p-1440p",
    idealWidth: 2560,
    idealHeight: 1440,
    idealFps: 60,
    bitrate: 8_000_000,
    detectionScale: 1.15,
  },
  max: {
    label: "最大",
    description: "端末上限優先",
    idealWidth: 3840,
    idealHeight: 2160,
    idealFps: 60,
    bitrate: 14_000_000,
    detectionScale: 1.25,
  },
};

export const VIDEO_STABILIZATION_PROFILES: Record<
  VideoStabilizationId,
  VideoStabilizationProfile
> = {
  off: {
    label: "OFF",
    cropPadding: 0,
    smoothing: 0,
    lockPriority: false,
    description: "最高画質",
  },
  weak: {
    label: "弱",
    cropPadding: 0.04,
    smoothing: 0.18,
    lockPriority: false,
    description: "小さな揺れだけ",
  },
  standard: {
    label: "標準",
    cropPadding: 0.08,
    smoothing: 0.28,
    lockPriority: false,
    description: "歩き撮影向け",
  },
  strong: {
    label: "強",
    cropPadding: 0.12,
    smoothing: 0.42,
    lockPriority: false,
    description: "揺れ大きめ",
  },
  lock: {
    label: "ロックオン優先",
    cropPadding: 0.14,
    smoothing: 0.5,
    lockPriority: true,
    description: "対象中心化",
  },
};

export const ZOOM_STEPS = [0.5, 1, 2, 5] as const;

export const DEFAULT_GRID_SETTINGS = {
  grid: true,
  thirds: true,
  center: false,
  level: true,
};
