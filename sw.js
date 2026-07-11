const CACHE_NAME = 'otto8100-mobile-v1';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // cache solo i file locali, le CDN possono fallire in offline
      return cache.addAll(['./', './index.html']).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // solo GET, solo stessa origine o CDN note
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // per Supabase e Google API: sempre rete, non cachare (dati vivi)
  if (url.hostname.includes('supabase') || url.hostname.includes('google') || url.hostname.includes('googleapis')) return;

  // Per la pagina principale (navigazione e index.html): rete-prima,
  // così ogni aggiornamento pubblicato su GitHub si vede già alla prima
  // apertura — la cache serve solo come fallback quando sei offline.
  const isPagina = e.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname.endsWith('/');
  if (isPagina) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Per il resto (font, librerie CDN, icone): cache-first, cambiano raramente.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
