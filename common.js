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
                // Reemplazar el <a> con un widget foto + nombre
                var name = d.displayName || 'Mi Perfil';
                var firstName = name.split(' ')[0];
                var avatarHTML = d.photoUrl
                    ? '<img src="' + esc(d.photoUrl) + '" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(201,162,39,0.55);pointer-events:none;flex-shrink:0">'
                    : '<span style="width:32px;height:32px;border-radius:50%;background:rgba(201,162,39,0.18);border:1.5px solid rgba(201,162,39,0.40);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:0.78rem;color:#c9a227">' + esc(firstName.charAt(0).toUpperCase()) + '</span>';
                link.href = 'mi-portafolio.html';
                link.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 6px;line-height:1';
                link.innerHTML = avatarHTML + '<span style="font-size:0.60rem;letter-spacing:1px;color:rgba(255,255,255,0.70);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(firstName) + '</span>';
                // Show "Mi Perfil" nav-cta if the page has it
                var miPerfilItem = document.getElementById('navMiPerfilItem');
                if (miPerfilItem) miPerfilItem.style.display = '';
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

/* ── Protección contra descarga / guardado de imágenes ── */
document.addEventListener('contextmenu', function(e) {
    if (e.target.tagName === 'IMG') e.preventDefault();
}, false);
document.addEventListener('dragstart', function(e) {
    if (e.target.tagName === 'IMG') e.preventDefault();
}, false);
