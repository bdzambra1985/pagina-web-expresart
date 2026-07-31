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
    if (yt) return 'https://www.youtube.com/embed/' + yt + '?rel=0';
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

async function loadCartelera() {
    let content = {};
    try {
        const r = await fetch('/api/content');
        content  = await r.json();
    } catch (e) { /* servidor no disponible */ }

    renderDestacada(content.destacada);
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


loadCartelera();

/* ══════════════════════════════════════════
   GALERÍA DE OBRAS
   ══════════════════════════════════════════ */

async function loadObras() {
    const grid = document.getElementById('obrasGrid');
    if (!grid) return;
    let obras = [];
    try {
        const r = await fetch('/api/content');
        const c = await r.json();
        obras = c.obras || [];
    } catch { /* sin obras */ }

    if (!obras.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 24px;color:rgba(255,200,200,0.30);font-size:0.85em">Próximamente</div>`;
        return;
    }

    grid.innerHTML = obras.map((o, idx) => `
        <div class="prod-card obra-card-clickable" style="padding:0;overflow:hidden" data-idx="${idx}">
            ${o.photoUrl ? `<div class="obra-afiche-wrap"><img class="obra-afiche" src="${esc(o.photoUrl)}" alt="${esc(o.titulo)}" loading="lazy"></div>` : ''}
            <div style="padding:22px 22px 18px">
                ${o.temporada ? `<span class="prod-year">${esc(o.temporada)}</span>` : ''}
                <div class="prod-title" style="margin-top:8px;transition:color .2s">${esc(o.titulo)}</div>
                ${o.duracion ? `<p class="obra-duracion"><i class="bx bx-time-five" style="vertical-align:middle;margin-right:4px"></i>${esc(o.duracion)}</p>` : ''}
                ${o.sinopsis ? `<p class="obra-sinopsis">${esc(o.sinopsis.slice(0,120))}${o.sinopsis.length>120?'…':''}</p>` : ''}
            </div>
        </div>`).join('');

    grid.querySelectorAll('.obra-card-clickable').forEach(card => {
        card.addEventListener('click', () => _openObra(obras[+card.dataset.idx]));
    });
}

/* ── Modal Obra ── */
const _om     = document.getElementById('obraModal');
const _omBack = document.getElementById('obraModalBack');
const _omClose = document.getElementById('obraModalClose');

function _openObra(o) {
    document.getElementById('obraModalTemporada').textContent = o.temporada || '';
    document.getElementById('obraModalTitulo').textContent    = o.titulo    || '';
    document.getElementById('obraModalDuracion').textContent  = o.duracion  ? '⏱ ' + o.duracion : '';
    document.getElementById('obraModalSinopsis').textContent  = o.sinopsis  || '';
    const img = document.getElementById('obraModalImg');
    if (o.photoUrl) { img.src = o.photoUrl; img.style.display = 'block'; }
    else              { img.style.display = 'none'; }

    const testDiv = document.getElementById('obraModalTestimonios');
    const tests   = (o.testimonios || []).filter(t => t.texto);
    if (tests.length) {
        testDiv.innerHTML = `<h3 style="font-size:0.72em;letter-spacing:2px;text-transform:uppercase;color:rgba(201,162,39,0.7);margin:0 0 12px">Testimonios</h3>` +
            tests.map(t => `
                <div class="testimonio-card">
                    <p class="testimonio-texto">"${esc(t.texto)}"</p>
                    <p class="testimonio-autor">${esc(t.autor)}${t.rol ? ' · ' + esc(t.rol) : ''}</p>
                </div>`).join('');
    } else { testDiv.innerHTML = ''; }

    _om.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
function _closeObra() { _om.style.display = 'none'; document.body.style.overflow = ''; }
_omClose.addEventListener('click', _closeObra);
_omBack.addEventListener('click',  _closeObra);
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeObra(); });

loadObras();
