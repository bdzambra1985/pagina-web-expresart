initNavAuth();

function _ytId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}
function _vmId(url) {
    if (!url) return null;
    const m = url.match(/vimeo\.com\/(\d+)/);
    return m ? m[1] : null;
}
function _embedUrl(url) {
    const yt = _ytId(url);
    if (yt) return 'https://www.youtube.com/embed/' + yt + '?rel=0';
    const vm = _vmId(url);
    if (vm) return 'https://player.vimeo.com/video/' + vm + '?autoplay=1';
    return null;
}

let _modal = null;
function _openVideo(url, title) {
    const embed = _embedUrl(url);
    if (!embed) return;
    if (!_modal) {
        _modal = document.createElement('div');
        _modal.id = 'videoModal';
        _modal.innerHTML =
            '<div class="vm-backdrop"></div>' +
            '<div class="vm-box">' +
                '<button class="vm-close" aria-label="Cerrar"><i class="bx bx-x"></i></button>' +
                '<div class="vm-title"></div>' +
                '<div class="vm-ratio"><iframe class="vm-iframe" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>' +
            '</div>';
        document.body.appendChild(_modal);
        _modal.querySelector('.vm-backdrop').addEventListener('click', _closeVideo);
        _modal.querySelector('.vm-close').addEventListener('click', _closeVideo);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeVideo(); });
    }
    _modal.querySelector('.vm-title').textContent = title || '';
    _modal.querySelector('.vm-iframe').src = embed;
    _modal.classList.add('vm-open');
    document.body.style.overflow = 'hidden';
}
function _closeVideo() {
    if (!_modal) return;
    _modal.classList.remove('vm-open');
    _modal.querySelector('.vm-iframe').src = '';
    document.body.style.overflow = '';
}

async function loadProducciones() {
    let prods = [];
    try {
        const r = await fetch('/api/content');
        const c = await r.json();
        prods = c.producciones || [];
    } catch { /* fallback */ }

    const grid = document.getElementById('prodGrid');
    if (!prods.length) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1">
                <i class="bx bx-mask"></i>
                <h3>Próximamente</h3>
                <p>Las producciones de EXPRESART aparecerán aquí</p>
            </div>`;
        return;
    }

    grid.innerHTML = prods.map((p, idx) => {
        const hasVid      = !!_embedUrl(p.videoUrl);
        const coverBlock  = p.photoUrl
            ? `<div class="prod-cover-wrap"><img class="prod-cover" src="${esc(p.photoUrl)}" alt="${esc(p.title)}" loading="lazy"></div>`
            : '';
        const hasDetalles = p.description || (p.photos && p.photos.filter(x=>x).length);
        return `<div class="prod-card">
            ${(p.duracion||p.year) ? `<span class="prod-year">${esc(p.duracion||p.year)}</span>` : ''}
            ${coverBlock}
            <div class="prod-title">${esc(p.title)}</div>
            ${hasDetalles ? `<button class="prod-detalles-btn" data-idx="${idx}"><i class="bx bx-images"></i> Detalles</button>` : ''}
            ${hasVid ? `<button class="prod-video-btn" data-url="${esc(p.videoUrl)}" data-title="${esc(p.title)}"><i class="bx bx-play-circle"></i> Ver video</button>` : ''}
        </div>`;
    }).join('');

    grid.querySelectorAll('.prod-detalles-btn').forEach(btn => {
        btn.addEventListener('click', () => _openDetalles(prods[+btn.dataset.idx]));
    });

    grid.querySelectorAll('.prod-video-btn').forEach(btn => {
        btn.addEventListener('click', () => _openVideo(btn.dataset.url, btn.dataset.title));
    });
}

/* ── Modal Detalles ── */
const _dm      = document.getElementById('detallesModal');
const _dmClose = document.getElementById('dmClose');
const _dmBack  = document.getElementById('dmBackdrop');

function _openDetalles(p) {
    document.getElementById('dmTitle').textContent   = p.title || '';
    document.getElementById('dmDur').textContent     = (p.duracion||p.year) ? `Duración: ${p.duracion||p.year}` : '';
    document.getElementById('dmDesc').textContent    = p.description || '';
    const photos = (p.photos || []).filter(x => x);
    document.getElementById('dmCollage').innerHTML   = photos.map(ph =>
        `<div class="dm-collage-slot"><img src="${esc(ph)}" loading="lazy"></div>`).join('');
    _dm.classList.add('dm-open');
    document.body.style.overflow = 'hidden';
}
function _closeDetalles() {
    _dm.classList.remove('dm-open');
    document.body.style.overflow = '';
}
_dmClose.addEventListener('click', _closeDetalles);
_dmBack.addEventListener('click',  _closeDetalles);
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeDetalles(); });

loadProducciones();
