/* A.R.C. Vision V3: network-first shell, cache-first optional vision engines.
   Offline AI execution is best-effort and only after successful download. */
const STATIC='arc-vision-shell-v3-1';
const DYNAMIC='arc-vision-engine-v3-1';
const LOCAL=['./','./index.html','./styles.css','./app.js','./advanced.js','./manifest.webmanifest','./assets/icon.svg'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(STATIC).then(c=>c.addAll(LOCAL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('arc-vision-')&&![STATIC,DYNAMIC].includes(key))await caches.delete(key);await self.clients.claim()})());});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url),same=url.origin===self.location.origin;
  const engine=url.hostname==='cdn.jsdelivr.net'&&(url.pathname.includes('mediapipe/tasks-vision')||url.pathname.includes('tesseract.js'));
  const model=(url.hostname==='storage.googleapis.com'&&url.pathname.startsWith('/mediapipe-models/'));
  if(!same&&!engine&&!model)return;
  if(same){event.respondWith((async()=>{try{const res=await fetch(req);if(res.ok){const c=await caches.open(STATIC);c.put(req,res.clone()).catch(()=>{})}return res}catch{return await caches.match(req)||Response.error()}})());}
  else{event.respondWith((async()=>{const hit=await caches.match(req);if(hit)return hit;try{const res=await fetch(req);if(res.ok||res.type==='opaque'){const c=await caches.open(DYNAMIC);c.put(req,res.clone()).catch(()=>{})}return res}catch{return Response.error()}})());}
});