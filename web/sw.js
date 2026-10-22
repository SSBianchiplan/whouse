/* GPlanSiS|WHOUSE service worker
   - /api/* nunca passa pelo cache (dados e sessão são sempre do servidor);
   - página e app.js: rede primeiro (atualização chega na hora), cache se offline;
   - ícones, vendor e fontes: cache primeiro. */
const V='whouse-v3';
const SHELL=['./','./index.html','./app.html','./app.js','./landing.js','./manifest.webmanifest','./vendor/xlsx.full.min.js?v=0.20.3','./icons/icon-192.png','./icons/icon-512.png','./icons/logo-mark.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
const put=(req,res)=>{if(res&&res.ok&&res.type!=='opaque'){const cp=res.clone();caches.open(V).then(c=>c.put(req,cp))}return res};
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const u=new URL(req.url);
  if(u.origin===location.origin&&u.pathname.startsWith('/api/'))return;
  if(u.origin===location.origin&&(req.mode==='navigate'||/\/(index\.html|app\.html|app\.js|landing\.js|sw\.js|manifest\.webmanifest)?$/.test(u.pathname))){
    e.respondWith(fetch(req).then(r=>put(req,r)).catch(()=>caches.match(req).then(r=>r||caches.match(u.pathname.startsWith('/app')?'./app.html':'./index.html'))));return}
  e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>put(req,res))));
});
