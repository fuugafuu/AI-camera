/* A.R.C. VISION V2 + V3 – lazy, on-device extensions.
   No camera pixels leave this application. Models, JS and OCR language packs are downloaded on demand.
   Radar / velocity are image-plane measurements only; never distance or true 360-degree sensing. */
const $=id=>document.getElementById(id);
const VISION_BASE='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const POSE_MODEL='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const GESTURE_MODEL='https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const SEGMENT_MODEL='https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';
const VOC_CLASSES={airplane:1,bicycle:2,bird:3,boat:4,bottle:5,bus:6,car:7,cat:8,chair:9,cow:10,'dining table':11,dog:12,horse:13,motorcycle:14,person:15,'potted plant':16,sheep:17,couch:18,train:19,tv:20};
const BONE_PAIRS=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[28,30],[29,31],[30,32],[0,11],[0,12]];
const MODE_CAPTIONS={pose:'BODY SCAN',segment:'OUTLINE',gesture:'GESTURE'};
const HISTORY_KEY='arc-vision-history-v3';
const KEY_GUIDE={Open_Palm:'レーダー表示切替',Closed_Fist:'手に近い対象をロック',Thumb_Up:'ターゲットを自動選択',Victory:'解析を一時停止 / 再開'};

export function createAdvancedHub(api){
  const ui={
    pose:$('btnPose'),segment:$('btnSegment'),gesture:$('btnGesture'),ocr:$('btnOCR'),radar:$('btnRadar'),history:$('btnHistory'),
    radarWrap:$('radarModule'),radarCanvas:$('radarCanvas'),radarCount:$('radarCount'),
    msg:$('upgradeMessage'),perf:$('perfText'),drawer:$('upgradeDrawer'),drawerTitle:$('drawerTitle'),
    drawerBody:$('drawerBody'),drawerActions:$('drawerActions'),close:$('btnDrawerClose'),backdrop:$('drawerBackdrop')
  };
  const state={pose:false,segment:false,gesture:false,radar:true};
  const tasks={};const pending={};const runningModes={};const transitions={};
  let visionPromise=null,poseLandmarks=[],gestureLandmarks=[],segmentData=null,segmentedLabel=null;
  let lastPose=0,lastGesture=0,lastSegment=0,activeGesture='',gestureRepeat=0,lastGestureAction=0;
  let lastOCR='',lastLog='',lastLogTime=0,gestureName='',radarVisible=true;
  const tstamp=()=>new Date().toLocaleString('ja-JP',{hour12:false});
  const msg=s=>{ui.msg.textContent=s;};
  const status=(label,phase)=>{ui.perf.textContent=phase||label;};
  const smallTarget=t=> t ? `${t.label} · ${Math.round(t.score*100)}%`:'NO TARGET';
  const historyRead=()=>{try{const a=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(a)?a:[]}catch{return[]}};
  function record(type,detail){
    try{const records=historyRead();records.unshift({id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),time:tstamp(),type,detail:String(detail).slice(0,340)});
      localStorage.setItem(HISTORY_KEY,JSON.stringify(records.slice(0,120)));
    }catch{msg('履歴を保存できません。プライベートモードや端末の保存容量をご確認ください。');}
  }
  async function getVision(){
    if(!visionPromise)visionPromise=(async()=>{const mod=await import(`${VISION_BASE}/vision_bundle.mjs`);const vision=await mod.FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);return {...mod,vision};})().catch(e=>{visionPromise=null;throw e});
    return visionPromise;
  }
  async function getTask(which){
    if(tasks[which])return tasks[which];
    if(pending[which])return pending[which];
    msg(`${MODE_CAPTIONS[which]} · AIモデル読み込み中…`);
    pending[which]=(async()=>{
      const {vision,PoseLandmarker,ImageSegmenter,GestureRecognizer}=await getVision();
      let instance;
      if(which==='pose') instance=await PoseLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:POSE_MODEL,delegate:'CPU'},runningMode:'IMAGE',numPoses:2,outputSegmentationMasks:false});
      if(which==='gesture') instance=await GestureRecognizer.createFromOptions(vision,{baseOptions:{modelAssetPath:GESTURE_MODEL,delegate:'CPU'},runningMode:'IMAGE',numHands:1});
      if(which==='segment') instance=await ImageSegmenter.createFromOptions(vision,{baseOptions:{modelAssetPath:SEGMENT_MODEL,delegate:'CPU'},runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
      tasks[which]=instance;runningModes[which]='IMAGE';msg(`${MODE_CAPTIONS[which]} · 起動完了`);return instance;
    })();
    try{return await pending[which]}finally{delete pending[which];}
  }
  async function configure(which,desired){
    const task=await getTask(which);
    if(transitions[which])await transitions[which];
    if(runningModes[which]!==desired){
      transitions[which]=task.setOptions({runningMode:desired});
      try{await transitions[which];runningModes[which]=desired;}finally{delete transitions[which];}
    }
    return task;
  }
  async function toggleMode(which){
    state[which]=!state[which];const button=ui[which];button.classList.toggle('active',state[which]);button.setAttribute('aria-pressed',String(state[which]));
    if(!state[which]){
      if(which==='pose')poseLandmarks=[];
      if(which==='segment'){segmentData=null;segmentedLabel=null;}
      if(which==='gesture'){gestureLandmarks=[];gestureName='';}
      api.refresh();msg(`${MODE_CAPTIONS[which]} · OFF`);return;
    }
    // Use one extra vision model at a time to keep mobile memory/CPU budget under control.
    for(const other of ['pose','gesture','segment'])if(other!==which&&state[other]){
      state[other]=false;ui[other].classList.remove('active');ui[other].setAttribute('aria-pressed','false');
    }
    if(which!=='pose')poseLandmarks=[];
    if(which!=='gesture'){gestureLandmarks=[];gestureName='';}
    if(which!=='segment'){segmentData=null;segmentedLabel=null;}
    try{
      await getTask(which);
      if(!state[which])return;
      if(api.getMode()==='image'){await runForImage(which);}
      else if(api.getMode()==='standby')msg(`${MODE_CAPTIONS[which]} 準備完了 · カメラか画像を読み込んでください`);
    }catch(e){
      console.error('A.R.C. extension initialization',which,e);
      state[which]=false;button.classList.remove('active');button.setAttribute('aria-pressed','false');
      api.toast(`${MODE_CAPTIONS[which]} を利用できません。モデル取得・対応状況を確認してください。`,true);msg(`${MODE_CAPTIONS[which]} · ERROR`);
    }
    api.refresh();
  }
  function collectPose(result){poseLandmarks=(result.landmarks||[]).map(points=>points.map(p=>({x:p.x,y:p.y,visibility:p.visibility??1})));msg(`BODY SCAN · ${poseLandmarks.length} 人検出 / 姿勢推定`);}
  function collectGesture(result){
    gestureLandmarks=result.landmarks||[];
    const g=result.gestures?.[0]?.[0];
    const name=g?.score>=.70?g.categoryName:'';
    if(name&&name===activeGesture)gestureRepeat++;else{activeGesture=name;gestureRepeat=1;}
    gestureName=name;
    if(name&&gestureRepeat>=2&&performance.now()-lastGestureAction>2600){
      lastGestureAction=performance.now();gestureRepeat=0;
      if(name==='Open_Palm')toggleRadar();
      if(name==='Closed_Fist'){
        const hand=gestureLandmarks?.[0]?.[9];const tracks=api.getTracks();
        const chosen=tracks.slice().sort((a,b)=>Math.hypot(a.cx-(hand?.x??.5),a.cy-(hand?.y??.5))-Math.hypot(b.cx-(hand?.x??.5),b.cy-(hand?.y??.5)))[0];
        if(chosen)api.lockTarget(chosen.id);
      }
      if(name==='Thumb_Up'){const best=api.getTracks()[0];if(best)api.lockTarget(best.id);}
      if(name==='Victory')api.onPause();
      msg(`GESTURE ${name} → ${KEY_GUIDE[name]||'検出'}`);
      if(KEY_GUIDE[name])record('GESTURE',`${name} / ${KEY_GUIDE[name]}`);
    }else if(name)msg(`GESTURE · ${name} / ${KEY_GUIDE[name]||'認識'}`);
    else msg('GESTURE · 手をカメラに向けてください');
  }
  function updateSegmentation(result){
    const m=result.categoryMask;
    if(!m){segmentData=null;msg('OUTLINE · セグメンテーション結果がありません');return;}
    segmentData={data:new Uint8Array(m.getAsUint8Array()),width:m.width,height:m.height};
    m.close?.();
    segmentedLabel=null;renderSegmentation();
  }
  function renderSegmentation(){
    if(!segmentData)return;
    const selected=api.getSelected()||api.getTracks()[0];
    if(!selected){segmentedLabel=null;segmentData.outline=null;msg('OUTLINE · 対象を検出して選択してください');return;}
    const category=VOC_CLASSES[selected.label];
    if(!category){segmentData.outline=null;segmentedLabel=null;msg(`${selected.label} は輪郭AIの分類対象外です (20クラス対応)`);return;}
    const {width:W,height:H,data}=segmentData;
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    const c=canvas.getContext('2d',{willReadFrequently:true});const image=c.createImageData(W,H),pixels=image.data;
    const src=api.getSource();if(!src)return;
    const box=selected.box;
    const x0=Math.max(0,Math.floor(box.originX/src.width*W)-3),y0=Math.max(0,Math.floor(box.originY/src.height*H)-3);
    const x1=Math.min(W,Math.ceil((box.originX+box.width)/src.width*W)+3),y1=Math.min(H,Math.ceil((box.originY+box.height)/src.height*H)+3);
    let edges=0;
    const matches=(x,y)=>x>=x0&&y>=y0&&x<x1&&y<y1&&data[y*W+x]===category;
    for(let y=Math.max(1,y0);y<Math.min(H-1,y1);y++)for(let x=Math.max(1,x0);x<Math.min(W-1,x1);x++){
      if(!matches(x,y))continue;
      const at=(y*W+x)*4;
      pixels[at]=34;pixels[at+1]=210;pixels[at+2]=240;pixels[at+3]=42;
      if(!matches(x-1,y)||!matches(x+1,y)||!matches(x,y-1)||!matches(x,y+1)){
        pixels[at]=255;pixels[at+1]=185;pixels[at+2]=105;pixels[at+3]=242;edges++;
      }
    }
    c.putImageData(image,0,0);
    segmentData.outline=canvas;segmentedLabel=selected.label+'#'+selected.id;
    msg(edges?`OUTLINE · ${selected.label} クラスの推定輪郭を抽出`:`OUTLINE · ${selected.label} の輪郭は見つかりませんでした`);
  }
  async function runForImage(which){
    const src=api.getSource();if(!src||api.getMode()!=='image')return;
    const task=await configure(which,'IMAGE');if(!state[which])return;
    try{
      if(which==='pose')collectPose(task.detect(src.element));
      if(which==='gesture')collectGesture(task.recognize(src.element));
      if(which==='segment')updateSegmentation(task.segment(src.element));
      api.refresh();
    }catch(e){console.error('ARC still extension',e);api.toast('追加AIによる画像解析に失敗しました。',true);}
  }
  function onFrame(frame,t){
    // Called from a throttled detector loop. Extension inference is deliberately infrequent.
    if(api.getPaused())return;
    const which=state.pose?'pose':state.gesture?'gesture':state.segment?'segment':null;
    if(!which||!tasks[which]||runningModes[which]!=='VIDEO'){
      if(which&&tasks[which]&&runningModes[which]==='IMAGE'){
        // Async reconfiguration is cheap; frames resume on next detector iteration.
        configure(which,'VIDEO').catch(e=>{console.error(e);msg(`${which} mode switch error`)});
      }
      return;
    }
    const interval=which==='pose'?650:which==='gesture'?490:1600;
    const last=which==='pose'?lastPose:which==='gesture'?lastGesture:lastSegment;
    if(t-last<interval)return;
    if(which==='pose')lastPose=t;if(which==='gesture')lastGesture=t;if(which==='segment')lastSegment=t;
    try{
      if(which==='pose')collectPose(tasks.pose.detectForVideo(frame,t));
      if(which==='gesture')collectGesture(tasks.gesture.recognizeForVideo(frame,t));
      if(which==='segment')updateSegmentation(tasks.segment.segmentForVideo(frame,t));
      api.refresh();
    }catch(e){console.error(`ARC ${which} video`,e);state[which]=false;ui[which].classList.remove('active');ui[which].setAttribute('aria-pressed','false');api.toast(`${MODE_CAPTIONS[which]} の処理を停止しました。`,true);}
    const perf=api.getPerformance();status('AUTO',`AUTO · ${Math.round(perf.frameInterval)} ms interval`);
  }
  function drawOverlay(ctx,w,h){
    const src=api.getSource();if(!src)return;
    if(state.segment&&segmentData?.outline){
      const fit=api.coverRect(src.width,src.height,w,h);
      ctx.save();ctx.globalAlpha=.94;
      if(api.getMode()==='camera'&&api.getFacing()==='user'){ctx.translate(w,0);ctx.scale(-1,1);}
      ctx.shadowColor='#ffae63';ctx.shadowBlur=9;
      ctx.drawImage(segmentData.outline,fit.x,fit.y,src.width*fit.scale,src.height*fit.scale);ctx.restore();
    }
    if(state.pose&&poseLandmarks.length){
      ctx.save();ctx.lineWidth=2;ctx.shadowColor='#36e7ff';ctx.shadowBlur=9;
      for(const landmarks of poseLandmarks){
        ctx.strokeStyle='#42eeffe6';ctx.fillStyle='#b8fcff';
        for(const [a,b] of BONE_PAIRS){
          if(!landmarks[a]||!landmarks[b]||landmarks[a].visibility<.48||landmarks[b].visibility<.48)continue;
          const p=api.mapPoint(landmarks[a].x,landmarks[a].y,w,h),q=api.mapPoint(landmarks[b].x,landmarks[b].y,w,h);
          ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();
        }
        for(const i of [0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]){
          const p=landmarks[i];if(!p||p.visibility<.48)continue;
          const pt=api.mapPoint(p.x,p.y,w,h);ctx.beginPath();ctx.arc(pt.x,pt.y,3.1,0,Math.PI*2);ctx.fill();
        }
      }ctx.restore();
    }
    if(state.gesture&&gestureLandmarks.length){
      ctx.save();ctx.strokeStyle='#ffd29f';ctx.fillStyle='#fff3d9';ctx.shadowColor='#ffb85c';ctx.shadowBlur=7;
      for(const pts of gestureLandmarks){
        const chains=[[0,1,2,3,4],[0,5,6,7,8],[0,9,10,11,12],[0,13,14,15,16],[0,17,18,19,20],[5,9,13,17]];
        for(const chain of chains){ctx.beginPath();chain.forEach((i,j)=>{const p=api.mapPoint(pts[i].x,pts[i].y,w,h);if(j)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y)});ctx.stroke();}
        for(const i of [0,4,8,12,16,20]){const p=api.mapPoint(pts[i].x,pts[i].y,w,h);ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();}
      }ctx.restore();
    }
  }
  function radarPaint(){
    if(!radarVisible)return;
    const canvas=ui.radarCanvas,c=canvas.getContext('2d');const w=canvas.width,h=canvas.height;
    c.clearRect(0,0,w,h);
    const mid={x:w/2,y:h/2},sx=w*.46,sy=h*.39;
    c.strokeStyle='#58eafc33';c.lineWidth=1;
    for(const r of [.3,.6,1]){c.beginPath();c.ellipse(mid.x,mid.y,sx*r,sy*r,0,0,Math.PI*2);c.stroke();}
    c.beginPath();c.moveTo(mid.x,6);c.lineTo(mid.x,h-6);c.moveTo(9,mid.y);c.lineTo(w-9,mid.y);c.stroke();
    c.fillStyle='#92f5ff';c.font='9px ui-monospace,monospace';c.fillText('TOP',8,12);c.fillText('FIELD 100%',w-80,h-8);
    for(const t of api.getTracks()){
      const displayX=api.getMode()==='camera'&&api.getFacing()==='user'?1-t.cx:t.cx;
      const x=mid.x+(displayX-.5)*sx*2,y=mid.y+(t.cy-.5)*sy*2;
      c.fillStyle=t.id===api.getSelected()?.id?'#ffc38c':'#74f8ff';
      c.shadowColor=c.fillStyle;c.shadowBlur=11;c.beginPath();c.arc(x,y,t.id===api.getSelected()?.id?4.5:3,0,Math.PI*2);c.fill();c.shadowBlur=0;
      c.font='10px ui-monospace,monospace';c.fillText('#'+t.id,x+6,y-5);
    }
    ui.radarCount.textContent=`${api.getTracks().length} SIGNAL`;
  }
  function toggleRadar(){
    radarVisible=!radarVisible;state.radar=radarVisible;ui.radarWrap.hidden=!radarVisible;
    ui.radar.classList.toggle('active',radarVisible);ui.radar.setAttribute('aria-pressed',String(radarVisible));
    if(radarVisible)radarPaint();
  }
  function openDrawer(title){ui.drawer.hidden=false;ui.drawerTitle.textContent=title;ui.drawerBody.replaceChildren();ui.drawerActions.replaceChildren();}
  function closeDrawer(){ui.drawer.hidden=true;}
  function textButton(label,fn,extraClass=''){
    const b=document.createElement('button');b.type='button';b.className='drawer-action '+extraClass;b.textContent=label;b.addEventListener('click',fn);return b;
  }
  function field(text,className=''){const p=document.createElement('p');p.className=className;p.textContent=text;return p;}
  function downloadText(name,content,type='application/json'){
    const blob=new Blob([content],{type:type+';charset=utf-8'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  function displayHistory(){
    openDrawer('SCAN HISTORY');
    const history=historyRead();
    ui.drawerBody.append(field('履歴はこの端末のブラウザにのみ保存。映像や写真は記録しません。最大120件。','drawer-hint'));
    if(!history.length)ui.drawerBody.append(field('履歴はまだありません。物体の検出・ターゲットロック・OCR結果などを記録します。','drawer-empty'));
    for(const item of history){
      const card=document.createElement('div');card.className='history-item';
      const top=document.createElement('div');top.className='history-top';
      const typ=document.createElement('b');typ.textContent=item.type;
      const date=document.createElement('span');date.textContent=item.time;
      top.append(typ,date);card.append(top,field(item.detail));ui.drawerBody.append(card);
    }
    ui.drawerActions.append(textButton('JSONで書き出す',()=>downloadText(`arc-history-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(history,null,2))));
    ui.drawerActions.append(textButton('すべて削除',()=>{
      if(!window.confirm('この端末に保存した解析履歴をすべて削除しますか？'))return;
      try{localStorage.removeItem(HISTORY_KEY);}catch{}
      displayHistory();api.toast('端末内の分析履歴を削除しました。');
    },'danger'));
  }
  async function loadTesseract(){
    if(window.Tesseract?.createWorker)return window.Tesseract;
    if(loadTesseract.pending)return loadTesseract.pending;
    loadTesseract.pending=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
      script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(Error('Tesseract missing'));
      script.onerror=()=>reject(Error('Tesseract script unavailable'));document.head.append(script);
    }).catch(e=>{loadTesseract.pending=null;throw e});
    return loadTesseract.pending;
  }
  let ocrWorker=null,ocrBusy=false;
  async function scanOCR(){
    const src=api.getSource();if(!src){api.toast('先にカメラか画像を読み込んでください。',true);return;}
    if(ocrBusy){api.toast('OCR処理中です。',true);return;}
    ocrBusy=true;ui.ocr.classList.add('processing');openDrawer('OCR SCAN');
    const note=field('日本語・英語の文字を端末内で解析中… 初回はOCRエンジンと言語データをダウンロードします。','drawer-hint');ui.drawerBody.append(note);
    let canvas=document.createElement('canvas');
    const factor=Math.min(1,1600/Math.max(src.width,src.height));
    canvas.width=Math.max(1,Math.round(src.width*factor));canvas.height=Math.max(1,Math.round(src.height*factor));
    const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(src.element,0,0,canvas.width,canvas.height);
    try{
      const tess=await loadTesseract();
      if(!ocrWorker)ocrWorker=await tess.createWorker(['jpn','eng'],1,{logger:m=>{
        if(m.status&&m.progress!=null){note.textContent=`${m.status} · ${Math.round(m.progress*100)}%`;}
      }});
      const result=await ocrWorker.recognize(canvas);
      lastOCR=(result.data?.text||'').trim();
      ui.drawerBody.replaceChildren();ui.drawerActions.replaceChildren();
      ui.drawerBody.append(field('スマホ内でのOCR結果です。誤認識の可能性があります。','drawer-hint'));
      const pre=document.createElement('pre');pre.className='ocr-output';pre.textContent=lastOCR||'文字を検出できませんでした。';ui.drawerBody.append(pre);
      if(lastOCR){
        ui.drawerActions.append(textButton('テキストをコピー',async()=>{try{await navigator.clipboard.writeText(lastOCR);api.toast('読み取り結果をコピーしました。')}catch{api.toast('コピーできませんでした。',true)}}));
        ui.drawerActions.append(textButton('TXT保存',()=>downloadText('arc-ocr.txt',lastOCR,'text/plain')));
        record('OCR',lastOCR.slice(0,320));
      }
      msg(`OCR · ${lastOCR.length} characters read`);
    }catch(e){console.error('A.R.C. OCR error',e);note.textContent='OCRを実行できませんでした。ネット接続や端末のメモリ容量を確認して再試行してください。';api.toast('OCRモデルの読み込みか解析に失敗しました。',true);}
    finally{ocrBusy=false;ui.ocr.classList.remove('processing');canvas.width=1;canvas.height=1;}
  }
  function onDetections(tracks,isLive,target){
    radarPaint();
    const summary=tracks.map(t=>t.label).sort().join(',');const now=Date.now();
    if(tracks.length&&(!isLive || ((summary!==lastLog)&&now-lastLogTime>8000))){
      record(isLive?'LIVE DETECT':'IMAGE ANALYSIS',`${tracks.length} 件: ${tracks.slice(0,7).map(t=>`${t.label} ${Math.round(t.score*100)}%`).join(', ')}`);
      lastLog=summary;lastLogTime=now;
    }
    if(state.segment&&segmentData&&target&&(segmentedLabel!==target.label+'#'+target.id))renderSegmentation();
    const perf=api.getPerformance();
    if(!state.pose&&!state.gesture&&!state.segment)status('AUTO',`AUTO · ${Math.round(perf.frameInterval)}ms`);
  }
  function onLock(target){if(target)record('TARGET LOCK',smallTarget(target));if(state.segment&&segmentData)renderSegmentation();radarPaint();}
  function onReset(){poseLandmarks=[];gestureLandmarks=[];segmentData=null;segmentedLabel=null;lastPose=0;lastGesture=0;lastSegment=0;radarPaint();}
  async function onImage(img){
    const which=state.pose?'pose':state.segment?'segment':state.gesture?'gesture':null;
    if(which){try{await runForImage(which)}catch(e){console.warn('ARC extension image',e)}}
    radarPaint();
  }
  ui.pose.addEventListener('click',()=>toggleMode('pose'));
  ui.segment.addEventListener('click',()=>toggleMode('segment'));
  ui.gesture.addEventListener('click',()=>toggleMode('gesture'));
  ui.ocr.addEventListener('click',scanOCR);
  ui.radar.addEventListener('click',toggleRadar);
  ui.history.addEventListener('click',displayHistory);
  ui.close.addEventListener('click',closeDrawer);ui.backdrop.addEventListener('click',closeDrawer);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!ui.drawer.hidden)closeDrawer()});
  radarPaint();
  return {onFrame,onImage,onDetections,onLock,onReset,drawOverlay};
}