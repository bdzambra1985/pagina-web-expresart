const TOKEN = localStorage.getItem('exp_token');
let myUserId = '';
let profile  = { displayName:'', bio:'', bio_short:'', photoUrl:'', especialidades:[], producciones:[], videos:[] };

/* ── Auth ── */
async function init() {
    if (!TOKEN) return (location.href = 'login.html');

    const wantPay = new URLSearchParams(location.search).get('view') === 'pay';
    if (wantPay) {
        document.getElementById('editContent').style.display = 'none';
        document.getElementById('payPanel').classList.add('open');
        document.getElementById('editToggleBtn').classList.remove('tab-active');
        document.getElementById('payToggleBtn').classList.add('tab-active');
    }

    const r = await fetch('/api/auth', { headers: { 'x-session-token': TOKEN } });
    const d = await r.json();
    if (!d.ok || d.role === 'admin') {
        localStorage.removeItem('exp_token');
        return (location.href = 'login.html');
    }
    myUserId = d.userId;
    const earlyName = d.displayName || d.userId;
    const heroEl = document.getElementById('heroTitle');
    if (heroEl && earlyName) {
        heroEl.textContent = earlyName;
        heroEl.style.visibility = '';
    }
    await loadProfile();
    await loadShareLinks();
    if (wantPay) loadMyOrders();
}
init();

/* ── Toast ── */
function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
}

/* ── Logout ── */
document.getElementById('logoutBtn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-session-token': TOKEN } });
    localStorage.removeItem('exp_token');
    location.href = 'login.html';
};

/* ── Tab buttons ── */
document.getElementById('editToggleBtn').addEventListener('click', showEditView);
document.getElementById('payToggleBtn').addEventListener('click', showPayView);
document.getElementById('portfolioToggleBtn').addEventListener('click', togglePortfolioActive);

/* ── Cargar perfil ── */
async function loadProfile() {
    const r = await fetch('/api/my-profile', { headers: { 'x-session-token': TOKEN } });
    const d = await r.json();
    if (!d.ok) return;
    profile = d.profile;
    renderAll();
}

function renderAll() {
    const name = profile.displayName || myUserId;
    const heroEl = document.getElementById('heroTitle');
    if (heroEl) heroEl.textContent = name;
    document.getElementById('displayName').value = profile.displayName || '';
    document.getElementById('bio_short').value   = profile.bio_short   || '';
    document.getElementById('bio').value         = profile.bio         || '';
    renderAvatar();
    renderEsp();
    renderProd();
    renderPortfolioToggle();
}

function renderPortfolioToggle() {
    const btn   = document.getElementById('portfolioToggleBtn');
    const label = document.getElementById('portfolioToggleLabel');
    if (!btn) return;
    const active = profile.portfolioActive !== false;
    btn.classList.toggle('active', active);
    label.textContent = active ? 'Portafolio: visible al público' : 'Portafolio: oculto al público';
}

async function togglePortfolioActive() {
    const newVal = profile.portfolioActive === false;
    try {
        const r = await fetch('/api/my-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': TOKEN },
            body: JSON.stringify({ portfolioActive: newVal })
        });
        const d = await r.json();
        if (d.ok) {
            profile.portfolioActive = newVal;
            renderPortfolioToggle();
            showToast(newVal ? '✓ Portafolio visible al público' : 'Portafolio ocultado al público');
        }
    } catch { showToast('Error al cambiar estado', true); }
}

/* ── Avatar ── */
function renderAvatar() {
    const wrap = document.getElementById('avatarWrap');
    if (profile.photoUrl) {
        wrap.innerHTML = `<img class="current-avatar" src="${esc(profile.photoUrl)}" alt="Foto de perfil">`;
    } else {
        wrap.innerHTML = `<div class="avatar-placeholder-sm"><i class="bx bx-user"></i></div>`;
    }
}

/* ── Subir foto ── */
document.getElementById('photoBtn').onclick = () => document.getElementById('photoInput').click();
document.getElementById('photoInput').onchange = async () => {
    const file = document.getElementById('photoInput').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    showToast('Subiendo foto…');
    const r = await fetch('/api/upload-photo', { method:'POST', headers:{'x-session-token':TOKEN}, body: fd });
    const d = await r.json();
    if (d.ok) {
        profile.photoUrl = d.url;
        renderAvatar();
        showToast('✓ Foto actualizada');
    } else {
        showToast(d.message || 'Error al subir foto', true);
    }
};

/* ── Guardar información básica ── */
document.getElementById('saveBasicBtn').onclick = async () => {
    const btn = document.getElementById('saveBasicBtn');
    btnLoad(btn);
    try {
        const r = await fetch('/api/my-profile', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'x-session-token': TOKEN },
            body: JSON.stringify({
                displayName: document.getElementById('displayName').value.trim(),
                bio_short:   document.getElementById('bio_short').value.trim(),
                bio:         document.getElementById('bio').value.trim()
            })
        });
        const d = await r.json();
        if (d.ok) {
            profile.displayName = document.getElementById('displayName').value.trim();
            const name = profile.displayName || myUserId;
            const heroEl = document.getElementById('heroTitle');
            if (heroEl) heroEl.textContent = name;
            showToast('✓ Información guardada');
        } else {
            showToast(d.message || 'Error', true);
        }
    } finally {
        btnDone(btn);
    }
};

/* ══════════════════════
   ESPECIALIDADES
   ══════════════════════ */
function renderEsp() {
    const container = document.getElementById('espTags');
    container.innerHTML = '';
    (profile.especialidades || []).forEach((e, i) => {
        const chip = document.createElement('span');
        chip.className = 'esp-chip';
        chip.innerHTML = `${esc(e)}<button data-action="remove-esp" data-idx="${i}" title="Quitar">×</button>`;
        container.appendChild(chip);
    });
    if (!profile.especialidades || !profile.especialidades.length) {
        container.innerHTML = '<span style="font-size:0.75rem;color:rgba(255,200,200,0.35);font-style:italic">Sin especialidades todavía</span>';
    }
}

window.removeEsp = function(i) {
    profile.especialidades.splice(i, 1);
    renderEsp();
};

document.getElementById('espInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addEsp(); }
});
document.getElementById('addEspBtn').onclick = addEsp;
function addEsp() {
    const input = document.getElementById('espInput');
    const val   = input.value.trim();
    if (!val) return;
    profile.especialidades = profile.especialidades || [];
    if (!profile.especialidades.includes(val)) {
        profile.especialidades.push(val);
        renderEsp();
    }
    input.value = '';
}

document.getElementById('saveEspBtn').onclick = async () => {
    const btn = document.getElementById('saveEspBtn');
    btnLoad(btn);
    try {
        const r = await fetch('/api/my-profile', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'x-session-token': TOKEN },
            body: JSON.stringify({ especialidades: profile.especialidades })
        });
        const d = await r.json();
        if (d.ok) showToast('✓ Especialidades guardadas');
        else      showToast(d.message || 'Error', true);
    } finally {
        btnDone(btn);
    }
};

/* ══════════════════════
   PRODUCCIONES
   ══════════════════════ */
function renderProd() {
    const list = document.getElementById('prodList');
    list.innerHTML = '';
    (profile.producciones || []).forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'prod-card';
        card.innerHTML = `
            <div class="prod-card-header">
                <span class="prod-num">Producción ${i+1}</span>
                <button class="del-btn" data-action="delete-prod" data-idx="${i}"><i class="bx bx-trash"></i></button>
            </div>

            <div class="prod-photo-wrap">
                ${p.photoUrl
                    ? `<img class="prod-photo-preview" src="${esc(p.photoUrl)}" style="display:block" alt="Foto">`
                    : ''
                }
                <div class="prod-photo-zone" id="prodZone${i}" style="${p.photoUrl?'display:none':''}">
                    <i class="bx bx-image-add"></i> Subir foto de la producción
                </div>
                <input type="file" class="prod-photo-input" id="prodPhotoInput${i}" accept=".jpg,.jpeg,.png,.webp,.gif">
            </div>

            <div class="field-row">
                <div class="field-group">
                    <label class="field-label">Año</label>
                    <input class="dash-input" data-prod="${i}" data-key="year" type="text" value="${esc(p.year||'')}" placeholder="2024">
                </div>
                <div class="field-group">
                    <label class="field-label">Rol / Personaje</label>
                    <input class="dash-input" data-prod="${i}" data-key="role" type="text" value="${esc(p.role||'')}" placeholder="Protagonista, Antígona…">
                </div>
            </div>
            <div class="field-row full">
                <div class="field-group">
                    <label class="field-label">Título de la obra</label>
                    <input class="dash-input" data-prod="${i}" data-key="title" type="text" value="${esc(p.title||'')}" placeholder="Nombre de la obra">
                </div>
            </div>
            <div class="field-row full">
                <div class="field-group">
                    <label class="field-label">Descripción</label>
                    <textarea class="dash-textarea" data-prod="${i}" data-key="description" rows="2" placeholder="Teatro Municipal, director, notas…">${esc(p.description||'')}</textarea>
                </div>
            </div>

            <span class="prod-collage-label"><i class="bx bx-images"></i> Fotos adicionales del collage (hasta 5)</span>
            <div class="prod-collage-grid" id="collageGrid${i}"></div>

            <span class="prod-collage-label" style="margin-top:10px"><i class="bx bx-play-circle"></i> Videos de esta producción</span>
            <div id="prodVideoList${i}" style="margin-bottom:10px"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">
                <div class="field-group">
                    <label class="field-label">Título del video</label>
                    <input class="dash-input" id="pvTitle${i}" type="text" placeholder="Ej: Ensayo general 2024">
                </div>
                <div class="field-group">
                    <label class="field-label">URL (YouTube, Vimeo…)</label>
                    <input class="dash-input" id="pvUrl${i}" type="url" placeholder="https://youtube.com/watch?v=…">
                </div>
                <div class="field-group">
                    <label class="field-label" style="opacity:0">—</label>
                    <button class="add-btn" data-action="add-prod-video" data-idx="${i}"><i class="bx bx-plus"></i> Agregar</button>
                </div>
            </div>`;
        list.appendChild(card);

        renderCollageSlots(i);
        renderProdVideos(i);

        const zone  = card.querySelector('#prodZone' + i);
        const input = card.querySelector('#prodPhotoInput' + i);
        zone.onclick  = () => input.click();
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('photo', file);
            showToast('Subiendo imagen…');
            const r = await fetch('/api/upload-prod-photo', { method:'POST', headers:{'x-session-token':TOKEN}, body:fd });
            const d = await r.json();
            if (d.ok) {
                profile.producciones[i].photoUrl = d.url;
                profile.producciones = collectProd();
                renderProd();
                showToast('✓ Foto de producción subida');
            } else {
                showToast(d.message || 'Error', true);
            }
        };
    });
}

window.deleteProd = function(i) {
    profile.producciones = collectProd();
    profile.producciones.splice(i, 1);
    renderProd();
};

/* ── Slots de collage ── */
function renderCollageSlots(prodIdx) {
    const grid = document.getElementById('collageGrid' + prodIdx);
    if (!grid) return;
    const photos = profile.producciones[prodIdx].photos || [];
    grid.innerHTML = '';
    for (let j = 0; j < 5; j++) {
        const slot = document.createElement('div');
        slot.className = 'collage-slot';
        if (photos[j]) {
            slot.innerHTML = `<img src="${esc(photos[j])}" alt="foto ${j+1}">
                <button class="collage-slot-del" data-action="remove-collage" data-prod-idx="${prodIdx}" data-slot="${j}" title="Quitar">×</button>`;
        } else {
            slot.innerHTML = `<div class="collage-slot-ph"><i class="bx bx-image-add"></i><span>Foto ${j+1}</span></div>`;
            slot.onclick = () => uploadCollagePhoto(prodIdx, j);
        }
        grid.appendChild(slot);
    }
}

window.removeCollagePhoto = function(prodIdx, j) {
    if (!profile.producciones[prodIdx].photos) return;
    profile.producciones[prodIdx].photos[j] = '';
    renderCollageSlots(prodIdx);
};

async function uploadCollagePhoto(prodIdx, slotIdx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp,.gif';
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('photo', file);
        showToast('Subiendo foto del collage…');
        const r = await fetch('/api/upload-prod-photo', { method:'POST', headers:{'x-session-token':TOKEN}, body:fd });
        const d = await r.json();
        if (d.ok) {
            if (!profile.producciones[prodIdx].photos) profile.producciones[prodIdx].photos = [];
            profile.producciones[prodIdx].photos[slotIdx] = d.url;
            renderCollageSlots(prodIdx);
            showToast('✓ Foto del collage guardada');
        } else {
            showToast(d.message || 'Error al subir foto', true);
        }
    };
    input.click();
}

document.getElementById('addProdBtn').onclick = () => {
    profile.producciones = collectProd();
    profile.producciones.push({ year:'', title:'', role:'', description:'', photoUrl:'' });
    renderProd();
};

function collectProd() {
    const cards  = document.querySelectorAll('.prod-card');
    const result = [];
    cards.forEach((card, i) => {
        const obj = { ...(profile.producciones[i] || {}) };
        card.querySelectorAll('[data-key]').forEach(el => {
            obj[el.dataset.key] = el.value;
        });
        result.push(obj);
    });
    return result;
}

document.getElementById('saveProdBtn').onclick = async () => {
    const btn = document.getElementById('saveProdBtn');
    btnLoad(btn);
    try {
        const producciones = collectProd();
        const r = await fetch('/api/my-profile', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'x-session-token': TOKEN },
            body: JSON.stringify({ producciones })
        });
        const d = await r.json();
        if (d.ok) { profile.producciones = producciones; showToast('✓ Producciones guardadas'); }
        else      showToast(d.message || 'Error', true);
    } finally {
        btnDone(btn);
    }
};

/* ── Videos por producción ── */
function renderProdVideos(prodIdx) {
    const el = document.getElementById('prodVideoList' + prodIdx);
    if (!el) return;
    const videos = (profile.producciones[prodIdx].videos || []).filter(v => v && v.url);
    if (!videos.length) {
        el.innerHTML = '<p style="font-size:0.72rem;color:rgba(255,200,200,0.35);font-style:italic;margin-bottom:4px">Sin videos todavía</p>';
        return;
    }
    el.innerHTML = videos.map((v, j) => `
        <div class="video-card" style="padding:8px 12px;margin-bottom:6px;">
            <i class="bx bx-play-circle"></i>
            <div class="video-card-info">
                <div class="video-card-title">${esc(v.title || 'Video '+(j+1))}</div>
                <div class="video-card-url">${esc(v.url)}</div>
            </div>
            <button class="del-btn" data-action="delete-prod-video" data-prod-idx="${prodIdx}" data-vid-idx="${j}"><i class="bx bx-trash"></i></button>
        </div>`).join('');
}

window.addProdVideo = function(prodIdx) {
    const url   = document.getElementById('pvUrl'   + prodIdx).value.trim();
    const title = document.getElementById('pvTitle' + prodIdx).value.trim();
    if (!url) return showToast('Ingresa una URL de video', true);
    if (!profile.producciones[prodIdx].videos) profile.producciones[prodIdx].videos = [];
    profile.producciones[prodIdx].videos.push({ url, title });
    renderProdVideos(prodIdx);
    document.getElementById('pvUrl'   + prodIdx).value = '';
    document.getElementById('pvTitle' + prodIdx).value = '';
    showToast('✓ Video agregado');
};

window.deleteProdVideo = function(prodIdx, j) {
    profile.producciones[prodIdx].videos.splice(j, 1);
    renderProdVideos(prodIdx);
};

/* ── Share links ── */
async function loadShareLinks() {
    const r = await fetch('/api/share-links', { headers: { 'x-session-token': TOKEN } });
    if (!r.ok) return;
    const links = await r.json();
    renderShareList(links);
}

function renderShareList(links) {
    const el = document.getElementById('shareList');
    if (!links.length) {
        el.innerHTML = '<p class="share-empty">Aún no tienes enlaces privados generados.</p>';
        return;
    }
    el.innerHTML = '<p class="share-list-title">Mis enlaces activos</p>' +
        links.map(l => {
            const fecha = new Date(l.createdAt).toLocaleDateString('es-EC', { day:'2-digit', month:'short', year:'numeric' });
            const sid   = esc(l.shareId);
            return `<div class="share-item">
                <div class="share-item-info">
                    <span class="share-item-id"><i class="bx bx-user-check" style="color:#c9a227;margin-right:4px"></i>${sid}</span>
                    <span class="share-item-meta">${l.label ? esc(l.label) + ' · ' : ''}Creado ${fecha}</span>
                </div>
                <button class="share-revoke-btn" data-action="revoke-share" data-share-id="${sid}">
                    <i class="bx bx-trash"></i> Revocar
                </button>
            </div>`;
        }).join('');
}

document.getElementById('genShareBtn').onclick = async () => {
    const btn   = document.getElementById('genShareBtn');
    const label = document.getElementById('shareLabelInput').value.trim();
    btn.disabled = true;
    btn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Generando…';
    try {
        const r = await fetch('/api/share-links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': TOKEN },
            body: JSON.stringify({ label })
        });
        const d = await r.json();
        if (!d.ok) { showToast(d.message || 'Error al generar enlace', true); return; }
        document.getElementById('shareLabelInput').value = '';
        const box = document.getElementById('newShareCreds');
        box.style.display = 'block';
        box.innerHTML = `<div class="share-creds-box">
            <p class="creds-title"><i class="bx bx-check-circle" style="color:#5fca7a;margin-right:5px"></i>Enlace generado — guarda estas credenciales ahora</p>
            <div class="creds-row">
                <span class="creds-label">Enlace</span>
                <span class="creds-val" id="sc_url">${esc(d.url)}</span>
                <button class="copy-btn" data-action="copy-val" data-target="sc_url"><i class="bx bx-copy"></i></button>
            </div>
            <div class="creds-row">
                <span class="creds-label">Usuario</span>
                <span class="creds-val" id="sc_user">${esc(d.shareId)}</span>
                <button class="copy-btn" data-action="copy-val" data-target="sc_user"><i class="bx bx-copy"></i></button>
            </div>
            <div class="creds-row">
                <span class="creds-label">Contraseña</span>
                <span class="creds-val" id="sc_pw">${esc(d.password)}</span>
                <button class="copy-btn" data-action="copy-val" data-target="sc_pw"><i class="bx bx-copy"></i></button>
            </div>
            <p style="font-size:0.67em;color:rgba(255,180,180,0.45);margin-top:10px">
                La contraseña no se puede recuperar después de cerrar esta sección.
            </p>
        </div>`;
        await loadShareLinks();
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bx bx-plus-circle"></i> Generar nuevo enlace';
    }
};

function copyVal(id) {
    const txt = document.getElementById(id).textContent;
    navigator.clipboard.writeText(txt).then(() => showToast('¡Copiado!'));
}

window.revokeShareLink = async function(shareId) {
    if (!confirm('¿Revocar este enlace? Quien lo tenga ya no podrá acceder.')) return;
    const r = await fetch('/api/share-links/' + encodeURIComponent(shareId), {
        method: 'DELETE',
        headers: { 'x-session-token': TOKEN }
    });
    const d = await r.json();
    if (d.ok) {
        showToast('Enlace revocado');
        await loadShareLinks();
    }
    else showToast(d.message || 'Error', true);
};

/* ── Vistas ── */
function showEditView() {
    document.getElementById('editContent').style.display = '';
    document.getElementById('payPanel').classList.remove('open');
    document.getElementById('editToggleBtn').classList.add('tab-active');
    document.getElementById('payToggleBtn').classList.remove('tab-active');
}

function showPayView() {
    document.getElementById('editContent').style.display = 'none';
    document.getElementById('payPanel').classList.add('open');
    document.getElementById('editToggleBtn').classList.remove('tab-active');
    document.getElementById('payToggleBtn').classList.add('tab-active');
    document.getElementById('regPagoSection').style.display = 'none';
    document.getElementById('regSuccessPanel').style.display = 'none';
    document.getElementById('formPanel').style.display = 'block';
    loadMyOrders();
}

/* ── Matriz personal de pagos ── */
const MY_MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
let myMatYear  = new Date().getFullYear();
let myMatOrders = [];

function renderMyMatrix() {
    const wrap   = document.getElementById('myPayMatrix');
    const yearEl = document.getElementById('myMatYear');
    if (yearEl) yearEl.textContent = myMatYear;
    if (!wrap) return;

    const currentMo = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7);
    const paid = {};
    myMatOrders.filter(o => o.status === 'confirmado').forEach(o => {
        const mo = o.paymentMonth || (o.confirmedAt
            ? new Date(o.confirmedAt).toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7)
            : null);
        if (mo && mo.startsWith(myMatYear + '')) paid[mo] = true;
    });

    const thStyle = 'padding:6px 4px;font-size:0.64em;letter-spacing:1.5px;text-transform:uppercase;color:rgba(201,162,39,0.70);text-align:center;white-space:nowrap;';
    const name = esc(profile.displayName || myUserId);

    wrap.innerHTML = `<table style="border-collapse:collapse;width:100%;margin-top:4px;">
    <thead><tr>
        <th style="${thStyle}text-align:left;min-width:110px;">Alumno</th>
        ${MY_MESES.map((mes, m) => {
            const mo = `${myMatYear}-${String(m+1).padStart(2,'0')}`;
            return `<th style="${thStyle}${mo === currentMo ? 'color:#f0d060;' : ''}">${mes}</th>`;
        }).join('')}
    </tr></thead>
    <tbody><tr>
        <td style="padding:8px 8px 8px 0;font-size:0.80em;color:rgba(255,220,220,0.85);white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;" title="${name}">${name}</td>
        ${MY_MESES.map((mes, m) => {
            const mo  = `${myMatYear}-${String(m+1).padStart(2,'0')}`;
            const cur = mo === currentMo ? 'background:rgba(201,162,39,0.06);' : '';
            return `<td style="text-align:center;padding:8px 4px;${cur}">
                <span style="display:inline-block;width:14px;height:14px;border-radius:50%;${paid[mo] ? 'background:#c0392b;' : 'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.16);'}"></span>
            </td>`;
        }).join('')}
    </tr></tbody>
    </table>`;
}

document.addEventListener('DOMContentLoaded', () => {
    const prev = document.getElementById('myMatPrev');
    const next = document.getElementById('myMatNext');
    if (prev) prev.onclick = () => { myMatYear--; renderMyMatrix(); };
    if (next) next.onclick = () => { myMatYear++; renderMyMatrix(); };
});

/* ══════════════════════════════════════════
   REGISTRO DE PAGO INLINE
   ══════════════════════════════════════════ */
let bankInfoLoaded = false;
let bankInfoData   = {};

async function loadBankInfo() {
    try {
        const r    = await fetch('/api/bank-info');
        bankInfoData = await r.json();
        renderBankInfo(bankInfoData);
        loadPayServices(bankInfoData.services || []);
    } catch {
        const el = document.getElementById('bankData');
        if (el) el.innerHTML = '<p class="no-bank">No se pudieron cargar los datos bancarios.</p>';
    }
}

function renderBankInfo(info) {
    const el = document.getElementById('bankData');
    if (!el) return;
    if (!info.bankName && !info.accountNumber) {
        el.innerHTML = '<p class="no-bank">Los datos bancarios aún no han sido configurados.</p>';
        return;
    }
    const rows = [
        { label: 'Banco',          value: info.bankName      || '' },
        { label: 'Tipo de cuenta', value: info.accountType   || '' },
        { label: 'No. de cuenta',  value: info.accountNumber || '', copy: true },
        { label: 'Titular',        value: info.accountHolder || '' },
        { label: 'RUC / Cédula',   value: info.ruc           || '' },
    ].filter(r => r.value);
    el.innerHTML = rows.map(r => `
        <div class="bank-row">
            <span class="bank-label">${r.label}</span>
            <span class="bank-value">${r.value}${r.copy ? ` <button class="copy-btn" data-action="copy-bank" data-val="${r.value}">Copiar</button>` : ''}</span>
        </div>`).join('');
}

function loadPayServices(services) {
    const sel = document.getElementById('fConcept');
    if (!sel) return;
    sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
    services.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name + (s.price ? ` — $${s.price}` : '');
        opt.textContent = s.name + (s.price ? ` — $${parseFloat(s.price).toFixed(2)}` : '');
        if (s.price) opt.dataset.price = s.price;
        sel.appendChild(opt);
    });
    const other = document.createElement('option');
    other.value = 'Otro'; other.textContent = 'Otro (especificar en notas)';
    sel.appendChild(other);
}

document.getElementById('toggleRegPagoBtn').addEventListener('click', function() {
    const section = document.getElementById('regPagoSection');
    const isOpen  = section.style.display !== 'none';
    if (isOpen) { section.style.display = 'none'; return; }
    // Resetear siempre al abrir
    document.getElementById('regSuccessPanel').style.display = 'none';
    document.getElementById('formPanel').style.display       = 'block';
    document.getElementById('fName').value    = '';
    document.getElementById('fDoc').value     = '';
    document.getElementById('fEmail').value   = '';
    document.getElementById('fConcept').selectedIndex = 0;
    document.getElementById('fAmount').value  = '';
    document.getElementById('fNotes').value   = '';
    document.getElementById('fReceipt').value = '';
    document.getElementById('uploadName').textContent = '';
    document.getElementById('uploadZone').classList.remove('has-file');
    document.getElementById('ivaPreview').style.display = 'none';
    document.getElementById('fMonth').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7);
    if (!bankInfoLoaded) { loadBankInfo(); bankInfoLoaded = true; }
    section.style.display = 'block';
    setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
});

document.getElementById('fConcept').addEventListener('change', function() {
    const opt = this.options[this.selectedIndex];
    if (opt && opt.dataset.price) {
        document.getElementById('fAmount').value = parseFloat(opt.dataset.price).toFixed(2);
        updateRegIVA();
    }
});

function updateRegIVA() {
    const amount  = parseFloat(document.getElementById('fAmount').value);
    const preview = document.getElementById('ivaPreview');
    if (!amount || amount <= 0) { preview.style.display = 'none'; return; }
    const subtotal = (amount / 1.15).toFixed(2);
    const iva      = (amount - subtotal).toFixed(2);
    document.getElementById('ivaSubtotal').textContent = '$' + subtotal;
    document.getElementById('ivaAmount').textContent   = '$' + iva;
    document.getElementById('ivaTotal').textContent    = '$' + amount.toFixed(2);
    preview.style.display = 'block';
}
document.getElementById('fAmount').addEventListener('input', updateRegIVA);

document.getElementById('fReceipt').addEventListener('change', function() {
    const zone = document.getElementById('uploadZone');
    const name = document.getElementById('uploadName');
    if (this.files[0]) { name.textContent = '✓ ' + this.files[0].name; zone.classList.add('has-file'); }
    else               { name.textContent = ''; zone.classList.remove('has-file'); }
});

document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action="copy-bank"]');
    if (btn) navigator.clipboard.writeText(btn.dataset.val).catch(() => {});
});

document.getElementById('submitBtn').addEventListener('click', async () => {
    const name    = document.getElementById('fName').value.trim();
    const doc     = document.getElementById('fDoc').value.trim();
    const email   = document.getElementById('fEmail').value.trim();
    const concept = document.getElementById('fConcept').value;
    const amount  = document.getElementById('fAmount').value;
    const notes   = document.getElementById('fNotes').value.trim();
    const month   = document.getElementById('fMonth').value;
    const receipt = document.getElementById('fReceipt').files[0];
    if (!name || !doc || !email || !concept || !amount) { showToast('Completa todos los campos obligatorios', true); return; }
    if (!receipt) { showToast('Adjunta el comprobante de transferencia', true); return; }
    const btn = document.getElementById('submitBtn');
    btnLoad(btn);
    const fd = new FormData();
    fd.append('customerName',  name);
    fd.append('customerDoc',   doc);
    fd.append('customerEmail', email);
    fd.append('concept',       concept);
    fd.append('amount',        amount);
    fd.append('notes',         notes);
    fd.append('paymentMonth',  month);
    fd.append('receipt',       receipt);
    try {
        const r    = await fetch('/api/orders', { method: 'POST', headers: { 'x-session-token': TOKEN }, body: fd });
        const data = await r.json();
        if (!data.ok) throw new Error(data.message);
        document.getElementById('regSuccessId').textContent = 'Ref: ' + data.orderId;
        document.getElementById('formPanel').style.display        = 'none';
        document.getElementById('regSuccessPanel').style.display  = 'block';
        loadMyOrders();
    } catch (e) {
        showToast('Error al enviar: ' + e.message, true);
        btnDone(btn);
    }
});


async function loadMyOrders() {
    const wrap = document.getElementById('myOrdersWrap');
    try {
        const r      = await fetch('/api/my-orders', { headers: { 'x-session-token': TOKEN } });
        const orders = await r.json();
        myMatOrders  = orders;
        const matrixWrap = document.getElementById('myMatrixWrap');
        if (matrixWrap) matrixWrap.style.display = '';
        renderMyMatrix();
        if (!orders.length) {
            wrap.innerHTML = '<p class="pay-empty">Aún no tienes pagos registrados en esta cuenta.</p>';
            return;
        }
        wrap.innerHTML = `
        <table class="pay-table">
            <thead><tr>
                <th>Fecha</th>
                <th>Concepto</th>
                <th>Monto</th>
                <th>Estado</th>
                <th>Documentos</th>
            </tr></thead>
            <tbody>
            ${orders.map(o => {
                const fecha = new Date(o.confirmedAt || o.createdAt)
                    .toLocaleDateString('es-EC', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'America/Guayaquil' });
                const badgeCls = o.status === 'confirmado' ? 'pay-badge-ok'
                               : o.status === 'rechazado'  ? 'pay-badge-rejected'
                               : 'pay-badge-pending';
                const badgeTxt = o.status === 'confirmado' ? 'Confirmado'
                               : o.status === 'rechazado'  ? 'Rechazado'
                               : 'Pendiente';
                const receiptHref = o.receiptUrl && o.receiptUrl.startsWith('/uploads/')
                    ? o.receiptUrl + '?t=' + encodeURIComponent(TOKEN)
                    : (o.receiptUrl || '');
                const docs = receiptHref
                    ? `<a class="pay-link" href="${esc(receiptHref)}" target="_blank"><i class="bx bx-image-alt"></i> Comprobante</a>`
                    : '';
                const sri = o.sri && o.sri.status === 'autorizado'
                    ? `<a class="pay-link" href="/factura/${o.id}?token=${o.token}" target="_blank"><i class="bx bx-receipt"></i> Factura SRI</a>`
                    : '';
                return `<tr>
                    <td>${fecha}</td>
                    <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(o.concept)}">${esc(o.concept)}${o.notes ? ` <span style="color:rgba(255,200,200,0.4);font-size:0.85em">— ${esc(o.notes.slice(0,40))}</span>` : ''}</td>
                    <td>$${parseFloat(o.amount).toFixed(2)}</td>
                    <td><span class="pay-badge ${badgeCls}">${badgeTxt}</span></td>
                    <td>${docs}${sri}</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;
    } catch {
        wrap.innerHTML = '<p class="pay-empty">Error al cargar historial.</p>';
    }
}

/* ── Event delegation for dynamic onclicks ── */
document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'remove-esp') {
        window.removeEsp(parseInt(btn.dataset.idx));
    } else if (action === 'delete-prod') {
        window.deleteProd(parseInt(btn.dataset.idx));
    } else if (action === 'add-prod-video') {
        window.addProdVideo(parseInt(btn.dataset.idx));
    } else if (action === 'remove-collage') {
        window.removeCollagePhoto(parseInt(btn.dataset.prodIdx), parseInt(btn.dataset.slot));
    } else if (action === 'delete-prod-video') {
        window.deleteProdVideo(parseInt(btn.dataset.prodIdx), parseInt(btn.dataset.vidIdx));
    } else if (action === 'revoke-share') {
        window.revokeShareLink(btn.dataset.shareId);
    } else if (action === 'copy-val') {
        copyVal(btn.dataset.target);
    }
});
