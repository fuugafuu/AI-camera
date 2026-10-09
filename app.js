/* A.R.C. VISION - browser-only object detection HUD.
 * Visual scanner effects are decorative; measurements originate from the ML model.
 * Camera/image frames are not uploaded by this app.
 */
const $ = id => document.getElementById(id);
const el = {
  video: $('camera'), image: $('still'), canvas: $('overlay'), viewport: $('viewport'),
  standby: $('standby'), standbyTitle: $('standbyTitle'), standbyHelp: $('standbyHelp'), standbyEyebrow: $('standbyEyebrow'),
  scanLine: $('scanLine'), feedShade: document.querySelector('.feed-shade'), reticle: $('reticle'),
  btnCamera: $('btnCamera'), cameraText: $('cameraText'), btnImage: $('btnImage'), btnFlip: $('btnFlip'), btnSnapshot: $('btnSnapshot'),
  btnTracking: $('btnTracking'), btnPause: $('btnPause'), btnAudio: $('btnAudio'),
  threshold: $('threshold'), thresholdLabel: $('thresholdLabel'), file: $('filePicker'),
  count: $('countReadout'), fps: $('fpsReadout'), speed: $('inferenceMs'), modelTag: $('modelTag'),
  resolution: $('resolutionTag'), feedMode: $('feedModeTag'), status: $('statusText'), liveDot: $('liveDot'), cpu: $('cpuCore'), signal: $('signalBars'),
  objectList: $('objectsList'), objectCount: $('objectsCounter'), targetState: $('targetState'), targetName: $('targetName'), targetLatin: $('targetLatin'),
  confidence: $('confidenceText'), confidenceBar: $('confidenceBar'), area: $('areaText'), pos: $('positionText'), track: $('trackText'), bbox: $('boxText'),
  note: $('analysisNote'), analysisFooter: $('analysisFooter'), pulse: document.querySelector('.tiny-pulse'), clock: $('clock'),
  toast: $('toast'), bootInfo: $('bootInfo'), bootInfoText: $('bootInfoText'), closeInfo: $('closeInfo')
};
const MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
const VISION_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const labels = {
 person:'人物', bicycle:'自転車', car:'車', motorcycle:'バイク', airplane:'飛行機', bus:'バス', train:'列車', truck:'トラック', boat:'船',
 'traffic light':'信号機', 'fire hydrant':'消火栓', 'stop sign':'一時停止標識', 'parking meter':'駐車メーター', bench:'ベンチ', bird:'鳥', cat:'猫', dog:'犬', horse:'馬', sheep:'羊', cow:'牛', elephant:'ゾウ', bear:'クマ', zebra:'シマウマ', giraffe:'キリン',
 backpack:'リュック', umbrella:'傘', handbag:'ハンドバッグ', tie:'ネクタイ', suitcase:'スーツケース', frisbee:'フリスビー', skis:'スキー', snowboard:'スノーボード', 'sports ball':'ボール', kite:'凧', 'baseball bat':'野球バット', 'baseball glove':'野球グローブ', skateboard:'スケートボード', surfboard:'サーフボード', 'tennis racket':'テニスラケット',
 bottle:'ボトル', 'wine glass':'ワイングラス', cup:'カップ', fork:'フォーク', knife:'ナイフ', spoon:'スプーン', bowl:'ボウル', banana:'バナナ', apple:'リンゴ', sandwich:'サンドイッチ', orange:'オレンジ', broccoli:'ブロッコリー', carrot:'ニンジン', 'hot dog':'ホットドッグ', pizza:'ピザ', donut:'ドーナツ', cake:'ケーキ',
 chair:'椅子', couch:'ソファ', 'potted plant':'鉢植え', bed:'ベッド', 'dining table':'テーブル', toilet:'トイレ', tv:'テレビ', laptop:'ノートPC', mouse:'マウス', remote:'リモコン', keyboard:'キーボード', 'cell phone':'スマートフォン', microwave:'電子レンジ', oven:'オーブン', toaster:'トースター', sink:'シンク', refrigerator:'冷蔵庫', book:'本', clock:'時計', vase:'花瓶', scissors:'はさみ', 'teddy bear':'テディベア', 'hair drier':'ドライヤー', toothbrush:'歯ブラシ'
};
let detector = null;
let loadingPromise = null;
let stream = null;
let mode = 'standby';
let detectorMode = 'VIDEO';
let frameToken = 0;
let tracks = new Map();
let nextId = 1;
let serial = 0;
let shown = [];
let lastRawDetections = [];
let chosenId = null;
let autoLock = true;
let paused = false;
let soundOn = false;
let soundContext = null;
let facing = 'environment';
let objectUrl = null;
let lastProcessed = 0;
let lastVideoTime = -1;
let lastInference = 0;
let fpsWindow = [];
let threshold = Number(el.threshold.value) / 100;
let inferenceBusy = false;
let startupSession = 0;
let lastBleepTarget = null;
let toastTimer = 0;
const ctx = el.canvas.getContext('2d', { alpha: true });

function friendlyError(error) {
  const kind = error?.name || '';
  if (kind === 'NotAllowedError' || kind === 'PermissionDeniedError') return 'カメラの許可が必要です。ブラウザーのサイト設定でカメラを許可してください。';
  if (kind === 'NotFoundError' || kind === 'DevicesNotFoundError') return '利用できるカメラが見つかりません。';
  if (kind === 'NotReadableError' || kind === 'TrackStartError') return 'カメラが他のアプリで使用中の可能性があります。';
  if (!window.isSecureContext) return 'カメラにはHTTPSで公開されたページ（またはlocalhost）が必要です。';
  return '処理を開始できませんでした。ネット接続、モデルの取得、ブラウザーの対応状況を確認してください。';
}
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4500);
}
function setStatus(value, active = false) {
  el.status.textContent = value;
  el.liveDot.classList.toggle('active', active);
  el.cpu.classList.toggle('running', active);
  el.signal.classList.toggle('working', active);
  el.pulse.classList.toggle('active', active);
}
function setStandby(title, description, eyebrow = 'SYSTEM STATUS') {
  el.standby.classList.remove('hidden');
  el.standbyTitle.textContent = title;
  el.standbyHelp.textContent = description;
  el.standbyEyebrow.textContent = eyebrow;
}
function clearStandby() { el.standby.classList.add('hidden'); }
function updateClock() { el.clock.textContent = new Date().toLocaleTimeString('ja-JP', { hour12: false }); }
updateClock(); setInterval(updateClock, 1000);
function source() {
  if (mode === 'camera' && el.video.videoWidth) return { element: el.video, width: el.video.videoWidth, height: el.video.videoHeight };
  if (mode === 'image' && el.image.naturalWidth) return { element: el.image, width: el.image.naturalWidth, height: el.image.naturalHeight };
  return null;
}
function resetTracking() {
  tracks.clear(); nextId = 1; serial = 0; chosenId = null; lastBleepTarget = null;
  shown = []; lastRawDetections = []; fpsWindow = []; lastInference = 0; lastProcessed = 0; lastVideoTime = -1;
  updateResults(); draw();
}
async function ensureDetector() {
  if (detector) return detector;
  if (loadingPromise) return loadingPromise;
  setStatus('AI LOADING');
  el.modelTag.textContent = 'LOADING';
  el.bootInfo.style.display = 'flex';
  el.bootInfoText.textContent = '軽量AIモデルと実行エンジンを読み込み中です。初回は通信が必要です。';
  loadingPromise = (async () => {
    const { ObjectDetector, FilesetResolver } = await import(`${VISION_BASE}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);
    detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO', scoreThreshold: 0.2, maxResults: 18,
    });
    detectorMode = 'VIDEO';
    el.modelTag.textContent = 'LITE-0';
    el.bootInfo.style.display = 'none';
    return detector;
  })();
  try { return await loadingPromise; }
  catch (err) {
    console.error('A.R.C. model initialization failed', err);
    el.modelTag.textContent = 'ERROR';
    el.bootInfo.style.display = 'flex';
    el.bootInfoText.textContent = 'AIモデルを読み込めませんでした。オンライン接続を確認して再試行してください。';
    throw err;
  } finally { loadingPromise = null; }
}
async function configureDetector(nextMode) {
  if (detectorMode === nextMode) return;
  await detector.setOptions({ runningMode: nextMode });
  detectorMode = nextMode;
}
function stopCameraTracks() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; el.video.srcObject = null;
}
function leaveMode() {
  frameToken++; startupSession++;
  stopCameraTracks();
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  el.video.style.display = 'none'; el.video.style.transform = '';
  el.image.style.display = 'none'; el.image.hidden = true; el.image.removeAttribute('src');
  el.feedShade.classList.remove('live'); el.scanLine.classList.remove('active'); el.reticle.classList.remove('active');
  el.btnFlip.disabled = true; el.btnSnapshot.disabled = true; el.btnPause.disabled = true;
  el.btnPause.classList.remove('active'); el.btnPause.setAttribute('aria-pressed', 'false'); el.btnPause.innerHTML = '<span class="chip-dot"></span> 一時停止';
  paused = false; mode = 'standby'; $('app').classList.remove('has-feed'); el.cameraText.textContent = 'カメラを起動'; el.btnCamera.classList.remove('running');
  el.feedMode.textContent = 'NO SIGNAL'; el.resolution.textContent = 'SENSOR: UNAVAILABLE';
  resetTracking();
}
async function startCamera() {
  if (mode === 'camera') {
    leaveMode(); setStatus(detector ? 'SYSTEM READY' : 'STANDBY');
    setStandby('VISION ONLINE', 'カメラを起動するか、画像を読み込んでください', 'SYSTEM INITIALIZED');
    return;
  }
  leaveMode();
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    toast('スマホのカメラはHTTPSで公開されたサイトから使用してください。', true);
    setStandby('CAMERA BLOCKED', 'HTTPSで開くか「画像を解析」を使用してください', 'ACCESS REQUIRED');
    return;
  }
  const session = ++startupSession;
  el.cameraText.textContent = '接続中…';
  setStatus('CAM CONNECT');
  try {
    // Must be requested early, directly from the user gesture on mobile Safari.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
    });
    if (session !== startupSession) { stream.getTracks().forEach(t => t.stop()); return; }
    el.video.srcObject = stream;
    el.video.style.display = 'block';
    el.video.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
    await el.video.play();
    if (session !== startupSession) return;
    mode = 'camera'; $('app').classList.add('has-feed');
    el.btnFlip.disabled = false; el.btnSnapshot.disabled = false; el.btnPause.disabled = false;
    el.btnCamera.classList.add('running'); el.cameraText.textContent = 'カメラを停止';
    el.feedShade.classList.add('live'); el.scanLine.classList.add('active'); el.reticle.classList.add('active');
    el.feedMode.textContent = facing === 'user' ? 'FRONT / LIVE' : 'REAR / LIVE';
    el.resolution.textContent = `SENSOR: ${el.video.videoWidth}×${el.video.videoHeight}`;
    clearStandby();
    setStatus('AI LOADING');
    await ensureDetector();
    if (session !== startupSession || mode !== 'camera') return;
    await configureDetector('VIDEO');
    setStatus('LIVE SCANNING', true);
    const token = ++frameToken;
    requestAnimationFrame(() => processVideo(token));
  } catch (err) {
    console.error('A.R.C. camera failed', err);
    if (session !== startupSession) return;
    leaveMode();
    setStatus('SYSTEM ERROR');
    setStandby('ACCESS ERROR', 'カメラ・AIの初期化に失敗しました', 'SYSTEM ALERT');
    toast(friendlyError(err), true);
  }
}
async function flipCamera() {
  if (mode !== 'camera') return;
  facing = facing === 'environment' ? 'user' : 'environment';
  leaveMode();
  await startCamera();
}
async function loadImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('画像ファイルを選択してください。', true); return; }
  leaveMode();
  const session = ++startupSession;
  mode = 'image'; $('app').classList.add('has-feed');
  setStatus('IMAGE LOADING');
  setStandby('ANALYZING', '画像を読み込んでいます', 'IMAGE INTELLIGENCE');
  objectUrl = URL.createObjectURL(file);
  el.image.src = objectUrl;
  el.image.hidden = false; el.image.style.display = 'block';
  try {
    await el.image.decode();
    if (session !== startupSession) return;
    el.feedShade.classList.add('live'); el.scanLine.classList.add('active');
    el.feedMode.textContent = 'STILL IMAGE / LOCAL';
    el.resolution.textContent = `IMAGE: ${el.image.naturalWidth}×${el.image.naturalHeight}`;
    el.btnSnapshot.disabled = false;
    setStandby('ANALYZING', 'AIモデルで画像を分析しています', 'ON-DEVICE PROCESSING');
    await ensureDetector();
    if (session !== startupSession || mode !== 'image') return;
    await configureDetector('IMAGE');
    const begin = performance.now();
    const result = detector.detect(el.image);
    lastInference = performance.now() - begin;
    processDetections(result.detections || []);
    clearStandby();
    el.scanLine.classList.remove('active');
    setStatus('IMAGE ANALYZED', true);
  } catch (err) {
    if (session !== startupSession) return;
    console.error('A.R.C. image failed', err);
    setStatus('SYSTEM ERROR');
    setStandby('ANALYSIS ERROR', '画像の読み込みまたは解析に失敗しました', 'SYSTEM ALERT');
    toast(friendlyError(err), true);
  }
}
function processVideo(token) {
  if (token !== frameToken || mode !== 'camera') return;
  if (document.hidden || paused || !detector || inferenceBusy || el.video.readyState < 2) {
    requestAnimationFrame(() => processVideo(token));
    return;
  }
  const now = performance.now();
  if (now - lastProcessed >= 115 && el.video.currentTime !== lastVideoTime) {
    inferenceBusy = true; lastProcessed = now; lastVideoTime = el.video.currentTime;
    try {
      const t0 = performance.now();
      const result = detector.detectForVideo(el.video, t0);
      lastInference = performance.now() - t0;
      fpsWindow.push(performance.now());
      if (fpsWindow.length > 12) fpsWindow.shift();
      processDetections(result.detections || []);
    } catch (err) {
      console.error('A.R.C. inference error', err);
      pause(); toast('連続解析でエラーが発生しました。いったん停止してください。', true);
    } finally { inferenceBusy = false; }
  }
  if (token === frameToken) requestAnimationFrame(() => processVideo(token));
}
function boxArea(b) { return Math.max(0, b.width) * Math.max(0, b.height); }
function overlap(a,b) {
  const ix = Math.max(0, Math.min(a.originX+a.width,b.originX+b.width)-Math.max(a.originX,b.originX));
  const iy = Math.max(0, Math.min(a.originY+a.height,b.originY+b.height)-Math.max(a.originY,b.originY));
  const intersection=ix*iy;
  return intersection / Math.max(1,boxArea(a)+boxArea(b)-intersection);
}
function processDetections(raw) {
  lastRawDetections = raw;
  serial++;
  const src = source();
  if (!src) return;
  const candidates = raw.map(d => ({
    label: d.categories?.[0]?.categoryName || 'unknown',
    score: d.categories?.[0]?.score || 0,
    box: d.boundingBox
  })).filter(d => d.box && d.score >= threshold).sort((a,b) => b.score-a.score).slice(0,18);
  const matched = new Set();
  shown = candidates.map(obj => {
    const centerX = (obj.box.originX + obj.box.width/2)/src.width;
    const centerY = (obj.box.originY + obj.box.height/2)/src.height;
    let best = null, bestValue = -1;
    for (const previous of tracks.values()) {
      if (previous.label !== obj.label || matched.has(previous.id) || serial-previous.seen > 5) continue;
      const close = Math.hypot(centerX-previous.cx,centerY-previous.cy);
      const io = overlap(obj.box,previous.box);
      if (close > .28 && io < .03) continue;
      const rank = io*2.4 + Math.max(0,.28-close);
      if (rank > bestValue) { best = previous; bestValue = rank; }
    }
    const id = best ? best.id : nextId++;
    matched.add(id);
    const t = { ...obj, id, cx:centerX, cy:centerY, seen:serial };
    tracks.set(id,t);
    return t;
  });
  for (const [id,t] of tracks) if (serial - t.seen > 9) tracks.delete(id);
  if (chosenId !== null && !shown.some(t=>t.id===chosenId)) {
    if (!tracks.has(chosenId)) chosenId = null;
  }
  if (autoLock && chosenId === null && shown.length) chosenId = shown[0].id;
  if (autoLock && shown.length && !shown.some(t=>t.id===chosenId)) chosenId = shown[0].id;
  const currentTarget = shown.find(t=>t.id===chosenId);
  if (currentTarget && soundOn && lastBleepTarget !== currentTarget.id) { beep(); lastBleepTarget = currentTarget.id; }
  if (!currentTarget) lastBleepTarget = null;
  updateResults(); draw();
}
function activeTarget() { return shown.find(t=>t.id===chosenId) || null; }
function positionLabel(cx,cy) {
  const x = cx < 1/3 ? '左' : cx > 2/3 ? '右' : '中央';
  const y = cy < 1/3 ? '上' : cy > 2/3 ? '下' : '中央';
  return x==='中央'&&y==='中央' ? '中央' : `${y}・${x}`;
}
function updateResults() {
  const target = activeTarget();
  el.count.textContent = String(shown.length).padStart(2,'0');
  el.objectCount.textContent = String(shown.length).padStart(2,'0');
  el.speed.textContent = lastInference ? `${Math.round(lastInference)} ms` : '-- ms';
  const rate = fpsWindow.length >= 2 ? (fpsWindow.length-1)*1000/(fpsWindow.at(-1)-fpsWindow[0]) : 0;
  el.fps.textContent = rate ? rate.toFixed(1) : mode==='image'?'1×':'--';
  el.objectList.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement('span'); empty.className = 'empty-objects';
    empty.textContent = mode === 'standby' ? 'NO OBJECTS TRACKED' : '検出対象なし';
    el.objectList.append(empty);
  }
  shown.forEach(t => {
    const btn = document.createElement('button');
    btn.type='button'; btn.className=`object-item${chosenId===t.id?' active':''}`;
    btn.setAttribute('aria-label',`${labels[t.label]||t.label}、信頼度${Math.round(t.score*100)}%、ターゲットに設定`);
    const id = document.createElement('span');id.className='object-id';id.textContent=`#${String(t.id).padStart(2,'0')}`;
    const name=document.createElement('span');name.className='object-name';name.textContent=labels[t.label]||t.label;
    const score=document.createElement('span');score.className='object-score';score.textContent=`${Math.round(t.score*100)}%`;
    btn.append(id,name,score); btn.addEventListener('click',()=>lockTarget(t.id));
    el.objectList.append(btn);
  });
  el.targetState.textContent=target?'TARGET LOCK':'NO TARGET';
  el.targetState.classList.toggle('locked',!!target);
  el.targetName.textContent=target?(labels[target.label]||target.label):'— — —';
  el.targetLatin.textContent=target?target.label.toUpperCase():'AWAITING ACQUISITION';
  el.confidence.textContent=target?`${(target.score*100).toFixed(1)}%`:'--%';
  el.confidenceBar.style.width=target?`${target.score*100}%`:'0%';
  if (target) {
    const src = source();
    el.area.textContent=src?`${Math.min(100,boxArea(target.box)/src.width/src.height*100).toFixed(1)}%`:'—';
    el.pos.textContent=positionLabel(target.cx,target.cy);
    el.track.textContent=`#${String(target.id).padStart(3,'0')} / 短期追尾`;
    el.bbox.textContent=`${Math.round(target.box.width)}×${Math.round(target.box.height)} px`;
    el.analysisFooter.textContent='VISUAL MATCH CONFIRMED';
    el.note.textContent=`${labels[target.label]||target.label}として認識。検出範囲は画面内で${el.area.textContent}を占めています。実際の距離・素材・危険度は推定していません。`;
  } else {
    el.area.textContent='—';el.pos.textContent='—';el.track.textContent='—';el.bbox.textContent='—';
    el.note.textContent='検出された対象をタップするとロックできます。距離・素材・危険度などは、このモデルからは判定できません。';
    el.analysisFooter.textContent=mode==='standby'?'WAITING FOR INPUT':'SCANNING ENVIRONMENT';
  }
}
function lockTarget(id) {
  if (!shown.some(t=>t.id===id)) return;
  chosenId=id; autoLock=false; el.btnTracking.classList.remove('active'); el.btnTracking.setAttribute('aria-pressed','false');
  updateResults(); draw();
  if (soundOn) beep();
}
function coverRect(srcW,srcH,w,h) {
  const scale=Math.max(w/srcW,h/srcH);
  return {scale, x:(w-srcW*scale)/2, y:(h-srcH*scale)/2};
}
function visualBox(t, w, h) {
  const src = source(); if (!src) return null;
  const map = coverRect(src.width,src.height,w,h);
  let x=map.x+t.box.originX*map.scale;
  if (mode==='camera' && facing==='user') x=w-(map.x+(t.box.originX+t.box.width)*map.scale);
  return {x, y:map.y+t.box.originY*map.scale, w:t.box.width*map.scale, h:t.box.height*map.scale};
}
function roundedFill(context,x,y,w,h,r=4) {
  context.beginPath(); context.roundRect(x,y,Math.max(1,w),Math.max(1,h),r);context.fill();
}
function draw() {
  const rect=el.canvas.getBoundingClientRect();
  const w=rect.width, h=rect.height;
  if (!w || !h) return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const pw=Math.round(w*dpr), ph=Math.round(h*dpr);
  if(el.canvas.width!==pw||el.canvas.height!==ph){el.canvas.width=pw;el.canvas.height=ph;}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  if (!source()) return;
  for (const t of shown) {
    const box=visualBox(t,w,h); if(!box) continue;
    const selected=t.id===chosenId;
    const c=selected?'#ffc387':'#7af7ff';
    const {x,y,w:bw,h:bh}=box;
    if (x > w || y > h || x+bw < 0 || y+bh < 0) continue;
    ctx.save();ctx.strokeStyle=c;ctx.fillStyle=c;
    ctx.shadowColor=c;ctx.shadowBlur=selected?13:6;ctx.lineWidth=selected?2.2:1.4;
    ctx.globalAlpha=selected?.97:.75;
    const corner=Math.min(22,Math.max(8,Math.min(bw,bh)*.2));
    ctx.beginPath();
    // Four HUD corner brackets, rather than a misleading segmentation silhouette.
    ctx.moveTo(x,y+corner);ctx.lineTo(x,y);ctx.lineTo(x+corner,y);
    ctx.moveTo(x+bw-corner,y);ctx.lineTo(x+bw,y);ctx.lineTo(x+bw,y+corner);
    ctx.moveTo(x,y+bh-corner);ctx.lineTo(x,y+bh);ctx.lineTo(x+corner,y+bh);
    ctx.moveTo(x+bw-corner,y+bh);ctx.lineTo(x+bw,y+bh);ctx.lineTo(x+bw,y+bh-corner);
    ctx.stroke();ctx.shadowBlur=0;
    ctx.strokeStyle=selected?'#ffca9670':'#7af7ff42';ctx.lineWidth=1;ctx.setLineDash([4,6]);
    ctx.strokeRect(x+.5,y+.5,bw,bh);ctx.setLineDash([]);
    const text=`${String(t.id).padStart(2,'0')}  ${labels[t.label]||t.label}  ${Math.round(t.score*100)}%`;
    const fontsize=w<600?10:12;
    ctx.font=`600 ${fontsize}px ui-monospace, system-ui, sans-serif`;
    const tw=ctx.measureText(text).width+17;
    const bx=Math.max(4,Math.min(w-tw-4,x));
    const by=y>28?y-22:y+3;
    ctx.fillStyle=selected?'#5b351edb':'#043746d7';
    roundedFill(ctx,bx,by,tw,20,2);
    ctx.strokeStyle=selected?'#f1b37390':'#6bfaff64';ctx.lineWidth=1;ctx.strokeRect(bx,by,tw,20);
    ctx.fillStyle=selected?'#ffd49c':'#aefaff';ctx.fillText(text,bx+8,by+14);
    if(selected){
      const cx=x+bw/2,cy=y+bh/2;
      ctx.strokeStyle='#ffc3879a';ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(cx,cy,14,0,Math.PI*2);ctx.moveTo(cx-22,cy);ctx.lineTo(cx-7,cy);ctx.moveTo(cx+7,cy);ctx.lineTo(cx+22,cy);ctx.moveTo(cx,cy-22);ctx.lineTo(cx,cy-7);ctx.moveTo(cx,cy+7);ctx.lineTo(cx,cy+22);ctx.stroke();
      ctx.fillStyle='#ffd59a';ctx.fillRect(cx-1.5,cy-1.5,3,3);
    }
    ctx.restore();
  }
}
function pause(){if(mode!=='camera')return;paused=!paused;el.btnPause.classList.toggle('active',paused);el.btnPause.setAttribute('aria-pressed',String(paused));el.btnPause.innerHTML=`<span class="chip-dot"></span> ${paused?'再開':'一時停止'}`;setStatus(paused?'SCAN PAUSED':'LIVE SCANNING',!paused);el.scanLine.classList.toggle('active',!paused);if(!paused)lastProcessed=0;}
async function beep() {
  try {
    if(!soundContext) soundContext=new (window.AudioContext||window.webkitAudioContext)();
    if(soundContext.state==='suspended') await soundContext.resume();
    const oscillator=soundContext.createOscillator();const gain=soundContext.createGain();
    oscillator.type='sine';oscillator.frequency.setValueAtTime(620,soundContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(900,soundContext.currentTime+.085);
    gain.gain.setValueAtTime(.0001,soundContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.07,soundContext.currentTime+.015);
    gain.gain.exponentialRampToValueAtTime(.0001,soundContext.currentTime+.14);
    oscillator.connect(gain);gain.connect(soundContext.destination);oscillator.start();oscillator.stop(soundContext.currentTime+.15);
  } catch {} // WebAudio can be unavailable or restricted by OS.
}
async function saveSnapshot() {
  const src=source(); if(!src){toast('先にカメラか画像を読み込んでください。',true);return;}
  const w=el.canvas.clientWidth,h=el.canvas.clientHeight;
  const output=document.createElement('canvas');const scale=Math.min(2,window.devicePixelRatio||1);
  output.width=Math.round(w*scale);output.height=Math.round(h*scale);
  const c=output.getContext('2d');c.scale(scale,scale);
  c.fillStyle='#020a12';c.fillRect(0,0,w,h);
  const map=coverRect(src.width,src.height,w,h);
  if(mode==='camera'&&facing==='user') {c.save();c.translate(w,0);c.scale(-1,1);c.drawImage(src.element,map.x,map.y,src.width*map.scale,src.height*map.scale);c.restore();}
  else c.drawImage(src.element,map.x,map.y,src.width*map.scale,src.height*map.scale);
  c.drawImage(el.canvas,0,0,w,h);
  c.fillStyle='#061924dd';c.fillRect(0,0,w,33);
  c.fillStyle='#91f6ff';c.font='bold 14px ui-monospace, monospace';c.fillText('A.R.C. // VISION SCAN',14,22);
  c.fillStyle='#ffcf9c';c.font='10px ui-monospace, monospace';
  c.fillText(`${shown.length} DETECTED  |  LOCAL AI`,Math.max(14,w-194),22);
  output.toBlob(async blob=>{
    if(!blob){toast('画像の保存に失敗しました。',true);return;}
    const name=`ARC_SCAN_${new Date().toISOString().slice(0,19).replaceAll(':','-')}.png`;
    const file=new File([blob],name,{type:'image/png'});
    if(navigator.canShare?.({files:[file]}) && /iPhone|iPad|iPod/.test(navigator.userAgent)){
      try { await navigator.share({files:[file],title:'A.R.C. VISION'});return; }
      catch(err) {if(err.name==='AbortError') return;}
    }
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    toast('解析画面を書き出しました。');
  },'image/png');
}
function onCanvasTap(e) {
  const rect=el.canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;
  const hit=shown.filter(t=>{const b=visualBox(t,rect.width,rect.height);return b&&x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h;}).sort((a,b)=>boxArea(a.box)-boxArea(b.box));
  if(hit.length) lockTarget(hit[0].id);
}
el.btnCamera.addEventListener('click',startCamera);
el.btnFlip.addEventListener('click',flipCamera);
el.btnImage.addEventListener('click',()=>el.file.click());
el.file.addEventListener('change',async()=>{const file=el.file.files?.[0];el.file.value='';if(file)await loadImage(file);});
el.btnSnapshot.addEventListener('click',saveSnapshot);
el.btnPause.addEventListener('click',pause);
el.btnTracking.addEventListener('click',()=>{autoLock=!autoLock;el.btnTracking.classList.toggle('active',autoLock);el.btnTracking.setAttribute('aria-pressed',String(autoLock));if(autoLock&&shown.length){chosenId=shown[0].id;updateResults();draw();}});
el.btnAudio.addEventListener('click',()=>{soundOn=!soundOn;el.btnAudio.classList.toggle('active',soundOn);el.btnAudio.setAttribute('aria-pressed',String(soundOn));el.btnAudio.innerHTML=`<span class="chip-dot"></span> SOUND ${soundOn?'ON':'OFF'}`;if(soundOn)beep();});
el.threshold.addEventListener('input',()=>{threshold=Number(el.threshold.value)/100;el.thresholdLabel.textContent=`${el.threshold.value}%`;if(mode==='image')processDetections(lastRawDetections);else{shown=shown.filter(t=>t.score>=threshold);if(chosenId!==null&&!shown.some(t=>t.id===chosenId))chosenId=null;updateResults();draw();}});
el.canvas.addEventListener('click',onCanvasTap);
el.closeInfo.addEventListener('click',()=>el.bootInfo.style.display='none');
window.addEventListener('resize',draw);
document.addEventListener('visibilitychange',()=>{if(mode==='camera'&&!document.hidden){lastProcessed=0;} });
window.addEventListener('pagehide',stopCameraTracks);
if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
  navigator.serviceWorker.register('./sw.js').catch(err=>console.info('Offline cache not available:',err));
}
updateResults();
draw();