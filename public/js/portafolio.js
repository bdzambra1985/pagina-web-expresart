initNavAuth();

const _grid = document.getElementById('studentsGrid');

fetch('/api/profiles')
    .then(r => r.json())
    .then(profiles => {
        if (!profiles.length) {
            _grid.innerHTML = `
                <div class="empty-state">
                    <i class="bx bx-mask"></i>
                    <p>Próximamente — los perfiles de nuestros artistas</p>
                </div>`;
            return;
        }
        _grid.innerHTML = profiles.map(p => `
            <div class="student-card" data-uid="${esc(p.userId)}">
                <div class="card-media">
                    ${p.photoUrl
                        ? `<img class="card-img" src="${esc(p.photoUrl)}" alt="${esc(p.displayName)}">`
                        : `<div class="card-img-placeholder">
                               <i class="bx bx-user-circle"></i>
                               <span>Artista</span>
                           </div>`
                    }
                    <div class="card-overlay">
                        <div class="card-name">${esc(p.displayName)}</div>
                        ${p.bio_short ? `<div class="card-bio">${esc(p.bio_short)}</div>` : ''}
                        ${p.especialidades && p.especialidades.length
                            ? `<div class="card-tags">${p.especialidades.slice(0,3).map(e => `<span class="card-tag">${esc(e)}</span>`).join('')}</div>`
                            : ''
                        }
                        ${(p.producciones || p.videos) ? `<div class="card-stats">
                            ${p.producciones ? `<span class="card-stat"><i class="bx bx-mask"></i>${p.producciones} obra${p.producciones !== 1 ? 's' : ''}</span>` : ''}
                            ${p.videos ? `<span class="card-stat"><i class="bx bx-play-circle"></i>${p.videos} video${p.videos !== 1 ? 's' : ''}</span>` : ''}
                        </div>` : ''}
                        <a href="portafolio-alumno.html?id=${esc(p.userId)}" class="card-btn">Ver Portafolio</a>
                    </div>
                </div>
            </div>`).join('');
    })
    .catch(() => {
        _grid.innerHTML = `
            <div class="empty-state">
                <i class="bx bx-mask"></i>
                <p>No se pudo cargar los perfiles</p>
            </div>`;
    });

_grid.addEventListener('click', function(e) {
    const card = e.target.closest('.student-card[data-uid]');
    if (!card) return;
    const link = e.target.closest('a');
    if (!link) location.href = 'portafolio-alumno.html?id=' + card.dataset.uid;
});
