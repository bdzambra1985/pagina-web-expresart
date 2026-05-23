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
