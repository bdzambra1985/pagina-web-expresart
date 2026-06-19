'use strict';

const CACHE_NAME = 'expresart-v1';

// Assets que se cachean al instalar (app shell)
const PRECACHE = [
    '/',
    '/style.css',
    '/common.js',
    '/logo.png',
    '/img/app-icon-192.png',
    '/img/app-icon-512.png'
];

// Rutas que NUNCA se cachean — siempre van a la red
const NETWORK_ONLY = ['/api/', '/uploads/'];

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

    // API y uploads: siempre red, nunca caché
    if (NETWORK_ONLY.some(p => url.pathname.startsWith(p))) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Solo GET
    if (e.request.method !== 'GET') return;

    // Estrategia: Network First → si falla, caché → si no hay, página offline
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() =>
                caches.match(e.request).then(cached =>
                    cached || caches.match('/')
                )
            )
    );
});
