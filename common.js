'use strict';

/* ── Escape HTML entities ── */
function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ── Update nav login link based on active session ── */
function initNavAuth() {
    var tok = localStorage.getItem('exp_token');
    if (!tok) return;
    fetch('/api/auth', { headers: { 'x-session-token': tok } })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!d.ok) return;
            var link = document.getElementById('navLoginLink');
            if (!link) return;
            if (d.role === 'admin') {
                link.textContent = 'Admin';
                link.href = 'admin.html';
            } else {
                link.textContent = 'Mi Perfil';
                link.href = 'mi-portafolio.html';
            }
        })
        .catch(function() {});
}

/* ── Thin fetch wrapper — returns parsed JSON or throws ── */
function api(url, opts) {
    var tok = localStorage.getItem('exp_token');
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (tok) headers['x-session-token'] = tok;
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function(r) { return r.json(); });
}

/* ── Feedback de botones: spinner mientras carga ── */
function btnLoad(el) {
    el._savedDisabled = el.disabled;
    el.disabled = true;
    el.classList.add('btn-loading');
}
function btnDone(el) {
    el.disabled = el._savedDisabled || false;
    el.classList.remove('btn-loading');
}

/* ── Skeleton shimmer para imágenes lentas ── */
function _applyImgSkeleton(img) {
    if (img.complete && img.naturalWidth > 0) return;
    img.classList.add('img-skeleton');
    function removeSkeleton() { img.classList.remove('img-skeleton'); }
    img.addEventListener('load',  removeSkeleton, { once: true });
    img.addEventListener('error', removeSkeleton, { once: true });
}
function initImgSkeletons() {
    document.querySelectorAll('img').forEach(_applyImgSkeleton);
    new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            m.addedNodes.forEach(function(n) {
                if (n.nodeType !== 1) return;
                if (n.tagName === 'IMG') _applyImgSkeleton(n);
                else n.querySelectorAll && n.querySelectorAll('img').forEach(_applyImgSkeleton);
            });
        });
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
}
document.addEventListener('DOMContentLoaded', initImgSkeletons);
