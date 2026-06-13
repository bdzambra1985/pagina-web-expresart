initNavAuth();

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

    grid.innerHTML = prods.map(p => `
        <div class="prod-card">
            ${p.year ? `<span class="prod-year">${esc(p.year)}</span>` : ''}
            <div class="prod-title">${esc(p.title)}</div>
            ${p.description ? `<p class="prod-desc">${esc(p.description)}</p>` : ''}
        </div>`).join('');
}

loadCartelera();
