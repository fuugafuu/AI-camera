/* Small progressive cache. External model/wasm assets must be downloaded first;
   success of offline reuse is browser- and storage-policy-dependent. */
const STATIC='arc-vision-shell-v1';
const DYNAMIC='arc-vision-engine-v1';
const LOCAL=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/icon.svg'];
self.addEventListener('install', event => { event.waitUntil(caches.open(STATIC).then(c => c.addAll(LOCAL)).then(()=>self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil((async()=>{for(const key of await caches.keys()) if(![STATIC,DYNAMIC].includes(key))await caches.delete(key); await self.clients.claim();})());});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  const same=url.origin===self.location.origin;
  const model=url.hostname==='storage.googleapis.com'&&url.pathname.startsWith('/mediapipe-models/object_detector/');
  const engine=url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('/@mediapipe/tasks-vision@0.10.32/');
  if(!same&&!model&&!engine)return;
  if(same){
    event.respondWith((async()=>{try{const response=await fetch(req);if(response.ok){const cache=await caches.open(STATIC);cache.put(req,response.clone()).catch(()=>{});}return response;}catch{return(await caches.match(req))||Response.error();}})());
  }else{
    event.respondWith((async()=>{const cached=await caches.match(req);if(cached)return cached;try{const response=await fetch(req);if(response.ok||response.type==='opaque'){const cache=await caches.open(DYNAMIC);cache.put(req,response.clone()).catch(()=>{});}return response;}catch{return Response.error();}})());
  }
});