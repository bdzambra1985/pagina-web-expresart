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

    grid.innerHTML = prods.map(p => {
        const ytId   = _ytId(p.videoUrl);
        const hasVid = !!_embedUrl(p.videoUrl);
        const thumb  = ytId ? `https://img.youtube.com/vi/${ytId}/mqdefault.jpg` : '';
        const mediaBlock = hasVid
            ? `<div class="prod-thumb" data-url="${esc(p.videoUrl)}" data-title="${esc(p.title)}" role="button" tabindex="0" aria-label="Ver video: ${esc(p.title)}">
                   ${thumb ? `<img src="${thumb}" alt="${esc(p.title)}" loading="lazy">` : '<div class="prod-thumb-placeholder"><i class="bx bx-play-circle"></i></div>'}
                   <div class="prod-play-overlay"><div class="prod-play-btn"><i class="bx bx-play"></i></div></div>
               </div>`
            : (p.photoUrl ? `<img class="prod-cover" src="${esc(p.photoUrl)}" alt="${esc(p.title)}" loading="lazy">` : '');
        return `<div class="prod-card">
            ${p.year ? `<span class="prod-year">${esc(p.year)}</span>` : ''}
            ${mediaBlock}
            <div class="prod-title">${esc(p.title)}</div>
            ${p.description ? `<p class="prod-desc">${esc(p.description)}</p>` : ''}
        </div>`;
    }).join('');

    grid.querySelectorAll('.prod-thumb').forEach(el => {
        const open = () => _openVideo(el.dataset.url, el.dataset.title);
        el.addEventListener('click', open);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
    });
}

loadProducciones();
