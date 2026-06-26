import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Battery,
  Camera,
  Circle,
  Database,
  Download,
  Gauge,
  Grid3X3,
  Lock,
  Maximize2,
  RotateCcw,
  ScanFace,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import "./App.css";
import {
  DEFAULT_GRID_SETTINGS,
  PERFORMANCE_PROFILES,
  VIDEO_QUALITY_PROFILES,
  VIDEO_STABILIZATION_PROFILES,
  ZOOM_STEPS,
} from "./config/profiles";
import {
  applyPreferredZoom,
  applyVideoQuality,
  estimateBlobMb,
  formatDuration,
  getVideoTrackInfo,
  requestCameraStream,
  requestStoragePersistence,
  selectRecorderMimeType,
} from "./lib/camera";
import {
  buildDisplayTransform,
  boundsForRects,
  displayPointToSource,
  hitTestFaces,
  sourcePointToDisplay,
  sourceRectToDisplay,
} from "./lib/geometry";
import {
  canRegisterFace,
  classifyCandidates,
  clearFaceData,
  deletePerson,
  listPeople,
  matchRegisteredPeople,
  renamePerson,
  saveDescriptor,
} from "./lib/faceDb";
import type {
  CameraMode,
  DisplayTransform,
  FaceMatchResult,
  MatchCandidate,
  PerformanceMode,
  RegisteredPerson,
  TrackedFace,
  VideoQualityId,
  VideoStabilizationId,
  VisionMetrics,
  VisionResponseMessage,
} from "./types";

interface FaceMenuState {
  trackId: number;
  x: number;
  y: number;
}

interface RecordingPreview {
  url: string;
  blob: Blob;
  durationMs: number;
  quality: VideoQualityId;
  createdAt: string;
}

interface VideoHistoryItem {
  id: string;
  thumbnail?: string;
  createdAt: string;
  quality: VideoQualityId;
  durationMs: number;
  sizeMb: number;
}

interface ToastState {
  tone: "info" | "warning" | "critical";
  text: string;
}

const MATCH_LABEL_THRESHOLD = 85;

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordDrawRafRef = useRef<number | null>(null);
  const renderRafRef = useRef<number | null>(null);
  const tracksRef = useRef<TrackedFace[]>([]);
  const metricsRef = useRef<VisionMetrics | null>(null);
  const transformRef = useRef<DisplayTransform | null>(null);
  const matchResultsRef = useRef<Record<number, FaceMatchResult>>({});
  const selectedTrackIdRef = useRef<number | null>(null);
  const lockedTrackIdRef = useRef<number | null>(null);
  const multiLockedRef = useRef<Set<number>>(new Set());
  const searchTargetsRef = useRef<string[]>([]);
  const searchActiveRef = useRef(false);
  const runSearchMatchingRef = useRef<(tracks: TrackedFace[]) => Promise<void>>(async () => undefined);
  const drawOverlayRef = useRef<() => void>(() => undefined);
  const frameBusyRef = useRef(false);
  const lastStateSyncRef = useRef(0);
  const lastRenderFpsAtRef = useRef(performance.now());
  const renderFrameCountRef = useRef(0);
  const cropStateRef = useRef({ x: 0, y: 0 });

  const [cameraMode, setCameraMode] = useState<CameraMode>("photo");
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>("normal");
  const [videoQuality, setVideoQuality] = useState<VideoQualityId>("standard");
  const [stabilization, setStabilization] = useState<VideoStabilizationId>("standard");
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [workerBackend, setWorkerBackend] = useState<string>("準備中");
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<"device" | "digital">("digital");
  const [maxFacesSetting, setMaxFacesSetting] = useState(8);
  const [developerMode, setDeveloperMode] = useState(false);
  const [gridSettings, setGridSettings] = useState(DEFAULT_GRID_SETTINGS);
  const [facesSnapshot, setFacesSnapshot] = useState<TrackedFace[]>([]);
  const [metrics, setMetrics] = useState<VisionMetrics | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [lockedTrackId, setLockedTrackId] = useState<number | null>(null);
  const [multiLocked, setMultiLocked] = useState<Set<number>>(() => new Set());
  const [faceMenu, setFaceMenu] = useState<FaceMenuState | null>(null);
  const [registeredPeople, setRegisteredPeople] = useState<RegisteredPerson[]>([]);
  const [searchTargets, setSearchTargets] = useState<string[]>([]);
  const [searchActive, setSearchActive] = useState(false);
  const [matchResults, setMatchResults] = useState<Record<number, FaceMatchResult>>({});
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingNow, setRecordingNow] = useState(performance.now());
  const [recordingPreview, setRecordingPreview] = useState<RecordingPreview | null>(null);
  const [videoHistory, setVideoHistory] = useState<VideoHistoryItem[]>([]);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [deviceTilt, setDeviceTilt] = useState(0);
  const [autoPowerSuggestion, setAutoPowerSuggestion] = useState(false);

  const profile = PERFORMANCE_PROFILES[performanceMode];
  const qualityProfile = VIDEO_QUALITY_PROFILES[videoQuality];
  const stabilizationProfile = VIDEO_STABILIZATION_PROFILES[stabilization];
  const effectiveMaxFaces = Math.min(profile.maxFaces, maxFacesSetting);
  const mirrored = facingMode === "user";
  const activeTracks = facesSnapshot.filter((face) => face.status !== "lost");
  const selectedFace = facesSnapshot.find((face) => face.trackId === selectedTrackId) ?? null;
  const lockedFace = facesSnapshot.find((face) => face.trackId === lockedTrackId) ?? null;
  const multiLockedFaces = facesSnapshot.filter((face) => multiLocked.has(face.trackId));
  const trackInfo = getVideoTrackInfo(streamRef.current);
  const recordingDuration = recordingStartedAt ? recordingNow - recordingStartedAt : 0;
  const topAssist = useMemo(
    () =>
      buildAssistText({
        tracks: activeTracks,
        lockedFace,
        multiLockedFaces,
        zoom,
        cameraMode,
        isRecording,
        searchActive,
        deviceTilt,
      }),
    [activeTracks, lockedFace, multiLockedFaces, zoom, cameraMode, isRecording, searchActive, deviceTilt],
  );
  drawOverlayRef.current = drawOverlay;

  useEffect(() => {
    selectedTrackIdRef.current = selectedTrackId;
  }, [selectedTrackId]);

  useEffect(() => {
    lockedTrackIdRef.current = lockedTrackId;
  }, [lockedTrackId]);

  useEffect(() => {
    multiLockedRef.current = multiLocked;
  }, [multiLocked]);

  useEffect(() => {
    searchTargetsRef.current = searchTargets;
  }, [searchTargets]);

  useEffect(() => {
    searchActiveRef.current = searchActive;
  }, [searchActive]);

  useEffect(() => {
    matchResultsRef.current = matchResults;
  }, [matchResults]);

  useEffect(() => {
    runSearchMatchingRef.current = async (tracks: TrackedFace[]) => {
      if (searchTargetsRef.current.length === 0 || tracks.length === 0) {
        return;
      }
      const next: Record<number, FaceMatchResult> = {};
      for (const track of tracks.slice(0, effectiveMaxFaces)) {
        const candidates = await matchRegisteredPeople(track.descriptor, searchTargetsRef.current);
        const classification = classifyCandidates(candidates);
        if (classification.status !== "none") {
          next[track.trackId] = {
            trackId: track.trackId,
            status: classification.status,
            matchedName: classification.matchedName,
            candidates,
          };
        }
      }
      if (Object.keys(next).length > 0) {
        setMatchResults((current) => ({ ...current, ...next }));
      }
    };
  }, [effectiveMaxFaces]);

  useEffect(() => {
    void refreshPeople();
    void requestStoragePersistence();
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./workers/vision.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<VisionResponseMessage>) => {
      const message = event.data;
      if (message.type === "READY") {
        setWorkerBackend(message.backend);
        return;
      }
      if (message.type === "ERROR") {
        showToast("warning", message.message);
        return;
      }
      tracksRef.current = message.tracks;
      metricsRef.current = message.metrics;
      const now = performance.now();
      if (now - lastStateSyncRef.current > 120) {
        lastStateSyncRef.current = now;
        setFacesSnapshot(message.tracks);
        setMetrics(message.metrics);
      }
      if (searchActiveRef.current) {
        void runSearchMatchingRef.current(message.tracks);
      }
    };
    worker.postMessage({
      type: "INIT",
      detectorModelUrl: "/models/blaze_face_short_range.tflite",
      landmarkerModelUrl: "/models/face_landmarker.task",
      wasmBaseUrl: import.meta.env.DEV ? "/node_modules/@mediapipe/tasks-vision/wasm" : "/wasm",
      profile: PERFORMANCE_PROFILES.normal,
    });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({
      type: "CONFIG",
      profile,
      maxFaces: effectiveMaxFaces,
    });
  }, [effectiveMaxFaces, profile]);

  useEffect(() => {
    if (!cameraReady) {
      return;
    }
    let stopped = false;
    const sendFrame = async () => {
      const video = videoRef.current;
      const worker = workerRef.current;
      if (!video || !worker || stopped || frameBusyRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        window.setTimeout(sendFrame, 1000 / Math.max(1, profile.detectionFps));
        return;
      }
      if (!video.videoWidth || !video.videoHeight) {
        window.setTimeout(sendFrame, 1000 / Math.max(1, profile.detectionFps));
        return;
      }
      try {
        frameBusyRef.current = true;
        const bitmap = await createImageBitmap(video);
        worker.postMessage(
          {
            type: "FRAME",
            bitmap,
            timestamp: performance.now(),
            sourceWidth: video.videoWidth,
            sourceHeight: video.videoHeight,
            profile,
            maxFaces: effectiveMaxFaces,
          },
          [bitmap],
        );
      } catch (error) {
        showToast("warning", error instanceof Error ? error.message : "フレーム解析に失敗しました");
      } finally {
        frameBusyRef.current = false;
      }
      window.setTimeout(sendFrame, 1000 / Math.max(1, profile.detectionFps));
    };
    void sendFrame();
    return () => {
      stopped = true;
    };
  }, [cameraReady, effectiveMaxFaces, profile]);

  useEffect(() => {
    const render = () => {
      drawOverlayRef.current();
      renderFrameCountRef.current += 1;
      const now = performance.now();
      if (now - lastRenderFpsAtRef.current > 1000) {
        const currentMetrics = metricsRef.current;
        if (currentMetrics) {
          currentMetrics.renderFps = renderFrameCountRef.current;
        }
        renderFrameCountRef.current = 0;
        lastRenderFpsAtRef.current = now;
      }
      renderRafRef.current = requestAnimationFrame(render);
    };
    renderRafRef.current = requestAnimationFrame(render);
    return () => {
      if (renderRafRef.current) {
        cancelAnimationFrame(renderRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (isRecording) {
        setRecordingNow(performance.now());
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    const onMotion = (event: DeviceMotionEvent) => {
      const ax = event.accelerationIncludingGravity?.x ?? 0;
      const ay = event.accelerationIncludingGravity?.y ?? 0;
      const tilt = Math.atan2(ax, ay) || 0;
      setDeviceTilt(tilt);
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, []);

  useEffect(() => {
    const batteryApi = (navigator as Navigator & {
      getBattery?: () => Promise<{ level: number; charging: boolean }>;
    }).getBattery;
    if (!batteryApi) {
      return;
    }
    let cancelled = false;
    batteryApi.call(navigator).then((battery) => {
      if (!cancelled && battery.level < 0.18 && !battery.charging && performanceMode !== "powerSave") {
        setAutoPowerSuggestion(true);
        showToast("warning", "バッテリー低下のため省電力モードを提案しています");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [performanceMode]);

  const startCamera = useCallback(async (overrideFacingMode?: "environment" | "user") => {
    setCameraError(null);
    try {
      stopStream();
      const stream = await requestCameraStream({
        facingMode: overrideFacingMode ?? facingMode,
        quality: qualityProfile,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      const [track] = stream.getVideoTracks();
      if (track) {
        const result = await applyPreferredZoom(track, zoom);
        setZoomMode(result.mode);
      }
      showToast("info", "カメラを開始しました");
    } catch (error) {
      setCameraReady(false);
      setCameraError(error instanceof Error ? error.message : "カメラを開始できませんでした");
    }
  }, [facingMode, qualityProfile, zoom]);

  const switchFacing = async () => {
    const nextFacingMode = facingMode === "environment" ? "user" : "environment";
    setFacingMode(nextFacingMode);
    await startCamera(nextFacingMode);
  };

  const setZoomStep = async (nextZoom: number) => {
    setZoom(nextZoom);
    const [track] = streamRef.current?.getVideoTracks() ?? [];
    if (track) {
      const result = await applyPreferredZoom(track, nextZoom);
      setZoomMode(result.mode);
      if (!result.supported) {
        showToast("warning", `${nextZoom}x は端末ズーム非対応のため表示側で補助します`);
      }
    }
  };

  const changeVideoQuality = async (qualityId: VideoQualityId) => {
    setVideoQuality(qualityId);
    if (streamRef.current) {
      const settings = await applyVideoQuality(streamRef.current, VIDEO_QUALITY_PROFILES[qualityId]);
      showToast("info", `${settings.width ?? "-"}x${settings.height ?? "-"} / ${settings.frameRate ?? "-"}fps`);
    }
  };

  const toggleMultiLock = (trackId: number) => {
    setMultiLocked((current) => {
      const next = new Set(current);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  };

  const openFaceMenuFromCanvas = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    const transform = transformRef.current;
    if (!canvas || !transform) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const displayFaces = tracksRef.current
      .filter((track) => track.status !== "lost")
      .map((track) => ({ trackId: track.trackId, displayBox: sourceRectToDisplay(track.box, transform) }));
    const trackId = hitTestFaces(point, displayFaces);
    if (trackId === null) {
      setFaceMenu(null);
      setSelectedTrackId(null);
      return;
    }
    const sourcePoint = displayPointToSource(point, transform);
    setSelectedTrackId(trackId);
    setFaceMenu({
      trackId,
      x: Math.min(window.innerWidth - 220, Math.max(12, event.clientX)),
      y: Math.min(window.innerHeight - 360, Math.max(72, event.clientY)),
    });
    if (developerMode) {
      console.info("[coord-transform]", { point, sourcePoint, transform });
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      showToast("warning", "カメラ映像がまだ準備できていません");
      return;
    }
    const captures = await Promise.all([0, 80, 160].map((delay) => captureStillAfterDelay(video, delay)));
    const best = captures.sort((a, b) => a.motion - b.motion)[0];
    setPhotoPreview(best.url);
    showToast("info", "ブレの少ないフレームを選択しました");
  };

  const startRecording = () => {
    const video = videoRef.current;
    const canvas = recordCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      showToast("warning", "録画を開始できません");
      return;
    }
    const mimeType = selectRecorderMimeType();
    if (!mimeType) {
      showToast("critical", "このブラウザーでは録画形式を選べません");
      return;
    }
    const width = Math.min(video.videoWidth || qualityProfile.idealWidth, qualityProfile.idealWidth);
    const height = Math.round(width / (video.videoWidth / video.videoHeight || 16 / 9));
    canvas.width = width;
    canvas.height = height;
    const canvasStream = canvas.captureStream(qualityProfile.idealFps);
    recordingChunksRef.current = [];
    const recorder = new MediaRecorder(canvasStream, {
      mimeType,
      videoBitsPerSecond: qualityProfile.bitrate,
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordingChunksRef.current.push(event.data);
      }
    };
    const startedAt = performance.now();
    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: mimeType });
      setRecordingPreview({
        url: URL.createObjectURL(blob),
        blob,
        durationMs: performance.now() - startedAt,
        quality: videoQuality,
        createdAt: new Date().toISOString(),
      });
      setIsRecording(false);
      setRecordingStartedAt(null);
    };
    mediaRecorderRef.current = recorder;
    recorder.start(700);
    setIsRecording(true);
    setRecordingStartedAt(startedAt);
    drawRecordingCanvas();
  };

  const stopRecording = () => {
    if (recordDrawRafRef.current) {
      cancelAnimationFrame(recordDrawRafRef.current);
      recordDrawRafRef.current = null;
    }
    mediaRecorderRef.current?.stop();
  };

  const saveRecording = () => {
    if (!recordingPreview) {
      return;
    }
    const link = document.createElement("a");
    link.href = recordingPreview.url;
    link.download = `assist-camera-${new Date(recordingPreview.createdAt).toISOString().replace(/[:.]/g, "-")}.webm`;
    link.click();
    setVideoHistory((current) => [
      {
        id: crypto.randomUUID(),
        createdAt: recordingPreview.createdAt,
        quality: recordingPreview.quality,
        durationMs: recordingPreview.durationMs,
        sizeMb: estimateBlobMb(recordingPreview.blob.size),
      },
      ...current,
    ]);
    showToast("info", "動画をダウンロードしました");
  };

  const discardRecording = () => {
    if (recordingPreview) {
      URL.revokeObjectURL(recordingPreview.url);
    }
    setRecordingPreview(null);
  };

  const registerSelectedFace = async () => {
    const face = selectedFace;
    if (!face) {
      return;
    }
    const video = videoRef.current;
    const areaRatio = (face.box.width * face.box.height) / Math.max(1, (video?.videoWidth ?? 1) * (video?.videoHeight ?? 1));
    const quality = canRegisterFace(face.analysis, areaRatio);
    if (!quality.ok) {
      showToast("warning", `もう一度撮影してください: ${quality.reasons[0]}`);
      return;
    }
    const name = window.prompt("登録する名前", "");
    if (!name?.trim()) {
      return;
    }
    await saveDescriptor({
      name,
      vector: face.descriptor,
      analysis: face.analysis,
      iconDataUrl: captureFaceIcon(face),
    });
    await refreshPeople();
    showToast("info", "人物データを端末内DBに登録しました");
  };

  const matchSelectedFace = async () => {
    const face = selectedFace;
    if (!face) {
      return;
    }
    const candidates = await matchRegisteredPeople(face.descriptor);
    const classification = classifyCandidates(candidates);
    setMatchResults((current) => ({
      ...current,
      [face.trackId]: {
        trackId: face.trackId,
        status: classification.status,
        matchedName: classification.matchedName,
        candidates,
      },
    }));
    showMatchToast(candidates, classification.status);
  };

  async function refreshPeople() {
    setRegisteredPeople(await listPeople());
  }

  function showMatchToast(candidates: MatchCandidate[], status: FaceMatchResult["status"]) {
    if (status === "matched") {
      showToast("info", `${candidates[0].name} ${candidates[0].confidence}%`);
    } else if (status === "multiple") {
      showToast("warning", "候補が複数あります");
    } else if (status === "candidate") {
      showToast("info", `候補 ${candidates[0]?.confidence ?? 0}%`);
    } else {
      showToast("info", "一致候補はありません");
    }
  }

  function showToast(tone: ToastState["tone"], text: string) {
    setToast({ tone, text });
    window.setTimeout(() => {
      setToast((current) => (current?.text === text ? null : current));
    }, tone === "critical" ? 4200 : 2600);
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraReady(false);
  }

  function drawOverlay() {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!video.videoWidth || !video.videoHeight) {
      drawWaiting(ctx, rect.width, rect.height);
      return;
    }

    const visualZoom = zoomMode === "device" ? 1 : zoom;
    const transform = buildDisplayTransform({
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
      displayWidth: rect.width,
      displayHeight: rect.height,
      zoomScale: visualZoom,
      mirrorX: mirrored,
    });
    transformRef.current = transform;
    drawGuides(ctx, rect.width, rect.height);
    drawLevel(ctx, rect.width, rect.height);

    const tracks = tracksRef.current.filter((track) => track.status !== "lost");
    for (const track of tracks) {
      drawFaceBox(ctx, track, transform);
    }

    if (developerMode) {
      drawDebugOverlay(ctx, tracks, transform, rect.width);
    }
  }

  function drawFaceBox(CanvasCtx: CanvasRenderingContext2D, track: TrackedFace, transform: DisplayTransform) {
    const displayBox = sourceRectToDisplay(track.box, transform);
    const center = { x: displayBox.x + displayBox.width / 2, y: displayBox.y + displayBox.height / 2 };
    const isSelected = selectedTrackIdRef.current === track.trackId;
    const isLocked = lockedTrackIdRef.current === track.trackId;
    const isMulti = multiLockedRef.current.has(track.trackId);
    const match = matchResultsRef.current[track.trackId];
    const color = isLocked ? "#77f2a1" : isMulti ? "#82b7ff" : isSelected ? "#ffd166" : "rgba(235, 251, 255, 0.82)";
    const lineWidth = isSelected || isLocked || isMulti ? 2.6 : 1.2;

    CanvasCtx.save();
    CanvasCtx.translate(center.x, center.y);
    CanvasCtx.rotate(displayBox.angle ?? 0);
    CanvasCtx.strokeStyle = track.status === "predicted" ? "rgba(235, 251, 255, 0.42)" : color;
    CanvasCtx.lineWidth = lineWidth;
    CanvasCtx.setLineDash(track.status === "predicted" ? [6, 6] : []);
    drawCornerRect(CanvasCtx, -displayBox.width / 2, -displayBox.height / 2, displayBox.width, displayBox.height);
    CanvasCtx.restore();

    if (match?.status === "matched" && match.matchedName && match.candidates[0]?.confidence >= MATCH_LABEL_THRESHOLD) {
      drawLabel(CanvasCtx, match.matchedName, displayBox.x, Math.max(12, displayBox.y - 8), "#77f2a1");
    }
  }

  function drawGuides(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    if (gridSettings.grid) {
      for (let i = 1; i < 4; i += 1) {
        ctx.beginPath();
        ctx.moveTo((width / 4) * i, 0);
        ctx.lineTo((width / 4) * i, height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, (height / 4) * i);
        ctx.lineTo(width, (height / 4) * i);
        ctx.stroke();
      }
    }
    if (gridSettings.thirds) {
      ctx.strokeStyle = "rgba(119,242,161,0.28)";
      [1 / 3, 2 / 3].forEach((ratio) => {
        ctx.beginPath();
        ctx.moveTo(width * ratio, 0);
        ctx.lineTo(width * ratio, height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, height * ratio);
        ctx.lineTo(width, height * ratio);
        ctx.stroke();
      });
    }
    if (gridSettings.center) {
      ctx.strokeStyle = "rgba(255,209,102,0.35)";
      ctx.beginPath();
      ctx.moveTo(width / 2, height * 0.12);
      ctx.lineTo(width / 2, height * 0.88);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width * 0.12, height / 2);
      ctx.lineTo(width * 0.88, height / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLevel(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!gridSettings.level) {
      return;
    }
    const tilt = deviceTilt;
    ctx.save();
    ctx.translate(width / 2, height * 0.58);
    ctx.rotate(-tilt * 0.16);
    ctx.strokeStyle = Math.abs(tilt) > 0.24 ? "#ffd166" : "rgba(119,242,161,0.72)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-64, 0);
    ctx.lineTo(64, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawDebugOverlay(
    ctx: CanvasRenderingContext2D,
    tracks: TrackedFace[],
    transform: DisplayTransform,
    width: number,
  ) {
    ctx.save();
    ctx.font = "11px ui-monospace, Consolas, monospace";
    for (const track of tracks) {
      const displayBox = sourceRectToDisplay(track.box, transform);
      ctx.fillStyle = "rgba(5, 12, 24, 0.68)";
      ctx.fillRect(displayBox.x, displayBox.y + displayBox.height + 4, 178, 72);
      ctx.fillStyle = "#d9f7ff";
      ctx.fillText(`trackId ${track.trackId} ${track.status}`, displayBox.x + 8, displayBox.y + displayBox.height + 20);
      ctx.fillText(`conf ${track.confidence.toFixed(2)} IoU ${track.matchReason.iou.toFixed(2)}`, displayBox.x + 8, displayBox.y + displayBox.height + 36);
      ctx.fillText(`lost ${track.lostFrames} smooth ${track.matchScore.toFixed(2)}`, displayBox.x + 8, displayBox.y + displayBox.height + 52);
      ctx.fillText(`crop ${Math.round(transform.cropX)},${Math.round(transform.cropY)}`, displayBox.x + 8, displayBox.y + displayBox.height + 68);
      ctx.fillStyle = "#77f2a1";
      for (const point of track.landmarks.filter((_, index) => index % 18 === 0)) {
        const display = sourcePointToDisplay(point, transform);
        ctx.beginPath();
        ctx.arc(display.x, display.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "rgba(5, 12, 24, 0.58)";
    ctx.fillRect(width - 188, 80, 176, 78);
    ctx.fillStyle = "#d9f7ff";
    ctx.fillText(`backend ${workerBackend}`, width - 178, 98);
    ctx.fillText(`zoom ${zoom}x / ${zoomMode}`, width - 178, 116);
    ctx.fillText(`mirror ${mirrored ? "on" : "off"}`, width - 178, 134);
    ctx.fillText(`faces ${tracks.length}/${effectiveMaxFaces}`, width - 178, 152);
    ctx.restore();
  }

  function drawWaiting(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("カメラ準備中", width / 2, height / 2);
    ctx.restore();
  }

  function drawRecordingCanvas() {
    const video = videoRef.current;
    const canvas = recordCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !canvas || !ctx) {
      return;
    }
    const targetFace =
      lockedTrackIdRef.current !== null
        ? tracksRef.current.find((track) => track.trackId === lockedTrackIdRef.current)
        : null;
    const group = multiLockedRef.current.size
      ? tracksRef.current.filter((track) => multiLockedRef.current.has(track.trackId))
      : [];
    const focusBounds = group.length ? boundsForRects(group.map((track) => track.box)) : targetFace?.box ?? null;
    const sourceAspect = video.videoWidth / video.videoHeight;
    const targetAspect = canvas.width / canvas.height;
    let sx = 0;
    let sy = 0;
    let sw = video.videoWidth;
    let sh = video.videoHeight;
    if (sourceAspect > targetAspect) {
      sw = video.videoHeight * targetAspect;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = video.videoWidth / targetAspect;
      sy = (video.videoHeight - sh) / 2;
    }
    const cropPadding = stabilizationProfile.cropPadding;
    sw *= 1 - cropPadding;
    sh *= 1 - cropPadding;
    if (focusBounds && stabilizationProfile.lockPriority) {
      const targetCenter = {
        x: focusBounds.x + focusBounds.width / 2 - sw / 2,
        y: focusBounds.y + focusBounds.height / 2 - sh * 0.44,
      };
      cropStateRef.current = {
        x: cropStateRef.current.x + (targetCenter.x - cropStateRef.current.x) * stabilizationProfile.smoothing,
        y: cropStateRef.current.y + (targetCenter.y - cropStateRef.current.y) * stabilizationProfile.smoothing,
      };
      sx = Math.max(0, Math.min(video.videoWidth - sw, cropStateRef.current.x));
      sy = Math.max(0, Math.min(video.videoHeight - sh, cropStateRef.current.y));
    }
    ctx.save();
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    recordDrawRafRef.current = requestAnimationFrame(drawRecordingCanvas);
  }

  async function captureStillAfterDelay(video: HTMLVideoElement, delay: number): Promise<{ url: string; motion: number }> {
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("撮影用 canvas を作れません");
    }
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const motion =
      tracksRef.current.reduce((sum, track) => sum + Math.hypot(track.velocity.x, track.velocity.y), 0) /
      Math.max(1, tracksRef.current.length);
    return { url: canvas.toDataURL("image/jpeg", 0.92), motion };
  }

  function captureFaceIcon(face: TrackedFace): string | undefined {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return undefined;
    }
    const pad = Math.max(face.box.width, face.box.height) * 0.18;
    ctx.drawImage(
      video,
      Math.max(0, face.box.x - pad),
      Math.max(0, face.box.y - pad),
      Math.min(video.videoWidth, face.box.width + pad * 2),
      Math.min(video.videoHeight, face.box.height + pad * 2),
      0,
      0,
      96,
      96,
    );
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  return (
    <main className={`camera-app profile-${performanceMode}`} data-recording={isRecording}>
      <video
        ref={videoRef}
        className="camera-video"
        style={{
          transform: `${mirrored ? "scaleX(-1)" : "scaleX(1)"} scale(${zoomMode === "device" ? 1 : Math.max(1, zoom)})`,
        }}
        autoPlay
        muted
        playsInline
      />
      <canvas ref={overlayRef} className="camera-overlay" onPointerDown={openFaceMenuFromCanvas} />
      <canvas ref={recordCanvasRef} className="record-canvas" aria-hidden="true" />

      {!cameraReady && (
        <section className="permission-gate">
          <ScanFace size={34} />
          <h1>Assist Camera</h1>
          <p>端末内で顔検出・追跡・登録済み人物照合を行います。</p>
          {cameraError && <span className="error-text">{cameraError}</span>}
          <button type="button" className="primary-button" onClick={() => void startCamera()}>
            <Camera size={18} />
            カメラ開始
          </button>
        </section>
      )}

      <header className="top-toolbar">
        <div className="status-stack">
          <span className="status-chip">
            <ScanFace size={14} />
            検出中: {activeTracks.length}人
          </span>
          {lockedTrackId !== null && <span className="status-chip lock">ロックオン中</span>}
          {multiLocked.size > 0 && <span className="status-chip lock">複数ロック中: {multiLocked.size}人</span>}
          {searchActive && <span className="status-chip search">捜索中</span>}
        </div>
        <div className="top-actions">
          {isRecording && (
            <span className="record-indicator">
              <Circle size={10} fill="currentColor" />
              {formatDuration(recordingDuration)}
            </span>
          )}
          <button type="button" className="icon-button" onClick={switchFacing} aria-label="カメラ切替">
            <RotateCcw size={19} />
          </button>
          <button type="button" className="icon-button" onClick={() => setCameraMode("settings")} aria-label="設定">
            <Settings size={19} />
          </button>
        </div>
      </header>

      {topAssist && <div className={`assist-toast ${topAssist.tone}`}>{topAssist.text}</div>}
      {toast && <div className={`system-toast ${toast.tone}`}>{toast.text}</div>}

      <aside className="zoom-rail" aria-label="ズーム">
        {ZOOM_STEPS.map((step) => (
          <button
            type="button"
            key={step}
            className={zoom === step ? "active" : ""}
            onClick={() => void setZoomStep(step)}
          >
            {step}x
          </button>
        ))}
      </aside>

      <section className="bottom-toolbar">
        {cameraMode === "video" && (
          <div className="video-strip">
            <button type="button" onClick={() => void changeVideoQuality("light")}>
              軽量
            </button>
            <button type="button" className={videoQuality === "standard" ? "active" : ""} onClick={() => void changeVideoQuality("standard")}>
              標準
            </button>
            <button type="button" className={videoQuality === "high" ? "active" : ""} onClick={() => void changeVideoQuality("high")}>
              高画質
            </button>
            <button type="button" className={videoQuality === "max" ? "active" : ""} onClick={() => void changeVideoQuality("max")}>
              最大
            </button>
          </div>
        )}
        <div className="mode-switcher" role="tablist" aria-label="カメラモード">
          <button type="button" className={cameraMode === "photo" ? "active" : ""} onClick={() => setCameraMode("photo")}>
            写真
          </button>
          <button type="button" className={cameraMode === "video" ? "active" : ""} onClick={() => setCameraMode("video")}>
            動画
          </button>
          <button type="button" className={cameraMode === "search" ? "active" : ""} onClick={() => setCameraMode("search")}>
            捜索
          </button>
        </div>
        <div className="capture-row">
          <button type="button" className="small-round" onClick={() => setCameraMode("settings")} aria-label="設定">
            <SlidersHorizontal size={20} />
          </button>
          {cameraMode === "video" ? (
            <button
              type="button"
              className={`record-button ${isRecording ? "recording" : ""}`}
              onClick={isRecording ? stopRecording : startRecording}
              aria-label={isRecording ? "録画停止" : "録画開始"}
            >
              {isRecording ? <Square size={28} fill="currentColor" /> : <Circle size={34} fill="currentColor" />}
            </button>
          ) : (
            <button type="button" className="shutter-button" onClick={() => void capturePhoto()} aria-label="撮影">
              <span />
            </button>
          )}
          <button type="button" className="small-round" onClick={() => setCameraMode("search")} aria-label="捜索">
            <Search size={20} />
          </button>
        </div>
      </section>

      {faceMenu && (
        <FaceActionMenu
          state={faceMenu}
          selectedFace={selectedFace}
          isLocked={lockedTrackId === faceMenu.trackId}
          isMultiLocked={multiLocked.has(faceMenu.trackId)}
          match={matchResults[faceMenu.trackId]}
          onClose={() => setFaceMenu(null)}
          onLock={() => {
            setLockedTrackId(faceMenu.trackId);
            setFaceMenu(null);
          }}
          onUnlock={() => {
            setLockedTrackId(null);
            setFaceMenu(null);
          }}
          onMulti={() => toggleMultiLock(faceMenu.trackId)}
          onAnalyze={() => {
            const face = tracksRef.current.find((track) => track.trackId === faceMenu.trackId);
            showToast("info", face?.analysis.warnings[0] ?? "顔分析は良好です");
          }}
          onMatch={() => void matchSelectedFace()}
          onRegister={() => void registerSelectedFace()}
          onRelease={() => {
            setSelectedTrackId(null);
            setLockedTrackId((current) => (current === faceMenu.trackId ? null : current));
            setMultiLocked((current) => {
              const next = new Set(current);
              next.delete(faceMenu.trackId);
              return next;
            });
            setFaceMenu(null);
          }}
        />
      )}

      {cameraMode === "settings" && (
        <SettingsSheet
          performanceMode={performanceMode}
          onPerformanceMode={(mode) => {
            setPerformanceMode(mode);
            setAutoPowerSuggestion(false);
          }}
          maxFaces={maxFacesSetting}
          onMaxFaces={setMaxFacesSetting}
          developerMode={developerMode}
          onDeveloperMode={setDeveloperMode}
          gridSettings={gridSettings}
          onGridSettings={setGridSettings}
          videoQuality={videoQuality}
          onVideoQuality={(quality) => void changeVideoQuality(quality)}
          stabilization={stabilization}
          onStabilization={setStabilization}
          metrics={metrics}
          trackInfo={trackInfo}
          registeredPeople={registeredPeople}
          autoPowerSuggestion={autoPowerSuggestion}
          onClose={() => setCameraMode("photo")}
          onRename={async (id, name) => {
            await renamePerson(id, name);
            await refreshPeople();
          }}
          onDelete={async (id) => {
            await deletePerson(id);
            await refreshPeople();
          }}
          onClear={async () => {
            await clearFaceData();
            await refreshPeople();
            showToast("warning", "登録データを削除しました");
          }}
        />
      )}

      {cameraMode === "search" && (
        <SearchSheet
          people={registeredPeople}
          targets={searchTargets}
          active={searchActive}
          matches={matchResults}
          onToggleTarget={(id) =>
            setSearchTargets((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
          }
          onStart={() => {
            setSearchActive(true);
            showToast("info", "登録済み人物との候補照合を開始しました");
          }}
          onCancel={() => {
            setSearchActive(false);
            setMatchResults({});
          }}
        />
      )}

      {developerMode && (
        <DeveloperDebugOverlay
          metrics={metrics}
          tracks={facesSnapshot}
          transform={transformRef.current}
          backend={workerBackend}
          quality={videoQuality}
          stabilization={stabilization}
        />
      )}

      {photoPreview && (
        <PreviewSheet title="撮影結果" onClose={() => setPhotoPreview(null)}>
          <img src={photoPreview} alt="撮影結果" className="capture-preview" />
          <a className="primary-button" href={photoPreview} download="assist-camera-photo.jpg">
            <Download size={18} />
            保存
          </a>
        </PreviewSheet>
      )}

      {recordingPreview && (
        <PreviewSheet title="録画確認" onClose={discardRecording}>
          <video src={recordingPreview.url} className="capture-preview" controls />
          <div className="preview-actions">
            <button type="button" className="primary-button" onClick={saveRecording}>
              <Download size={18} />
              ダウンロード
            </button>
            <button type="button" className="secondary-button" onClick={discardRecording}>
              破棄
            </button>
          </div>
        </PreviewSheet>
      )}

      {videoHistory.length > 0 && cameraMode === "video" && (
        <div className="history-strip">
          {videoHistory.slice(0, 3).map((item) => (
            <span key={item.id}>
              {VIDEO_QUALITY_PROFILES[item.quality].label} / {formatDuration(item.durationMs)} / {item.sizeMb}MB
            </span>
          ))}
        </div>
      )}
    </main>
  );
}

function FaceActionMenu({
  state,
  selectedFace,
  isLocked,
  isMultiLocked,
  match,
  onClose,
  onLock,
  onUnlock,
  onMulti,
  onAnalyze,
  onMatch,
  onRegister,
  onRelease,
}: {
  state: FaceMenuState;
  selectedFace: TrackedFace | null;
  isLocked: boolean;
  isMultiLocked: boolean;
  match?: FaceMatchResult;
  onClose: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onMulti: () => void;
  onAnalyze: () => void;
  onMatch: () => void;
  onRegister: () => void;
  onRelease: () => void;
}) {
  return (
    <div className="face-menu" style={{ left: state.x, top: state.y }}>
      <div className="face-menu-header">
        <span>trackId {state.trackId}</span>
        <button type="button" onClick={onClose} aria-label="閉じる">
          <X size={16} />
        </button>
      </div>
      {match && (
        <p className="match-summary">
          {match.status === "matched"
            ? `${match.matchedName} ${match.candidates[0]?.confidence ?? 0}%`
            : match.status === "multiple"
              ? "候補が複数あります"
              : match.status === "candidate"
                ? `候補 ${match.candidates[0]?.confidence ?? 0}%`
                : "候補なし"}
        </p>
      )}
      <button type="button" onClick={isLocked ? onUnlock : onLock}>
        <Lock size={16} />
        {isLocked ? "ロックオン解除" : "ロックオン"}
      </button>
      <button type="button" onClick={onMulti}>
        <Users size={16} />
        {isMultiLocked ? "複数ロックから外す" : "複数ロックに追加"}
      </button>
      <button type="button" onClick={onAnalyze}>
        <Activity size={16} />
        顔分析
      </button>
      <button type="button" onClick={onMatch}>
        <Database size={16} />
        データベース照合
      </button>
      <button type="button" onClick={onRegister} disabled={!selectedFace}>
        <UserPlus size={16} />
        名前を登録
      </button>
      <button type="button" onClick={onRelease}>
        <Trash2 size={16} />
        追跡解除
      </button>
      <button type="button" onClick={onClose}>
        <X size={16} />
        キャンセル
      </button>
    </div>
  );
}

function SettingsSheet({
  performanceMode,
  onPerformanceMode,
  maxFaces,
  onMaxFaces,
  developerMode,
  onDeveloperMode,
  gridSettings,
  onGridSettings,
  videoQuality,
  onVideoQuality,
  stabilization,
  onStabilization,
  metrics,
  trackInfo,
  registeredPeople,
  autoPowerSuggestion,
  onClose,
  onRename,
  onDelete,
  onClear,
}: {
  performanceMode: PerformanceMode;
  onPerformanceMode: (mode: PerformanceMode) => void;
  maxFaces: number;
  onMaxFaces: (value: number) => void;
  developerMode: boolean;
  onDeveloperMode: (value: boolean) => void;
  gridSettings: typeof DEFAULT_GRID_SETTINGS;
  onGridSettings: (value: typeof DEFAULT_GRID_SETTINGS) => void;
  videoQuality: VideoQualityId;
  onVideoQuality: (value: VideoQualityId) => void;
  stabilization: VideoStabilizationId;
  onStabilization: (value: VideoStabilizationId) => void;
  metrics: VisionMetrics | null;
  trackInfo: ReturnType<typeof getVideoTrackInfo>;
  registeredPeople: RegisteredPerson[];
  autoPowerSuggestion: boolean;
  onClose: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="sheet settings-sheet">
      <div className="sheet-header">
        <h2>設定</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">
          <X size={19} />
        </button>
      </div>

      <div className="setting-group">
        <div className="group-title">
          <Gauge size={18} />
          動作モード
        </div>
        <div className="segmented-control">
          {(Object.keys(PERFORMANCE_PROFILES) as PerformanceMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={performanceMode === mode ? "active" : ""}
              onClick={() => onPerformanceMode(mode)}
            >
              {PERFORMANCE_PROFILES[mode].label}
              <small>{PERFORMANCE_PROFILES[mode].description}</small>
            </button>
          ))}
        </div>
        {autoPowerSuggestion && (
          <button type="button" className="suggestion" onClick={() => onPerformanceMode("powerSave")}>
            <Battery size={16} />
            省電力へ切り替え
          </button>
        )}
        <div className="metric-line">
          <span>推定FPS {metrics?.detectionFps ?? "-"} / {metrics?.renderFps ?? "-"}</span>
          <span>負荷 {performanceMode === "max" ? "高" : performanceMode === "normal" ? "中" : "低"}</span>
          <span>発熱リスク {performanceMode === "max" ? "高" : "低-中"}</span>
        </div>
      </div>

      <div className="setting-group two-column">
        <label>
          最大検出人数
          <input
            type="range"
            min="1"
            max="8"
            value={maxFaces}
            onChange={(event) => onMaxFaces(Number(event.target.value))}
          />
          <span>{maxFaces}人</span>
        </label>
        <label className="toggle-row">
          開発者モード
          <input type="checkbox" checked={developerMode} onChange={(event) => onDeveloperMode(event.target.checked)} />
        </label>
      </div>

      <div className="setting-group">
        <div className="group-title">
          <Video size={18} />
          動画画質
        </div>
        <div className="segmented-control compact">
          {(Object.keys(VIDEO_QUALITY_PROFILES) as VideoQualityId[]).map((quality) => (
            <button
              type="button"
              key={quality}
              className={videoQuality === quality ? "active" : ""}
              onClick={() => onVideoQuality(quality)}
            >
              {VIDEO_QUALITY_PROFILES[quality].label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-group">
        <div className="group-title">
          <Maximize2 size={18} />
          手ブレ補助
        </div>
        <div className="segmented-control compact wrap">
          {(Object.keys(VIDEO_STABILIZATION_PROFILES) as VideoStabilizationId[]).map((item) => (
            <button
              type="button"
              key={item}
              className={stabilization === item ? "active" : ""}
              onClick={() => onStabilization(item)}
            >
              {VIDEO_STABILIZATION_PROFILES[item].label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-group">
        <div className="group-title">
          <Grid3X3 size={18} />
          補助線
        </div>
        {(["grid", "thirds", "center", "level"] as const).map((key) => (
          <label className="toggle-row" key={key}>
            {key === "grid" ? "グリッド" : key === "thirds" ? "三分割" : key === "center" ? "中央線" : "水平器"}
            <input
              type="checkbox"
              checked={gridSettings[key]}
              onChange={(event) => onGridSettings({ ...gridSettings, [key]: event.target.checked })}
            />
          </label>
        ))}
      </div>

      <div className="setting-group">
        <div className="group-title">
          <Database size={18} />
          登録済み人物
        </div>
        <div className="person-list">
          {registeredPeople.length === 0 && <p className="empty-text">登録データはありません</p>}
          {registeredPeople.map((person) => (
            <div className="person-row" key={person.id}>
              <div className="avatar">{person.iconDataUrl ? <img src={person.iconDataUrl} alt="" /> : person.name.slice(0, 1)}</div>
              <div>
                <strong>{person.name}</strong>
                <span>
                  {person.descriptors.length}枚 / {new Date(person.updatedAt).toLocaleDateString()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const name = window.prompt("名前変更", person.name);
                  if (name) onRename(person.id, name);
                }}
              >
                変更
              </button>
              <button type="button" onClick={() => onDelete(person.id)}>
                削除
              </button>
            </div>
          ))}
        </div>
        {registeredPeople.length > 0 && (
          <button type="button" className="danger-button" onClick={onClear}>
            全データ削除
          </button>
        )}
      </div>

      {developerMode && (
        <div className="setting-group dev-grid">
          <span>camera {trackInfo.settings?.width ?? "-"}x{trackInfo.settings?.height ?? "-"}</span>
          <span>display {window.innerWidth}x{window.innerHeight}</span>
          <span>detection fps {metrics?.detectionFps ?? "-"}</span>
          <span>tracked {metrics?.trackedFaces ?? "-"}</span>
          <span>lost {metrics?.lostTracks ?? "-"}</span>
          <span>inference {metrics?.averageInferenceMs.toFixed(1) ?? "-"}ms</span>
          <span>latency {metrics?.workerLatencyMs.toFixed(1) ?? "-"}ms</span>
          <span>memory {metrics?.memoryEstimateMb ?? "-"}MB</span>
        </div>
      )}
    </section>
  );
}

function SearchSheet({
  people,
  targets,
  active,
  matches,
  onToggleTarget,
  onStart,
  onCancel,
}: {
  people: RegisteredPerson[];
  targets: string[];
  active: boolean;
  matches: Record<number, FaceMatchResult>;
  onToggleTarget: (id: string) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="sheet search-sheet">
      <div className="sheet-header">
        <h2>捜索</h2>
        <span>{active ? `捜索中: ${targets.length}人` : "対象を選択"}</span>
      </div>
      <div className="person-list">
        {people.length === 0 && <p className="empty-text">人物が登録されていません</p>}
        {people.map((person) => (
          <button
            type="button"
            className={`person-row selectable ${targets.includes(person.id) ? "active" : ""}`}
            key={person.id}
            onClick={() => onToggleTarget(person.id)}
          >
            <div className="avatar">{person.iconDataUrl ? <img src={person.iconDataUrl} alt="" /> : person.name.slice(0, 1)}</div>
            <div>
              <strong>{person.name}</strong>
              <span>{person.descriptors.length}データ</span>
            </div>
          </button>
        ))}
      </div>
      <div className="preview-actions">
        <button type="button" className="primary-button" disabled={targets.length === 0} onClick={onStart}>
          <Search size={18} />
          この人物を探す
        </button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          キャンセル
        </button>
      </div>
      {Object.values(matches).length > 0 && (
        <div className="search-results">
          {Object.values(matches).map((match) => (
            <span key={match.trackId}>
              trackId {match.trackId}:{" "}
              {match.status === "matched"
                ? `${match.matchedName} ${match.candidates[0]?.confidence ?? 0}%`
                : `候補 ${match.candidates[0]?.confidence ?? 0}%`}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function DeveloperDebugOverlay({
  metrics,
  tracks,
  transform,
  backend,
  quality,
  stabilization,
}: {
  metrics: VisionMetrics | null;
  tracks: TrackedFace[];
  transform: DisplayTransform | null;
  backend: string;
  quality: VideoQualityId;
  stabilization: VideoStabilizationId;
}) {
  return (
    <aside className="developer-overlay">
      <strong>Developer</strong>
      <span>backend: {backend}</span>
      <span>camera: {metrics?.cameraWidth ?? "-"}x{metrics?.cameraHeight ?? "-"}</span>
      <span>detection fps: {metrics?.detectionFps ?? "-"}</span>
      <span>render fps: {metrics?.renderFps ?? "-"}</span>
      <span>tracked: {metrics?.trackedFaces ?? "-"}</span>
      <span>lost: {metrics?.lostTracks ?? "-"}</span>
      <span>inference: {metrics?.averageInferenceMs.toFixed(1) ?? "-"}ms</span>
      <span>worker latency: {metrics?.workerLatencyMs.toFixed(1) ?? "-"}ms</span>
      <span>memory: {metrics?.memoryEstimateMb ?? "-"}MB</span>
      <span>quality: {quality}</span>
      <span>stabilization: {stabilization}</span>
      <span>crop: {transform ? `${Math.round(transform.cropX)}, ${Math.round(transform.cropY)}` : "-"}</span>
      <span>tracks: {tracks.map((track) => `${track.trackId}:${track.status}:${track.lostFrames}`).join(" / ")}</span>
    </aside>
  );
}

function PreviewSheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <section className="sheet preview-sheet">
      <div className="sheet-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">
          <X size={18} />
        </button>
      </div>
      {children}
    </section>
  );
}

function buildAssistText(params: {
  tracks: TrackedFace[];
  lockedFace: TrackedFace | null;
  multiLockedFaces: TrackedFace[];
  zoom: number;
  cameraMode: CameraMode;
  isRecording: boolean;
  searchActive: boolean;
  deviceTilt: number;
}): ToastState | null {
  const { tracks, lockedFace, multiLockedFaces, zoom, cameraMode, isRecording, searchActive, deviceTilt } = params;
  if (isRecording && lockedFace) {
    if (lockedFace.status === "predicted") {
      return { tone: "warning", text: "対象を見失いました" };
    }
    return { tone: "info", text: "対象ロック中" };
  }
  if (searchActive) {
    return { tone: "info", text: "登録済み人物との候補照合中" };
  }
  if (multiLockedFaces.length > 1) {
    const nearEdge = multiLockedFaces.find((face) => face.box.x < 80 || face.box.x + face.box.width > 1840);
    if (nearEdge) {
      return { tone: "warning", text: nearEdge.box.x < 80 ? "左の人が切れそう" : "右の人が切れそう" };
    }
    return { tone: "info", text: "複数ロック中" };
  }
  const primary = lockedFace ?? tracks[0];
  if (!primary) {
    return cameraMode === "video" ? { tone: "info", text: "録画準備中" } : null;
  }
  if (primary.analysis.warnings.length > 0) {
    return { tone: primary.analysis.blur === "high" ? "warning" : "info", text: primary.analysis.warnings[0] };
  }
  if (zoom >= 5) {
    return { tone: "warning", text: "高倍率のため画質劣化に注意" };
  }
  if (Math.abs(deviceTilt) > 0.34) {
    return { tone: "info", text: deviceTilt > 0 ? "少し左に傾いています" : "少し右に傾いています" };
  }
  return null;
}

function drawCornerRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  const length = Math.min(width, height) * 0.22;
  ctx.beginPath();
  ctx.moveTo(x, y + length);
  ctx.lineTo(x, y);
  ctx.lineTo(x + length, y);
  ctx.moveTo(x + width - length, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + length);
  ctx.moveTo(x + width, y + height - length);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x + width - length, y + height);
  ctx.moveTo(x + length, y + height);
  ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + height - length);
  ctx.stroke();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.save();
  ctx.font = "12px system-ui, sans-serif";
  const width = ctx.measureText(text).width + 14;
  ctx.fillStyle = "rgba(4, 10, 18, 0.72)";
  ctx.fillRect(x, y - 18, width, 22);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 7, y - 4);
  ctx.restore();
}

export default App;
