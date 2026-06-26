import type { VideoQualityProfile } from "../types";

interface ZoomCapabilities extends MediaTrackCapabilities {
  zoom?: {
    min?: number;
    max?: number;
    step?: number;
  };
}

export async function requestCameraStream(params: {
  facingMode: "environment" | "user";
  quality: VideoQualityProfile;
}): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new Error("カメラを使うには HTTPS または localhost が必要です。");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("このブラウザーはカメラ取得に対応していません。");
  }

  const candidates: MediaTrackConstraints[] = [
    {
      facingMode: { ideal: params.facingMode },
      width: { ideal: params.quality.idealWidth },
      height: { ideal: params.quality.idealHeight },
      frameRate: { ideal: params.quality.idealFps, max: params.quality.idealFps },
    },
    {
      facingMode: { ideal: params.facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    {
      facingMode: { ideal: params.facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    { facingMode: { ideal: params.facingMode } },
  ];

  let lastError: unknown = null;
  for (const video of candidates) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("カメラを開始できませんでした。");
}

export async function applyPreferredZoom(track: MediaStreamTrack, zoom: number): Promise<{
  mode: "device" | "digital";
  appliedZoom: number;
  supported: boolean;
}> {
  const capabilities = safeCapabilities(track);
  const zoomCapability = (capabilities as ZoomCapabilities | null)?.zoom;
  if (zoomCapability && typeof zoomCapability === "object") {
    const min = Number(zoomCapability.min ?? 1);
    const max = Number(zoomCapability.max ?? 1);
    const appliedZoom = Math.min(max, Math.max(min, zoom));
    try {
      await track.applyConstraints({ advanced: [{ zoom: appliedZoom } as MediaTrackConstraintSet] });
      return { mode: "device", appliedZoom, supported: zoom >= min && zoom <= max };
    } catch {
      return { mode: "digital", appliedZoom: zoom, supported: false };
    }
  }
  return { mode: "digital", appliedZoom: zoom, supported: zoom >= 1 };
}

export async function applyVideoQuality(
  stream: MediaStream,
  profile: VideoQualityProfile,
): Promise<MediaTrackSettings> {
  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new Error("映像トラックが見つかりません。");
  }
  try {
    await track.applyConstraints({
      width: { ideal: profile.idealWidth },
      height: { ideal: profile.idealHeight },
      frameRate: { ideal: profile.idealFps, max: profile.idealFps },
    });
  } catch {
    await track.applyConstraints({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    });
  }
  return track.getSettings();
}

export function getVideoTrackInfo(stream: MediaStream | null): {
  settings: MediaTrackSettings | null;
  capabilities: MediaTrackCapabilities | null;
} {
  const track = stream?.getVideoTracks()[0];
  if (!track) {
    return { settings: null, capabilities: null };
  }
  return {
    settings: track.getSettings(),
    capabilities: safeCapabilities(track),
  };
}

export function selectRecorderMimeType(): string {
  if (!("MediaRecorder" in window)) {
    return "";
  }
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

export async function requestStoragePersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function estimateBlobMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function safeCapabilities(track: MediaStreamTrack): MediaTrackCapabilities | null {
  if (typeof track.getCapabilities !== "function") {
    return null;
  }
  try {
    return track.getCapabilities();
  } catch {
    return null;
  }
}
