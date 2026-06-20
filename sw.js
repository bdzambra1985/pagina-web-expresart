'use strict';

const CACHE_NAME = 'expresart-v3';

// Solo assets estáticos que NO cambian con el contenido
const PRECACHE = [
    '/style.css',
    '/logo.png',
    '/img/app-icon-192.png',
    '/img/app-icon-512.png'
];

// Nunca cachear: API, uploads, ni páginas HTML
// Las HTML siempre deben venir de la red para mostrar imágenes actualizadas
const NETWORK_ONLY = ['/api/', '/uploads/'];

function isHtml(request, url) {
    return request.destination === 'document' ||
           url.pathname === '/' ||
           url.pathname.endsWith('.html');
}

function isCrossOrigin(url) {
    return url.origin !== self.location.origin;
}

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // API y uploads: siempre red
    if (NETWORK_ONLY.some(p => url.pathname.startsWith(p))) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Solo GET
    if (e.request.method !== 'GET') return;

    // HTML y recursos externos (Cloudinary, fonts, etc.): siempre red, nunca caché
    // Esto garantiza que las páginas y las fotos siempre carguen actualizadas
    if (isHtml(e.request, url) || isCrossOrigin(url)) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Assets estáticos propios (CSS, JS, íconos): Cache First con fallback a red
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
