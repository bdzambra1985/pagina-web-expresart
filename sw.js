'use strict';

const CACHE_NAME = 'expresart-v4';

// Solo iconos de la app se pre-cachean (nunca cambian)
const PRECACHE = [
    '/img/app-icon-192.png',
    '/img/app-icon-512.png'
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Solo GET
    if (e.request.method !== 'GET') return;

    // Recursos externos (Cloudinary, unpkg, Google Fonts, etc.) y API:
    // NO interceptar — dejar que el navegador los maneje directamente.
    // Llamar e.respondWith(fetch()) en cross-origin viola connect-src de la CSP.
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
        return;
    }

    // Todo lo propio (HTML, JS, CSS, imágenes): Network First
    // → siempre intenta la red primero para tener el contenido más reciente
    // → solo usa caché como fallback si no hay red (modo offline)
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
