initNavAuth();

/* ── Extraer ID de YouTube ── */
function _ytId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

/* ── Extraer ID de Vimeo ── */
function _vmId(url) {
    if (!url) return null;
    const m = url.match(/vimeo\.com\/(\d+)/);
    return m ? m[1] : null;
}

/* ── URL de embed ── */
function _embedUrl(url) {
    const yt = _ytId(url);
    if (yt) return 'https://www.youtube.com/embed/' + yt + '?autoplay=1&rel=0';
    const vm = _vmId(url);
    if (vm) return 'https://player.vimeo.com/video/' + vm + '?autoplay=1';
    return null;
}

/* ── Modal de video ── */
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
                '<div class="vm-ratio"><iframe class="vm-iframe" frameborder="0" allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe></div>' +
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

async function loadCartelera() {
    let content = {};
    try {
        const r = await fetch('/api/content');
        content  = await r.json();
    } catch (e) { /* servidor no disponible */ }

    renderDestacada(content.destacada);
    renderProducciones(content.producciones || []);
}

function renderDestacada(d) {
    if (!d || !d.title) return;

    document.getElementById('featuredSection').style.display = '';
    document.getElementById('featuredDivider').style.display = '';

    const card = document.getElementById('featuredCard');
    const imgSide = d.photo
        ? `<div class="featured-img-side">
               <img class="featured-img" src="${esc(d.photo)}" alt="${esc(d.title)}">
           </div>`
        : `<div class="featured-img-side">
               <div class="featured-img-placeholder">
                   <i class="bx bx-mask"></i>
                   <span>Producción</span>
               </div>
           </div>`;

    const metaAuthor = d.author ? `<span class="featured-meta-item"><i class="bx bx-pen"></i>${esc(d.author)}</span>` : '';
    const metaSeason = d.year   ? `<span class="featured-meta-item"><i class="bx bx-calendar"></i>${esc(d.year)}</span>` : '';
    const descBlock  = d.description
        ? `<div class="featured-line"></div>
           <p class="featured-desc">${esc(d.description)}</p>`
        : '';

    card.innerHTML = imgSide + `
        <div class="featured-info">
            <div class="featured-badge"><i class="bx bxs-star"></i> En Cartel</div>
            <h2 class="featured-title">${esc(d.title)}</h2>
            <div class="featured-meta">${metaAuthor}${metaSeason}</div>
            ${descBlock}
        </div>`;
}

function renderProducciones(prods) {
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
        const ytId    = _ytId(p.videoUrl);
        const hasVid  = !!_embedUrl(p.videoUrl);
        const thumb   = ytId ? `https://img.youtube.com/vi/${ytId}/mqdefault.jpg` : '';

        const mediaBlock = hasVid
            ? `<div class="prod-thumb" data-url="${esc(p.videoUrl)}" data-title="${esc(p.title)}" role="button" tabindex="0" aria-label="Ver video: ${esc(p.title)}">
                   ${thumb ? `<img src="${thumb}" alt="${esc(p.title)}" loading="lazy">` : '<div class="prod-thumb-placeholder"><i class="bx bx-play-circle"></i></div>'}
                   <div class="prod-play-overlay"><div class="prod-play-btn"><i class="bx bx-play"></i></div></div>
               </div>`
            : '';

        return `<div class="prod-card">
            ${p.year ? `<span class="prod-year">${esc(p.year)}</span>` : ''}
            ${mediaBlock}
            <div class="prod-title">${esc(p.title)}</div>
            ${p.description ? `<p class="prod-desc">${esc(p.description)}</p>` : ''}
        </div>`;
    }).join('');

    /* click / teclado en thumbnails */
    grid.querySelectorAll('.prod-thumb').forEach(el => {
        const open = () => _openVideo(el.dataset.url, el.dataset.title);
        el.addEventListener('click', open);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
    });
}

loadCartelera();
