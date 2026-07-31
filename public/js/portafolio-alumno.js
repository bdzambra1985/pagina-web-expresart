function ytThumb(url) {
    const m = url.match(/(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? 'https://img.youtube.com/vi/' + m[1] + '/mqdefault.jpg' : null;
}

initNavAuth();

/* ── Acceso privado por enlace compartido ── */
(function() {
    const params  = new URLSearchParams(location.search);
    const shareId = params.get('share');
    if (!shareId) return;

    const STORAGE_KEY = 'share_ok_' + shareId;
    const gate  = document.getElementById('shareGate');
    const btn   = document.getElementById('gateBtn');
    const pwEl  = document.getElementById('gatePw');
    const errEl = document.getElementById('gateError');

    document.getElementById('gateUser').value = shareId;

    function unlockGate(userId, triggerLoad) {
        sessionStorage.setItem('share_mode', '1');
        gate.classList.add('hidden');
        applyShareMode();
        const newUrl = location.pathname + '?id=' + encodeURIComponent(userId);
        history.replaceState(null, '', newUrl);
        if (triggerLoad) loadPortfolio(userId);
    }

    const cachedRaw = sessionStorage.getItem(STORAGE_KEY);
    if (cachedRaw) {
        try {
            const cached = JSON.parse(cachedRaw);
            if (cached.expiresAt && Date.now() < cached.expiresAt) {
                unlockGate(cached.userId, false);
                return;
            }
        } catch(e) {}
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem('share_mode');
    }

    gate.classList.remove('hidden');
    pwEl.focus();

    async function tryAuth() {
        const password = pwEl.value.trim();
        if (!password) { errEl.textContent = 'Ingresa la contraseña.'; return; }
        btn.disabled = true;
        btn.textContent = 'Verificando…';
        errEl.textContent = '';
        try {
            const r = await fetch('/api/share-links/' + encodeURIComponent(shareId) + '/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const d = await r.json();
            if (d.ok) {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                    userId: d.userId,
                    token: d.token,
                    expiresAt: d.expiresAt
                }));
                unlockGate(d.userId, true);
            } else {
                errEl.textContent = d.message || 'Contraseña incorrecta.';
                pwEl.value = '';
                pwEl.focus();
            }
        } catch(e) {
            errEl.textContent = 'Error de conexión. Intenta de nuevo.';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Acceder';
        }
    }

    btn.addEventListener('click', tryAuth);
    pwEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryAuth(); });
})();

/* ── Modo vista privada ── */
function applyShareMode() {
    const nav = document.querySelector('.top-nav');
    if (nav) nav.style.display = 'none';
    let bar = document.getElementById('shareModeBar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'shareModeBar';
        bar.style.cssText = [
            'position:fixed;top:0;left:0;right:0;z-index:9000',
            'background:rgba(8,0,2,0.94)',
            'border-bottom:1px solid rgba(201,162,39,0.28)',
            'display:flex;align-items:center;justify-content:center;gap:10px',
            'padding:9px 20px',
            'font-family:Poppins,sans-serif;font-size:0.70rem',
            'letter-spacing:2px;text-transform:uppercase',
            'color:rgba(201,162,39,0.65)',
            'backdrop-filter:blur(10px)'
        ].join(';');
        const cachedSession = (function() {
            try {
                const keys = Object.keys(sessionStorage).filter(k => k.startsWith('share_ok_'));
                if (!keys.length) return null;
                return JSON.parse(sessionStorage.getItem(keys[0]));
            } catch(e) { return null; }
        })();
        const expiryStr = cachedSession && cachedSession.expiresAt
            ? ' · Expira ' + new Date(cachedSession.expiresAt).toLocaleString('es-EC', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
            : '';
        bar.innerHTML = '<i class="bx bx-lock-alt" style="font-size:0.95rem"></i> Vista privada · EXPRESART' + expiryStr;
        document.body.prepend(bar);
    }
}
if (sessionStorage.getItem('share_mode')) applyShareMode();

/* ── Cargar perfil ── */
function loadPortfolio(uid) {
    fetch('/api/profile/' + uid)
        .then(r => {
            if (!r.ok) throw new Error('no encontrado');
            return r.json();
        })
        .then(({ profile: p }) => {
            populateBook(p);
            populateMobile(p);
        })
        .catch(() => { location.href = 'portafolio.html'; });
}

const _qs    = new URLSearchParams(location.search);
const userId = _qs.get('id');
if (!userId && !_qs.get('share')) { location.href = 'portafolio.html'; }
if (userId) loadPortfolio(userId);

/* ── Poblar libro ── */
function populateBook(p) {
    document.title = 'EXPRESART — ' + (p.displayName || 'Portafolio');
    document.getElementById('bookTitle').textContent = p.displayName || 'Artista';
    const heroTitle = document.getElementById('pageHeroTitle');
    if (heroTitle) heroTitle.textContent = p.displayName || 'Portafolio Artístico';
    document.getElementById('coverName').textContent = p.displayName || '';
    document.getElementById('bookName').textContent  = p.displayName || '';
    document.getElementById('bookBio').textContent   = p.bio || p.bio_short || '';

    if (p.photoUrl) {
        const wrap = document.createElement('div');
        wrap.className = 'avatar-zoom-wrap';
        wrap.title = 'Ver foto';
        wrap.onclick = function() { _zoomShow(p.photoUrl); };
        const img = document.createElement('img');
        img.className = 'avatar';
        img.src = p.photoUrl;
        img.alt = p.displayName || '';
        wrap.appendChild(img);
        document.getElementById('bookAvatar').replaceWith(wrap);
    }

    if (p.especialidades && p.especialidades.length) {
        document.getElementById('bookEspProfile').innerHTML = p.especialidades.map(e =>
            `<span class="profile-esp-tag">${esc(e)}</span>`).join('');
    }

    // Certificados como estrellas bajo la foto
    if (p.certificados && p.certificados.length) {
        var certsEl = document.getElementById('bookCertificados');
        if (certsEl) {
            certsEl.innerHTML = p.certificados.map(c =>
                `<span class="cert-badge" title="${esc(c.titulo)} — ${esc(c.fecha)}">⭐ ${esc(c.nivel)}</span>`
            ).join('');
            certsEl.style.display = '';
        }
    }

    buildBookPages(p);
    openCover();
}

/* ── Globales para popups ── */
var _allProds  = [];
var _allVideos = [];

/* ── Generar hojas de producciones ── */
function buildBookPages(p) {
    _allProds  = (p.producciones && p.producciones.length) ? p.producciones : [];
    _allVideos = p.videos || [];

    const book = document.querySelector('.book');
    book.querySelectorAll('.book-page.page-right').forEach(el => el.remove());

    const prods = _allProds;

    var chunks = [];
    if (prods.length === 0) {
        chunks.push([]);
    } else {
        for (var i = 0; i < prods.length; i += 2) {
            chunks.push(prods.slice(i, i + 2));
        }
    }

    var turns = [];
    for (var i = 0; i < chunks.length; i += 2) {
        turns.push({
            front: { type: 'prods', items: chunks[i] },
            back:  i + 1 < chunks.length ? { type: 'prods', items: chunks[i + 1] } : null
        });
    }

    const total = turns.length;

    function renderProd(pr) {
        var gIdx   = _allProds.indexOf(pr);
        var imgHTML = pr.photoUrl
            ? '<div class="timeline-img-wrap"><img class="timeline-img" src="' + esc(pr.photoUrl) + '" alt=""></div>'
            : '<div class="timeline-img-placeholder"><i class="bx bx-image"></i></div>';
        return '<div class="timeline-item">' +
            imgHTML +
            '<div class="timeline-body">' +
                '<span class="timeline-year"><i class="bx bxs-mask"></i> ' + esc(pr.year||'') + '</span>' +
                '<h3 class="timeline-title">' + esc(pr.title||'') + '</h3>' +
                '<p class="timeline-text">' + esc(pr.description||'') + '</p>' +
                '<div style="display:flex;gap:5px;margin-top:6px;">' +
                    '<button class="prod-btn" data-action="open-detalles" data-idx="' + gIdx + '"><i class="bx bx-image-alt"></i> Detalles</button>' +
                    '<button class="prod-btn videos-btn" data-action="open-videos" data-idx="' + gIdx + '"><i class="bx bx-play-circle"></i> Videos</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderContent(data) {
        if (!data) {
            return '<div class="page-back-deco"><i class="bx bx-mask"></i></div>';
        }
        var body = data.items.length
            ? data.items.map(renderProd).join('')
            : '<p style="color:var(--text2);font-size:0.82rem;font-style:italic">Sin producciones registradas.</p>';
        return '<h2 class="page-title">Producciones</h2>' +
               '<div class="page-title-rule"></div>' +
               '<div class="timeline">' + body + '</div>';
    }

    turns.forEach(function(turn, idx) {
        var id           = 'turn-' + (idx + 1);
        var zIndex       = total - idx;
        var frontPageNum = idx * 2 + 2;
        var backPageNum  = frontPageNum + 1;
        var isLast       = idx === total - 1;

        var el = document.createElement('div');
        el.className = 'book-page page-right';
        el.id = id;
        el.style.zIndex = zIndex;
        el.innerHTML =
            '<div class="page-front">' +
                renderContent(turn.front) +
                '<span class="number-page">' + frontPageNum + '</span>' +
                (!isLast ? '<span class="nextprev-btn" data-page="' + id + '"><i class="bx bx-chevron-right"></i></span>' : '') +
            '</div>' +
            '<div class="page-back">' +
                renderContent(turn.back) +
                '<span class="number-page">' + backPageNum + '</span>' +
                '<span class="nextprev-btn back" data-page="' + id + '"><i class="bx bx-chevron-left"></i></span>' +
            '</div>';

        book.appendChild(el);
    });

    book.querySelectorAll('.nextprev-btn').forEach(function(btn) {
        btn.onclick = function() {
            var page = document.getElementById(btn.getAttribute('data-page'));
            if (page.classList.contains('turn')) {
                page.classList.remove('turn');
                var num = parseInt(page.id.replace('turn-', ''));
                page.style.zIndex = total - num + 1;
            } else {
                page.classList.add('turn');
                page.style.zIndex = 20;
            }
        };
    });
}

/* ── Popup: Detalles ── */
function _openDetalles(idx) {
    var pr = _allProds[idx];
    if (!pr) return;
    var allPhotos = [];
    if (pr.photoUrl) allPhotos.push(pr.photoUrl);
    if (pr.photos && pr.photos.length) {
        pr.photos.forEach(function(u) { if (u) allPhotos.push(u); });
    }
    var cells = '';
    for (var i = 0; i < 6; i++) {
        if (allPhotos[i]) {
            cells += '<div class="prod-popup-photo" style="cursor:pointer" data-action="zoom-img" data-src="' + esc(allPhotos[i]) + '">' +
                     '<img src="' + esc(allPhotos[i]) + '" alt="foto ' + (i+1) + '"></div>';
        } else {
            cells += '<div class="prod-popup-photo"><div class="prod-popup-photo-ph"><i class="bx bx-image"></i></div></div>';
        }
    }
    document.getElementById('prodPopupContent').innerHTML =
        '<div class="prod-popup-title">' + esc(pr.title||'Producción') + '</div>' +
        '<div class="prod-popup-year"><i class="bx bxs-mask"></i> ' + esc(pr.year||'') + '</div>' +
        '<p class="prod-popup-section-title"><i class="bx bx-images"></i> Fotos</p>' +
        '<div class="prod-popup-collage">' + cells + '</div>' +
        (pr.description
            ? '<p class="prod-popup-section-title"><i class="bx bx-text"></i> Descripción</p>' +
              '<p class="prod-popup-desc">' + esc(pr.description) + '</p>'
            : '');
    document.getElementById('prodPopup').classList.add('open');
}

/* ── Popup: Videos ── */
function _openVideos(prodIdx) {
    var pr     = _allProds[prodIdx];
    var videos = (pr && pr.videos && pr.videos.length) ? pr.videos.filter(function(v){return v&&v.url;}) : [];
    var title  = pr ? (pr.title || 'Producción') : 'Videos';
    var body   = videos.length
        ? '<div class="prod-popup-video-list">' +
            videos.map(function(v, i) {
                return '<div class="prod-popup-video-item">' +
                    '<button data-action="play-video" data-prod-idx="' + prodIdx + '" data-vid-idx="' + i + '" style="width:100%;display:flex;align-items:center;gap:10px;background:rgba(201,162,39,0.04);border:1px solid rgba(201,162,39,0.28);border-radius:8px;padding:10px 14px;cursor:pointer;color:rgba(255,220,180,0.90);font-family:Poppins,sans-serif;font-size:0.80rem;text-align:left;">' +
                        '<i class="bx bx-play-circle" style="font-size:1.5rem;color:#cc0000;flex-shrink:0"></i>' +
                        '<div><div style="font-weight:600">' + esc(v.title||'Video '+(i+1)) + '</div>' +
                        '<div style="font-size:0.65rem;opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:480px">' + esc(v.url) + '</div>' +
                        '</div>' +
                    '</button></div>';
            }).join('') + '</div>'
        : '<p style="color:rgba(255,200,200,0.50);font-size:0.82rem;font-style:italic;margin-top:8px">Sin videos para esta producción.</p>';
    document.getElementById('prodPopupContent').innerHTML =
        '<div class="prod-popup-title">Videos</div>' +
        '<div class="prod-popup-year"><i class="bx bxs-mask"></i> ' + esc(title) + '</div>' +
        body;
    document.getElementById('prodPopup').classList.add('open');
}

/* ── Reproducir video ── */
function _playVideo(prodIdx, vidIdx) {
    var pr = _allProds[prodIdx];
    var v  = pr && pr.videos && pr.videos[vidIdx];
    if (!v) return;
    var embed = _getEmbedUrl(v.url);
    var player = embed
        ? '<div style="position:relative;padding-top:56.25%;margin-top:12px;border-radius:10px;overflow:hidden;background:#000">' +
              '<iframe src="' + esc(embed) + '" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" ' +
              'allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe>' +
          '</div>'
        : '<p style="margin-top:12px"><a href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer">Ver video</a></p>';
    document.getElementById('prodPopupContent').innerHTML =
        '<button data-action="open-videos" data-idx="' + prodIdx + '" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;color:rgba(201,162,39,0.80);font-size:0.75rem;cursor:pointer;margin-bottom:12px;font-family:Poppins,sans-serif;">' +
            '<i class="bx bx-arrow-back"></i> Volver a videos</button>' +
        '<div class="prod-popup-title">' + esc(v.title||'Video') + '</div>' +
        player;
    document.getElementById('prodPopup').classList.add('open');
}

// Solo devuelve URLs de embed de proveedores reconocidos (YouTube/Vimeo).
// Si no reconoce el proveedor devuelve null — nunca la URL cruda en un iframe.
function _getEmbedUrl(url) {
    var yt = String(url || '').match(/(?:youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{11})/);
    if (yt) return 'https://www.youtube.com/embed/' + yt[1] + '?autoplay=1&rel=0';
    var vm = String(url || '').match(/vimeo\.com\/(\d+)/);
    if (vm) return 'https://player.vimeo.com/video/' + vm[1] + '?autoplay=1';
    return null;
}

/* ── Zoom ── */
var _zoomHideTimer = null;
var _zoomActiveSrc = null;
var _zoomOpenedAt  = 0;

function _zoomHideNow() {
    clearTimeout(_zoomHideTimer);
    _zoomActiveSrc = null;
    document.getElementById('imgZoomOverlay').classList.remove('show');
}
function _zoomShow(src) {
    clearTimeout(_zoomHideTimer);
    _zoomActiveSrc = src;

    var img     = document.getElementById('imgZoomImg');
    var loading = document.getElementById('imgZoomLoading');

    img.style.display     = 'none';
    img.src               = '';
    loading.style.display = 'flex';
    loading.innerHTML     = '<i class="bx bx-loader-alt bx-spin"></i><span>Cargando…</span>';

    document.getElementById('imgZoomOverlay').classList.add('show');
    _zoomOpenedAt = Date.now();

    var tmp = new Image();
    tmp.onload = function() {
        if (_zoomActiveSrc !== src) return;
        loading.style.display = 'none';
        img.src               = src;
        img.style.display     = 'block';
    };
    tmp.onerror = function() {
        if (_zoomActiveSrc !== src) return;
        loading.innerHTML = '<i class="bx bx-image-x"></i><span>No se pudo cargar</span>';
    };
    tmp.src = src;
}
function _zoomHide() {
    _zoomHideTimer = setTimeout(_zoomHideNow, 120);
}
function _zoomImg(src) { _zoomShow(src); }

document.addEventListener('mouseenter', function(e) {
    var wrap = e.target.closest && e.target.closest('.timeline-img-wrap');
    if (wrap) { var img = wrap.querySelector('img'); if (img) _zoomShow(img.src); return; }
    if (e.target.closest && e.target.closest('#imgZoomOverlay')) clearTimeout(_zoomHideTimer);
}, true);
document.addEventListener('mouseleave', function(e) {
    if (e.target.closest && e.target.closest('.timeline-img-wrap')) { _zoomHide(); return; }
    if (e.target.closest && e.target.closest('#imgZoomOverlay')) _zoomHide();
}, true);

document.getElementById('imgZoomOverlay').addEventListener('touchend', function(e) {
    if (Date.now() - _zoomOpenedAt < 250) return;
    e.preventDefault();
    e.stopPropagation();
    _zoomHideNow();
}, { passive: false });

document.getElementById('imgZoomOverlay').addEventListener('click', function(e) {
    if (Date.now() - _zoomOpenedAt < 250) return;
    e.stopPropagation();
    _zoomHideNow();
});

document.addEventListener('click', function(e) {
    var wrap = e.target.closest && e.target.closest('.timeline-img-wrap');
    if (wrap) {
        e.stopPropagation();
        var ov = document.getElementById('imgZoomOverlay');
        if (ov.classList.contains('show')) { _zoomHideNow(); }
        else { var img = wrap.querySelector('img'); if (img) _zoomShow(img.src); }
        return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'open-detalles') { _openDetalles(parseInt(btn.dataset.idx)); }
    else if (action === 'open-videos') { _openVideos(parseInt(btn.dataset.idx)); }
    else if (action === 'zoom-img') { _zoomImg(btn.dataset.src); }
    else if (action === 'play-video') { _playVideo(parseInt(btn.dataset.prodIdx), parseInt(btn.dataset.vidIdx)); }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') _zoomHideNow();
});

/* ── Cerrar popup — static HTML elements ── */
document.getElementById('imgZoomClose').addEventListener('click', function(e) {
    e.stopPropagation();
    _zoomHideNow();
});

document.getElementById('prodPopup').addEventListener('click', closeProdPopup);

document.querySelector('.prod-popup-box').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
        var action = btn.dataset.action;
        if (action === 'zoom-img')   { _zoomImg(btn.dataset.src); }
        else if (action === 'open-videos') { _openVideos(parseInt(btn.dataset.idx)); }
        else if (action === 'play-video')  { _playVideo(parseInt(btn.dataset.prodIdx), parseInt(btn.dataset.vidIdx)); }
    }
    e.stopPropagation();
});

document.querySelector('.prod-popup-close').addEventListener('click', function() {
    closeProdPopup(null, true);
});

function closeProdPopup(e, force) {
    if (force || (e && e.target === document.getElementById('prodPopup'))) {
        document.getElementById('prodPopupContent').innerHTML = '';
        document.getElementById('prodPopup').classList.remove('open');
    }
}

/* ── Poblar móvil ── */
function populateMobile(p) {
    document.getElementById('mName').textContent = p.displayName || '';
    document.getElementById('mBio').textContent  = p.bio || p.bio_short || '';

    if (p.photoUrl) {
        const wrap = document.createElement('div');
        wrap.className = 'm-avatar-zoom-wrap';
        wrap.title = 'Ver foto';
        wrap.onclick = function() { _zoomShow(p.photoUrl); };
        const img = document.createElement('img');
        img.className = 'm-avatar';
        img.src = p.photoUrl;
        img.alt = p.displayName || '';
        wrap.appendChild(img);
        document.getElementById('mAvatar').replaceWith(wrap);
    }

    if (p.producciones && p.producciones.length) {
        document.getElementById('mProd').innerHTML = p.producciones.map((pr, idx) => `
            <div class="timeline-item">
                ${pr.photoUrl
                    ? `<div class="timeline-img-wrap"><img class="timeline-img" src="${esc(pr.photoUrl)}" alt=""></div>`
                    : `<div class="timeline-img-placeholder"><i class="bx bx-image"></i></div>`}
                <div class="timeline-body">
                    <span class="timeline-year"><i class="bx bxs-mask"></i> ${esc(pr.year||'')}</span>
                    <h3 class="timeline-title">${esc(pr.title||'')}</h3>
                    <p class="timeline-text">${esc(pr.description||'')}</p>
                    <div style="display:flex;gap:5px;margin-top:6px;">
                        <button class="prod-btn" data-action="open-detalles" data-idx="${idx}"><i class="bx bx-image-alt"></i> Detalles</button>
                        <button class="prod-btn videos-btn" data-action="open-videos" data-idx="${idx}"><i class="bx bx-play-circle"></i> Videos</button>
                    </div>
                </div>
            </div>`).join('');
    } else {
        document.getElementById('mProdSection').style.display = 'none';
    }

    if (p.videos && p.videos.length) {
        document.getElementById('mVideos').innerHTML = p.videos.map((v,i) => `
            <div class="m-video-item">
                <i class="bx bx-play-circle"></i>
                <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title||'Video '+(i+1))}</a>
            </div>`).join('');
    } else {
        document.getElementById('mVideosSection').style.display = 'none';
    }

    if (p.especialidades && p.especialidades.length) {
        document.getElementById('mEspProfile').innerHTML = p.especialidades.map(e =>
            `<span class="m-esp-chip">${esc(e)}</span>`).join('');
    }
}

/* ── Libro ── */
const coverRight = document.querySelector('.cover.cover-right');

function openCover() {
    setTimeout(function() {
        coverRight.classList.add('turn');
        setTimeout(function() { coverRight.style.zIndex = -1; }, 800);
    }, 300);
}
