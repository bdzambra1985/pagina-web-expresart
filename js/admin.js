/* ── Secure URL opener — fetches a short-lived signed URL from the server
   instead of embedding the session token in query params (OWASP A07) ── */
async function openProtectedUrl(resourcePath) {
    try {
        const r = await fetch('/api/signed-url?path=' + encodeURIComponent(resourcePath));
        const d = await r.json();
        if (d.ok) { window.open(d.url, '_blank', 'noopener'); }
        else showToast('Error al generar enlace seguro', true);
    } catch { showToast('Error de conexión', true); }
}

async function checkAuth() {
    const r = await fetch('/api/auth');
    const d = await r.json();
    if (!d.ok || d.role !== 'admin') {
        localStorage.removeItem('exp_role');
        location.href = 'login.html';
    }
}
checkAuth();

function toggleSection(bodyId) {
    const body      = document.getElementById(bodyId);
    const collapsed = body.classList.toggle('collapsed');
    const btn       = document.querySelector('[data-collapse="' + bodyId + '"]');
    if (btn) btn.textContent = collapsed ? '+' : '−';
}

function expandSection(bodyId) {
    const body = document.getElementById(bodyId);
    if (body && body.classList.contains('collapsed')) toggleSection(bodyId);
}

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
}

/* ── Collapsible sections (static HTML) ── */
document.querySelectorAll('.collapsible[data-section-body]').forEach(function(el) {
    el.addEventListener('click', function() {
        toggleSection(el.dataset.sectionBody);
    });
});

/* ── Tabs ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'alumnos') { loadUsers(); loadResetRequests(); loadCalUsers(); renderMatrix(); }
    };
});

/* ── Logout ── */
document.getElementById('logoutBtn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    localStorage.removeItem('exp_role');
    location.href = 'login.html';
};

/* ── Reset PW modal buttons ── */
document.getElementById('resetPwCopyBtn').addEventListener('click', function() {
    navigator.clipboard.writeText(document.getElementById('resetPwValue').textContent)
        .then(() => showToast('✓ Copiado'));
});
document.getElementById('resetPwCloseBtn').addEventListener('click', function() {
    document.getElementById('resetPwModal').style.display = 'none';
});

/* ── Paginación y búsqueda ── */
const PAGE_SIZE  = 8;
let usersPage    = 0;
let eventsPage   = 0;
let ordersPage   = 0;
let usersSearch  = '';
let eventsSearch = '';
let ordersSearch = '';

function buildPager(total, page, action) {
    if (total <= PAGE_SIZE) return '';
    const pages = Math.ceil(total / PAGE_SIZE);
    return `<div class="pager">
        <button class="pager-btn" data-action="${action}" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>‹ Anterior</button>
        <span class="pager-info">Página ${page + 1} de ${pages}</span>
        <button class="pager-btn" data-action="${action}" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Siguiente ›</button>
    </div>`;
}

/* ══════════════════════
   TAB ALUMNOS
   ══════════════════════ */
let allAlumnos = [];

async function loadUsers() {
    const r  = await fetch('/api/users', { credentials: 'same-origin' });
    const data = await r.json();
    allAlumnos = data.filter(u => u.role !== 'admin');
    renderUsers();
}

function renderUsers() {
    const wrap = document.getElementById('usersTableWrap');
    const q    = usersSearch.trim().toLowerCase();
    const sorted = allAlumnos.slice().sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
    );
    const filtered = q
        ? sorted.filter(u => u.username.toLowerCase().includes(q))
        : sorted;

    if (!filtered.length) {
        wrap.innerHTML = q
            ? '<p class="no-users">Sin resultados para esa búsqueda.</p>'
            : '<p class="no-users">No hay alumnos registrados todavía.</p>';
        return;
    }

    const page  = Math.min(usersPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    usersPage   = page;
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    wrap.innerHTML = `
        <div class="tbl-scroll"><table class="user-table">
            <thead>
                <tr>
                    <th>Usuario</th>
                    <th>Estado</th>
                    <th>Creado</th>
                    <th>Acciones</th>
                </tr>
            </thead>
            <tbody>
                ${slice.map(u => `
                <tr data-uid="${u.userId}">
                    <td>${esc(u.username)}</td>
                    <td>
                        <span class="badge ${u.active ? 'badge-active' : 'badge-inactive'}">
                            ${u.active ? 'Activo' : 'Inactivo'}
                        </span>
                    </td>
                    <td>${new Date(u.createdAt).toLocaleDateString('es')}</td>
                    <td style="display:flex;gap:6px;flex-wrap:wrap">
                        <button class="tbl-btn tbl-btn-toggle ${u.active ? 'deactivate' : ''}"
                            data-action="toggle-user" data-uid="${u.userId}" data-active="${u.active}">
                            <i class="bx ${u.active ? 'bx-block' : 'bx-check'}"></i>
                            ${u.active ? 'Desactivar' : 'Activar'}
                        </button>
                        <button class="tbl-btn tbl-btn-view"
                            data-action="view-portfolio" data-uid="${u.userId}">
                            <i class="bx bx-show"></i> Ver
                        </button>
                        <button class="tbl-btn" style="background:rgba(201,162,39,0.18);border-color:rgba(201,162,39,0.4);color:#f0d060"
                            data-action="admin-reset-pw" data-uid="${u.userId}" data-username="${esc(u.username)}">
                            <i class="bx bx-key"></i> Resetear clave
                        </button>
                        <button class="tbl-btn tbl-btn-delete"
                            data-action="delete-user" data-uid="${u.userId}" data-username="${esc(u.username)}">
                            <i class="bx bx-trash"></i> Eliminar
                        </button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table></div>
        ${buildPager(filtered.length, page, 'page-users')}`;
}

async function toggleUser(userId, currentlyActive) {
    const r = await fetch('/api/users/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentlyActive })
    });
    const d = await r.json();
    if (d.ok) { showToast(currentlyActive ? '✓ Alumno desactivado' : '✓ Alumno activado'); loadUsers(); loadResetRequests(); loadCalUsers(); renderMatrix(); }
    else        showToast(d.message || 'Error', true);
}

async function deleteUser(userId, username) {
    if (!confirm(`¿Eliminar al alumno "${username}"? Se borrarán su perfil y todas sus fotos.`)) return;
    const r = await fetch('/api/users/' + userId, {
        method: 'DELETE',
        credentials: 'same-origin'
    });
    const d = await r.json();
    if (d.ok) { showToast('✓ Alumno eliminado'); loadUsers(); loadResetRequests(); loadCalUsers(); renderMatrix(); }
    else        showToast(d.message || 'Error', true);
}

async function adminResetPassword(userId, username) {
    if (!confirm(`¿Resetear la contraseña de "${username}"? Se generará una clave temporal que deberás comunicarle.`)) return;
    const r = await fetch('/api/users/' + userId + '/reset-password', {
        method: 'POST',
        credentials: 'same-origin'
    });
    const d = await r.json();
    if (d.ok) {
        document.getElementById('resetPwUser').textContent  = username;
        document.getElementById('resetPwValue').textContent = d.tempPassword;
        document.getElementById('resetPwModal').style.display = 'flex';
        loadResetRequests();
    } else {
        showToast(d.message || 'Error al resetear', true);
    }
}

async function loadResetRequests() {
    const r    = await fetch('/api/reset-requests', { credentials: 'same-origin' });
    const data = await r.json();
    const wrap = document.getElementById('resetRequestsWrap');
    if (!wrap) return;
    if (!data.length) {
        wrap.innerHTML = '<p style="color:rgba(255,200,200,0.5);font-size:0.82em;">No hay solicitudes pendientes.</p>';
        return;
    }
    wrap.innerHTML = data.map(rq => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(201,162,39,0.08);border:1px solid rgba(201,162,39,0.25);border-radius:8px;margin-bottom:8px;">
            <div>
                <span style="color:#f0d060;font-weight:600;">${rq.username}</span>
                <span style="color:rgba(255,200,200,0.55);font-size:0.78em;margin-left:10px;">${new Date(rq.requestedAt).toLocaleString('es')}</span>
            </div>
            <div style="display:flex;gap:8px;">
                <button class="tbl-btn" style="background:rgba(201,162,39,0.2);border-color:rgba(201,162,39,0.5);color:#f0d060"
                    data-action="admin-reset-pw" data-uid="${rq.userId}" data-username="${esc(rq.username)}">
                    <i class="bx bx-key"></i> Resetear
                </button>
                <button class="tbl-btn tbl-btn-delete"
                    data-action="dismiss-reset" data-id="${rq.id}">
                    <i class="bx bx-x"></i> Descartar
                </button>
            </div>
        </div>`).join('');
}

async function dismissResetRequest(id) {
    await fetch('/api/reset-requests/' + id, { method: 'DELETE', credentials: 'same-origin' });
    loadResetRequests();
}

/* ══════════════════════════════════════
   TABLA PAGOS: ALUMNOS × MESES
   ══════════════════════════════════════ */
const MESES_CORTO   = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
let matrixYear      = new Date().getFullYear();
let matrixUsers     = [];
let matrixAllOrders = [];

async function loadCalUsers() {
    const [usersRes, ordersRes] = await Promise.all([
        fetch('/api/users',  { credentials: 'same-origin' }),
        fetch('/api/orders', { credentials: 'same-origin' })
    ]);
    const users  = await usersRes.json();
    const orders = await ordersRes.json();
    matrixUsers     = users.filter(u => u.role !== 'admin');
    matrixAllOrders = orders;
    renderMatrix();
}

function orderMonth(o) {
    if (o.paymentMonth) return o.paymentMonth;
    if (o.confirmedAt) {
        const d = new Date(o.confirmedAt);
        const y = d.toLocaleString('en-US', { timeZone: 'America/Guayaquil', year: 'numeric' });
        const m = d.toLocaleString('en-US', { timeZone: 'America/Guayaquil', month: '2-digit' });
        return `${y}-${m}`;
    }
    return null;
}

function renderMatrix() {
    document.getElementById('calYearLabel').textContent = matrixYear;
    const wrap = document.getElementById('payMatrix');

    const searchTerm = (document.getElementById('matrixSearch')?.value || '').toLowerCase().trim();
    const filtered   = matrixUsers.filter(u => {
        if (!searchTerm) return true;
        return (u.displayName || u.username || '').toLowerCase().includes(searchTerm)
            || (u.username || '').toLowerCase().includes(searchTerm);
    });

    if (!filtered.length) {
        wrap.innerHTML = '<p class="cal-no-user">' + (searchTerm ? 'Sin resultados para "' + esc(searchTerm) + '".' : 'No hay alumnos registrados.') + '</p>';
        return;
    }

    const paid = {};
    filtered.forEach(u => { paid[u.userId] = {}; });
    matrixAllOrders.forEach(o => {
        if (o.status !== 'confirmado' || !o.userId) return;
        const mo = orderMonth(o);
        if (!mo || !mo.startsWith(matrixYear + '')) return;
        if (!paid[o.userId]) return;
        if (!paid[o.userId][mo]) paid[o.userId][mo] = [];
        paid[o.userId][mo].push(o);
    });

    const currentMo = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7);
    const thStyle   = 'padding:8px 6px;font-size:0.68em;letter-spacing:1.5px;text-transform:uppercase;color:rgba(201,162,39,0.70);text-align:center;white-space:nowrap;';

    let html = `<table style="border-collapse:collapse;width:100%;">
    <thead><tr>
        <th style="${thStyle}text-align:left;padding-left:4px;min-width:150px;">Alumno</th>
        ${MESES_CORTO.map((mes, m) => {
            const mo = `${matrixYear}-${String(m + 1).padStart(2, '0')}`;
            return `<th style="${thStyle}${mo === currentMo ? 'color:#f0d060;' : ''}">${mes}</th>`;
        }).join('')}
    </tr></thead>
    <tbody>`;

    filtered.forEach(u => {
        const displayName = esc(u.displayName || u.username);
        html += `<tr>
            <td style="padding:8px 10px 8px 4px;font-size:0.82em;color:rgba(255,220,220,0.82);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;"
                title="${displayName}">${displayName}</td>
            ${MESES_CORTO.map((mes, m) => {
                const mo   = `${matrixYear}-${String(m + 1).padStart(2, '0')}`;
                const cur  = mo === currentMo ? 'background:rgba(201,162,39,0.06);' : '';
                const ords = (paid[u.userId] || {})[mo] || [];
                if (ords.length) {
                    const total = ords.reduce((s, o) => s + o.amount, 0);
                    return `<td style="text-align:center;padding:8px 6px;${cur}">
                        <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#c0392b;cursor:default;"
                              title="$${total.toFixed(2)}"></span>
                    </td>`;
                }
                return `<td style="text-align:center;padding:8px 6px;${cur}">
                    <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.16);"></span>
                </td>`;
            }).join('')}
        </tr>`;
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;
}

document.getElementById('calPrev').onclick = () => { matrixYear--; renderMatrix(); };
document.getElementById('calNext').onclick = () => { matrixYear++; renderMatrix(); };

loadCalUsers();

document.getElementById('createUserBtn').onclick = async () => {
    const username    = document.getElementById('new_username').value.trim();
    const password    = document.getElementById('new_password').value;
    const displayName = document.getElementById('new_displayName').value.trim();
    if (!username || !password) return showToast('Usuario y contraseña son requeridos', true);
    const btn = document.getElementById('createUserBtn');
    btnLoad(btn);
    try {
        const r = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, displayName })
        });
        const d = await r.json();
        if (d.ok) {
            showToast('✓ Alumno creado: ' + username);
            document.getElementById('new_username').value    = '';
            document.getElementById('new_password').value    = '';
            document.getElementById('new_displayName').value = '';
            loadUsers();
        } else {
            showToast(d.message || 'Error al crear alumno', true);
        }
    } finally {
        btnDone(btn);
    }
};

loadUsers();
loadResetRequests();

/* ══════════════════════
   FACTURA EN EFECTIVO
   ══════════════════════ */
let _ciStudents = [];
(async function loadCIStudents() {
    try {
        const r = await fetch('/api/users', { credentials: 'same-origin' });
        const users = await r.json();
        _ciStudents = users.filter(u => u.role !== 'admin');
    } catch {}
})();

(function initCIStudentSearch() {
    const input  = document.getElementById('ci_student_search');
    const dd     = document.getElementById('ci_student_dropdown');
    const uidIn  = document.getElementById('ci_student_uid');
    const badge  = document.getElementById('ci_student_badge');

    function selectStudent(u) {
        const label = u.displayName || u.username;
        input.value  = label;
        uidIn.value  = u.userId;
        badge.textContent  = '✓ Pago vinculado a: ' + label;
        badge.style.display = 'block';
        dd.style.display    = 'none';
    }

    function clearSelection() {
        uidIn.value = '';
        badge.style.display = 'none';
        badge.textContent   = '';
    }

    function showDropdown(matches) {
        if (!matches.length) { dd.style.display = 'none'; return; }
        dd.innerHTML = matches.map(u => {
            const name = u.displayName || u.username;
            const sub  = (u.displayName && u.displayName !== u.username)
                ? '<span style="color:rgba(255,200,200,0.5);font-size:0.82em;margin-left:6px">(' + u.username + ')</span>'
                : '';
            return '<div class="ci-sopt" data-uid="' + u.userId + '" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06)">' +
                   '<span style="color:#f0e8d0">' + name + '</span>' + sub + '</div>';
        }).join('');
        dd.style.display = 'block';
        dd.querySelectorAll('.ci-sopt').forEach(function(opt) {
            opt.addEventListener('mousedown', function(e) {
                e.preventDefault();
                const u = _ciStudents.find(function(s) { return s.userId === opt.dataset.uid; });
                if (u) selectStudent(u);
            });
            opt.addEventListener('mouseenter', function() { this.style.background = 'rgba(201,162,39,0.18)'; });
            opt.addEventListener('mouseleave', function() { this.style.background = ''; });
        });
    }

    input.addEventListener('input', function() {
        clearSelection();
        const q = this.value.trim().toLowerCase();
        if (!q) { dd.style.display = 'none'; return; }
        const matches = _ciStudents.filter(function(u) {
            return (u.displayName || '').toLowerCase().includes(q) ||
                   (u.username   || '').toLowerCase().includes(q);
        });
        showDropdown(matches);
    });

    input.addEventListener('blur', function() {
        setTimeout(function() { dd.style.display = 'none'; }, 180);
    });

    input.addEventListener('focus', function() {
        const q = this.value.trim().toLowerCase();
        if (q && !uidIn.value) {
            const matches = _ciStudents.filter(function(u) {
                return (u.displayName || '').toLowerCase().includes(q) ||
                       (u.username   || '').toLowerCase().includes(q);
            });
            showDropdown(matches);
        }
    });
}());

(async function loadCashInvoiceServices() {
    try {
        const r    = await fetch('/api/bank-info', { credentials: 'same-origin' });
        const info = await r.json();
        const sel  = document.getElementById('ci_concept');
        (info.services || []).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.name + (s.price ? ` — $${s.price}` : '');
            opt.textContent = opt.value;
            if (s.price) opt.dataset.price = s.price;
            sel.appendChild(opt);
        });
        sel.addEventListener('change', function() {
            const opt = this.options[this.selectedIndex];
            if (opt && opt.dataset.price) {
                document.getElementById('ci_amount').value = parseFloat(opt.dataset.price).toFixed(2);
                document.getElementById('ci_concept_custom').value = '';
            }
        });
    } catch {}
    document.getElementById('ci_month').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7);
})();

document.getElementById('cashInvoiceBtn').onclick = async () => {
    const name    = document.getElementById('ci_name').value.trim();
    const doc     = document.getElementById('ci_doc').value.trim();
    const email   = document.getElementById('ci_email').value.trim();
    const selVal  = document.getElementById('ci_concept').value;
    const custom  = document.getElementById('ci_concept_custom').value.trim();
    const concept = custom || selVal;
    const amount  = document.getElementById('ci_amount').value;
    const month   = document.getElementById('ci_month').value;
    const notes   = document.getElementById('ci_notes').value.trim();
    const userId  = document.getElementById('ci_student_uid').value || null;
    const result  = document.getElementById('cashInvoiceResult');

    if (!name || !doc || !email || !concept || !amount) {
        showToast('Completa todos los campos obligatorios', true); return;
    }
    const btn = document.getElementById('cashInvoiceBtn');
    btnLoad(btn);
    result.style.display = 'none';
    try {
        const r = await fetch('/api/orders/cash-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerName: name, customerDoc: doc, customerEmail: email, concept, amount, paymentMonth: month, notes, userId })
        });
        const d = await r.json();
        if (d.ok) {
            const studentInfo = userId ? `<br><span style="color:#7ed97e;font-size:0.9em">✓ Vinculado al historial del alumno</span>` : '';
            result.innerHTML = `<span style="color:#7ed97e">✓ Factura generada — N° ${d.invoiceNumber} · Ref: ${d.orderId}</span>${studentInfo}<br><button data-action="open-protected-url" data-path="/factura/${d.orderId}" style="background:none;border:none;color:#c9a227;text-decoration:underline;cursor:pointer;font-family:inherit;font-size:inherit;padding:0">Ver comprobante</button> <small style="color:rgba(255,200,200,0.5)">(el SRI puede tardar unos segundos)</small>`;
            result.style.display = 'block';
            showToast('✓ Factura en efectivo generada');
        } else {
            showToast(d.message || 'Error al generar factura', true);
        }
    } finally { btnDone(btn); }
};

/* ══════════════════════
   TAB CONTENIDO
   ══════════════════════ */
let content = {};

async function loadContent() {
    const r = await fetch('/api/content');
    content  = await r.json();
    renderDestacada();
    renderProd();
    renderNosotros();
}

function renderDestacada() {
    const d = content.destacada || {};
    document.getElementById('dest_title').value  = d.title       || '';
    document.getElementById('dest_author').value = d.author      || '';
    document.getElementById('dest_year').value   = d.year        || '';
    document.getElementById('dest_desc').value   = d.description || '';
    if (d.photo) {
        document.getElementById('photoPreview').src           = d.photo;
        document.getElementById('photoPreview').style.display = 'block';
        document.getElementById('photoZone').style.display    = 'none';
    }
}

function makeItemCard(label, fields, onDel) {
    const card   = document.createElement('div');
    card.className = 'item-card';
    const header = document.createElement('div');
    header.className = 'item-card-header';
    header.innerHTML = `<span class="item-num">${label}</span>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.innerHTML = '<i class="bx bx-trash"></i>';
    delBtn.onclick   = onDel;
    header.appendChild(delBtn);
    card.appendChild(header);
    fields.forEach(f => {
        const row = document.createElement('div');
        row.className = 'field-row' + (f.full ? ' full' : '');
        const grp = document.createElement('div');
        grp.className = 'field-group';
        const lbl = document.createElement('label');
        lbl.className   = 'field-label';
        lbl.textContent = f.label;
        let inp;
        if (f.textarea) {
            inp = document.createElement('textarea');
            inp.className = 'admin-textarea';
            inp.rows = 2;
        } else {
            inp = document.createElement('input');
            inp.className = 'admin-input';
            inp.type      = 'text';
        }
        inp.placeholder = f.placeholder || '';
        inp.value       = f.value || '';
        inp.dataset.key = f.key;
        grp.appendChild(lbl);
        grp.appendChild(inp);
        row.appendChild(grp);
        card.appendChild(row);
    });
    return card;
}

function renderProd() {
    const list = document.getElementById('prodList');
    list.innerHTML = '';
    (content.producciones || []).forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'item-card';
        const photoUrl = p.photoUrl || '';
        card.innerHTML = `
            <div class="item-card-header">
                <span class="item-num">Producción ${i+1}</span>
                <button class="del-btn" type="button"><i class="bx bx-trash"></i></button>
            </div>
            <div class="prod-admin-photo-wrap">
                <img class="prod-admin-photo-preview" src="${esc(photoUrl)}" alt="Foto" ${photoUrl ? 'style="display:block"' : ''}>
                <div class="prod-admin-photo-zone" ${photoUrl ? 'style="display:none"' : ''}>
                    <i class="bx bx-image-add"></i><span>Foto de portada — clic para subir</span>
                </div>
                <input type="file" class="prod-admin-photo-input" accept=".jpg,.jpeg,.png,.webp,.gif">
                <input type="hidden" data-key="photoUrl" value="${esc(photoUrl)}">
            </div>
            <div class="field-row">
                <div class="field-group">
                    <label class="field-label">Año</label>
                    <input class="admin-input" data-key="year" type="text" value="${esc(p.year||'')}" placeholder="2024">
                </div>
            </div>
            <div class="field-row full">
                <div class="field-group">
                    <label class="field-label">Título</label>
                    <input class="admin-input" data-key="title" type="text" value="${esc(p.title||'')}" placeholder="Nombre de la obra">
                </div>
            </div>
            <div class="field-row full">
                <div class="field-group">
                    <label class="field-label">Video (YouTube / Vimeo URL)</label>
                    <input class="admin-input" data-key="videoUrl" type="text" value="${esc(p.videoUrl||'')}" placeholder="https://youtube.com/watch?v=...">
                </div>
            </div>
            <div class="field-row full">
                <div class="field-group">
                    <label class="field-label">Descripción</label>
                    <textarea class="admin-textarea" data-key="description" rows="2" placeholder="Descripción de la producción...">${esc(p.description||'')}</textarea>
                </div>
            </div>`;

        const preview  = card.querySelector('.prod-admin-photo-preview');
        const zone     = card.querySelector('.prod-admin-photo-zone');
        const fileInput = card.querySelector('.prod-admin-photo-input');
        const photoHidden = card.querySelector('[data-key="photoUrl"]');

        const triggerUpload = () => fileInput.click();
        zone.addEventListener('click', triggerUpload);
        preview.addEventListener('click', triggerUpload);

        fileInput.addEventListener('change', async function () {
            const file = this.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('photo', file);
            try {
                const r = await fetch('/api/upload-prod-photo', { method: 'POST', body: fd });
                const d = await r.json();
                if (d.ok) {
                    preview.src = d.url;
                    preview.style.display = 'block';
                    zone.style.display = 'none';
                    photoHidden.value = d.url;
                }
            } catch (e) { console.error('[prod photo upload]', e); }
        });

        card.querySelector('.del-btn').addEventListener('click', () => {
            content.producciones.splice(i, 1);
            renderProd();
        });

        list.appendChild(card);
    });
}
document.getElementById('addProd').onclick = () => {
    content.producciones = content.producciones || [];
    content.producciones.push({ year:'', title:'', description:'', videoUrl:'', photoUrl:'' });
    renderProd();
};
function collectProd() {
    return Array.from(document.getElementById('prodList').querySelectorAll('.item-card')).map(card => {
        const obj = {};
        card.querySelectorAll('[data-key]').forEach(el => { obj[el.dataset.key] = el.value; });
        return obj;
    });
}


const _nosAnios = (() => {
    const now = new Date();
    let y = now.getFullYear() - 2023;
    if (now < new Date(now.getFullYear(), 2, 4)) y--;
    return y;
})();

const NOS_DEFAULTS = {
    historia: {
        texto1:    `EXPRESART nació con el propósito de abrir un espacio donde la expresión artística y el teatro sean accesibles para todos. Fundada por artistas y docentes apasionados por las artes escénicas, nuestra escuela se ha convertido en un semillero de talentos que transforman el escenario en un lugar de vida, emoción y comunicación, con ${_nosAnios} años funcionando y formando artistas en la ciudad de Quito, Ecuador.`,
        texto2:    'Desde nuestros inicios hemos formado actores, artistas y comunicadores capaces de conectar con el público desde la autenticidad y la técnica.',
        cita:      'El teatro es el arte de hacer vivir lo que no existe, y existir lo que no se ve.',
        citaAutor: 'EXPRESART'
    },
    mision: {
        misionTexto: 'Formar artistas escénicos con bases técnicas sólidas, sensibilidad creativa y vocación de comunicar, brindando una educación teatral de calidad en un ambiente de respeto, pasión y disciplina.',
        visionTexto: 'Ser la escuela de actuación de referencia de la región, reconocida por la excelencia de sus egresados y por su compromiso con el arte escénico como herramienta de transformación personal y social.',
        cita:        'Formamos artistas que no solo actúan — transforman el mundo desde el escenario.',
        citaAutor:   'Dirección EXPRESART'
    },
    valores: [
        { icono: '🔥', nombre: 'Pasión',     descripcion: 'Enseñamos desde el amor genuino por el arte escénico.' },
        { icono: '🎯', nombre: 'Disciplina', descripcion: 'El talento se potencia con trabajo constante y dedicación.' },
        { icono: '🤝', nombre: 'Comunidad',  descripcion: 'El teatro es colectivo — juntos crecemos — juntos brillamos.' }
    ],
    niveles: [
        { titulo: 'Actuación Básica',             descripcion: 'Introducción a las técnicas fundamentales de la actuación: expresión corporal, voz, respiración y presencia escénica.',           etiqueta: 'Nivel 1 — Principiantes', duracion: '' },
        { titulo: 'Actuación Intermedia',         descripcion: 'Desarrollo de habilidades expresivas, construcción de personaje, improvisación y trabajo en escenas cortas con otros actores.',  etiqueta: 'Nivel 2 — Intermedio',    duracion: '' },
        { titulo: 'Actuación Avanzada',           descripcion: 'Profundización en métodos de interpretación, trabajo con texto dramático y producción de obra completa ante el público.',        etiqueta: 'Nivel 3 — Avanzado',      duracion: '' },
        { titulo: 'Taller de Puesta en Escena',  descripcion: 'Producción de una obra completa: desde la lectura del guion hasta la presentación ante el público.',                              etiqueta: 'Todos los niveles',       duracion: '' }
    ]
};

let nosValores = [];
let nosNiveles = [];

function renderNosotros() {
    const nos = content.nosotros || {};
    const h   = nos.historia || NOS_DEFAULTS.historia;
    const m   = nos.mision   || NOS_DEFAULTS.mision;
    nosValores = (nos.valores && nos.valores.length) ? nos.valores.map(v => ({...v})) : NOS_DEFAULTS.valores.map(v => ({...v}));
    nosNiveles = (nos.niveles && nos.niveles.length) ? nos.niveles.map(n => ({...n})) : NOS_DEFAULTS.niveles.map(n => ({...n}));

    document.getElementById('nos_h_texto1').value    = h.texto1    || '';
    document.getElementById('nos_h_texto2').value    = h.texto2    || '';
    document.getElementById('nos_h_cita').value      = h.cita      || '';
    document.getElementById('nos_h_citaAutor').value = h.citaAutor || '';
    document.getElementById('nos_m_mision').value    = m.misionTexto || '';
    document.getElementById('nos_m_vision').value    = m.visionTexto || '';
    document.getElementById('nos_m_cita').value      = m.cita      || '';
    document.getElementById('nos_m_citaAutor').value = m.citaAutor || '';

    renderNosValores();
    renderNosNiveles();
}

function renderNosValores() {
    const wrap = document.getElementById('nosValoresList');
    wrap.innerHTML = '';
    nosValores.forEach((v, i) => {
        const card = makeItemCard(`Valor ${i+1}`, [
            { label:'Ícono (emoji)', key:'icono',      value: v.icono,      placeholder:'🔥' },
            { label:'Nombre',        key:'nombre',      value: v.nombre,     placeholder:'Pasión' },
            { label:'Descripción',   key:'descripcion', value: v.descripcion,placeholder:'...', textarea:true, full:true }
        ], () => { nosValores.splice(i, 1); renderNosValores(); });
        wrap.appendChild(card);
    });
}

function renderNosNiveles() {
    const list = document.getElementById('nosNivelesList');
    list.innerHTML = '';
    nosNiveles.forEach((n, i) => {
        const card = makeItemCard(`Nivel ${i+1}`, [
            { label:'Título',      key:'titulo',      value: n.titulo,      placeholder:'Nivel Básico' },
            { label:'Etiqueta',    key:'etiqueta',    value: n.etiqueta,    placeholder:'Nivel 1 — Principiantes' },
            { label:'Duración',    key:'duracion',    value: n.duracion,    placeholder:'6 meses' },
            { label:'Descripción', key:'descripcion', value: n.descripcion, placeholder:'Descripción...', textarea:true, full:true }
        ], () => { nosNiveles.splice(i, 1); renderNosNiveles(); });
        list.appendChild(card);
    });
}

document.getElementById('addNosValor').onclick = () => {
    nosValores.push({ icono:'', nombre:'', descripcion:'' });
    renderNosValores();
};

document.getElementById('addNosNivel').onclick = () => {
    nosNiveles.push({ titulo:'', descripcion:'', etiqueta:'', duracion:'' });
    renderNosNiveles();
};

function collectNosotros() {
    const h = {
        texto1:    document.getElementById('nos_h_texto1').value,
        texto2:    document.getElementById('nos_h_texto2').value,
        cita:      document.getElementById('nos_h_cita').value,
        citaAutor: document.getElementById('nos_h_citaAutor').value
    };
    const m = {
        misionTexto: document.getElementById('nos_m_mision').value,
        visionTexto: document.getElementById('nos_m_vision').value,
        cita:        document.getElementById('nos_m_cita').value,
        citaAutor:   document.getElementById('nos_m_citaAutor').value
    };
    const valores = Array.from(document.getElementById('nosValoresList').querySelectorAll('.item-card')).map(card => {
        const obj = {};
        card.querySelectorAll('[data-key]').forEach(el => obj[el.dataset.key] = el.value);
        return obj;
    });
    const niveles = Array.from(document.getElementById('nosNivelesList').querySelectorAll('.item-card')).map(card => {
        const obj = {};
        card.querySelectorAll('[data-key]').forEach(el => obj[el.dataset.key] = el.value);
        return obj;
    });
    return { historia: h, mision: m, valores, niveles };
}

async function saveSection(section, data) {
    const r = await fetch('/api/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, data })
    });
    const d = await r.json();
    if (d.ok) showToast('✓ Guardado correctamente');
    else      showToast(d.message || 'Error al guardar', true);
}

document.querySelectorAll('.save-btn[data-section]').forEach(btn => {
    btn.onclick = async () => {
        btnLoad(btn);
        const section = btn.dataset.section;
        let data;
        if (section === 'destacada') {
            data = {
                title:       document.getElementById('dest_title').value,
                author:      document.getElementById('dest_author').value,
                year:        document.getElementById('dest_year').value,
                description: document.getElementById('dest_desc').value,
                photo:       (content.destacada || {}).photo || ''
            };
        } else if (section === 'producciones') {
            data = collectProd();
        } else if (section === 'nosotros') {
            data = collectNosotros();
        }
        try {
            await saveSection(section, data);
            await loadContent();
        } finally {
            btnDone(btn);
        }
    };
});

document.getElementById('photoZone').onclick  = () => document.getElementById('photoInput').click();
document.getElementById('photoInput').onchange = async () => {
    const file = document.getElementById('photoInput').files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('photo', file);
    showToast('Subiendo imagen…');
    const r = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', body: formData });
    const d = await r.json();
    if (d.ok) {
        content.destacada       = content.destacada || {};
        content.destacada.photo = d.url;
        document.getElementById('photoPreview').src           = d.url;
        document.getElementById('photoPreview').style.display = 'block';
        document.getElementById('photoZone').style.display    = 'none';
        showToast('✓ Foto subida correctamente');
    } else {
        showToast(d.message || 'Error al subir la foto', true);
    }
};

loadContent();

/* ══════════════════════
   TAB AGENDA
   ══════════════════════ */
const EVT_CATS = {
    obra:     { label: 'Obra',     color: '#c0282a' },
    taller:   { label: 'Taller',   color: '#c9a227' },
    audicion: { label: 'Audición', color: '#2a8ab4' },
    otro:     { label: 'Evento',   color: '#888888' }
};
const MONTHS_ES_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

let editingEvtId = null;
let adminEvts    = [];

async function loadEvents() {
    const r   = await fetch('/api/events', { credentials: 'same-origin' });
    adminEvts = await r.json();
    renderEvents();
}

function renderEvents() {
    const wrap = document.getElementById('eventsListWrap');
    const q    = eventsSearch.trim().toLowerCase();
    const sorted = adminEvts.slice().sort((a, b) => b.date.localeCompare(a.date));
    const filtered = q
        ? sorted.filter(ev =>
            (ev.title    || '').toLowerCase().includes(q) ||
            (ev.location || '').toLowerCase().includes(q) ||
            (ev.category || '').toLowerCase().includes(q))
        : sorted;

    if (!filtered.length) {
        wrap.innerHTML = q
            ? '<p class="no-users">Sin resultados para esa búsqueda.</p>'
            : '<p class="no-users">No hay eventos creados todavía.</p>';
        return;
    }

    const page  = Math.min(eventsPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    eventsPage  = page;
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    wrap.innerHTML = `
        <div class="tbl-scroll"><table class="user-table">
            <thead>
                <tr>
                    <th>Fecha</th>
                    <th>Título</th>
                    <th>Categoría</th>
                    <th>Visibilidad</th>
                    <th>Lugar</th>
                    <th>Acciones</th>
                </tr>
            </thead>
            <tbody>
                ${slice.map(ev => {
                    const cat = EVT_CATS[ev.category] || EVT_CATS.otro;
                    const [y,m,d] = (ev.date||'').split('-');
                    const dateLabel = d ? parseInt(d)+' '+MONTHS_ES_SHORT[parseInt(m)-1]+' '+y : ev.date;
                    return `
                    <tr>
                        <td>${dateLabel}${ev.time ? ' '+ev.time : ''}</td>
                        <td>${esc(ev.title)}</td>
                        <td><span style="color:${cat.color};font-size:0.80em;letter-spacing:1px;text-transform:uppercase">${cat.label}</span></td>
                        <td style="font-size:0.80em">${ev.audience === 'alumnos' ? '🔒 Solo alumnos' : '🌐 Público'}</td>
                        <td style="font-size:0.78em;color:rgba(255,200,200,0.55)">${esc(ev.location)}</td>
                        <td style="display:flex;gap:6px;flex-wrap:wrap">
                            <button class="tbl-btn tbl-btn-view" data-action="edit-event" data-event-id="${esc(ev.id)}">
                                <i class="bx bx-edit"></i> Editar
                            </button>
                            <button class="tbl-btn tbl-btn-delete" data-action="delete-event" data-id="${esc(ev.id)}" data-title="${esc(ev.title)}">
                                <i class="bx bx-trash"></i> Eliminar
                            </button>
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table></div>
        ${buildPager(filtered.length, page, 'page-events')}`;
}

function editEvent(ev) {
    editingEvtId = ev.id;
    document.getElementById('evtEditId').value    = ev.id;
    document.getElementById('evtTitle').value     = ev.title    || '';
    document.getElementById('evtCat').value       = ev.category || 'otro';
    document.getElementById('evtDate').value      = ev.date     || '';
    document.getElementById('evtTime').value      = ev.time     || '';
    document.getElementById('evtLocation').value  = ev.location || '';
    document.getElementById('evtDesc').value      = ev.description || '';
    document.getElementById('evtAudience').value  = ev.audience || 'publico';
    document.getElementById('evtFormTitle').textContent = 'Editar evento';
    document.getElementById('saveEvtLabel').textContent = 'Guardar cambios';
    document.getElementById('saveEvtBtn').querySelector('i').className = 'bx bx-save';
    document.getElementById('cancelEvtBtn').style.display = 'inline-flex';
    document.querySelector('[data-tab="agenda"]').click();
    expandSection('evtFormBody');
    document.getElementById('evtTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetEvtForm() {
    editingEvtId = null;
    document.getElementById('evtEditId').value    = '';
    document.getElementById('evtTitle').value     = '';
    document.getElementById('evtCat').value       = 'obra';
    document.getElementById('evtDate').value      = '';
    document.getElementById('evtTime').value      = '';
    document.getElementById('evtLocation').value  = '';
    document.getElementById('evtDesc').value      = '';
    document.getElementById('evtAudience').value  = 'publico';
    document.getElementById('evtFormTitle').textContent = 'Crear evento';
    document.getElementById('saveEvtLabel').textContent = 'Crear evento';
    document.getElementById('saveEvtBtn').querySelector('i').className = 'bx bx-plus';
    document.getElementById('cancelEvtBtn').style.display = 'none';
}

document.getElementById('cancelEvtBtn').onclick = resetEvtForm;

document.getElementById('saveEvtBtn').onclick = async () => {
    const title       = document.getElementById('evtTitle').value.trim();
    const date        = document.getElementById('evtDate').value;
    const time        = document.getElementById('evtTime').value;
    const location    = document.getElementById('evtLocation').value.trim();
    const category    = document.getElementById('evtCat').value;
    const description = document.getElementById('evtDesc').value.trim();
    const audience    = document.getElementById('evtAudience').value;

    if (!title || !date) return showToast('Título y fecha son requeridos', true);

    const btn  = document.getElementById('saveEvtBtn');
    btnLoad(btn);
    const body = { title, date, time, location, category, description, audience };
    try {
        let r;
        if (editingEvtId) {
            r = await fetch('/api/events/' + editingEvtId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } else {
            r = await fetch('/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }
        const d = await r.json();
        if (d.ok) {
            showToast(editingEvtId ? '✓ Evento actualizado' : '✓ Evento creado');
            resetEvtForm();
            loadEvents();
        } else {
            showToast(d.message || 'Error', true);
        }
    } finally {
        btnDone(btn);
    }
};

async function deleteEvent(id, title) {
    if (!confirm('¿Eliminar el evento "' + title + '"?')) return;
    const r = await fetch('/api/events/' + id, {
        method: 'DELETE',
        credentials: 'same-origin'
    });
    const d = await r.json();
    if (d.ok) { showToast('✓ Evento eliminado'); loadEvents(); }
    else       showToast(d.message || 'Error', true);
}

loadEvents();

/* ══════════════════════════════
   TAB PAGOS
   ══════════════════════════════ */
let bankServices  = [];
let allOrders     = [];
let currentFilter = 'todos';

async function loadBankInfo() {
    const r    = await fetch('/api/bank-info', { credentials: 'same-origin' });
    const info = await r.json();
    document.getElementById('bkBank').value    = info.bankName      || '';
    document.getElementById('bkType').value    = info.accountType   || 'Ahorros';
    document.getElementById('bkAccount').value = info.accountNumber || '';
    document.getElementById('bkHolder').value  = info.accountHolder || '';
    document.getElementById('bkRuc').value     = info.ruc           || '';
    document.getElementById('bkEmail').value   = info.email         || '';
    document.getElementById('bkAddress').value = info.address       || '';
    document.getElementById('bkPhone').value   = info.phone         || '';
    bankServices = info.services || [];
    renderServices();
}

function renderServices() {
    document.getElementById('servicesList').innerHTML = bankServices.map((s, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;background:rgba(255,255,255,.04);border-radius:8px;padding:6px 10px">
            <span style="flex:1;font-size:.85em;color:rgba(255,235,235,.85)">${esc(s.name)}</span>
            <span style="color:#c9a227;font-size:.85em;font-weight:600">$${parseFloat(s.price||0).toFixed(2)}</span>
            <button data-action="remove-service" data-idx="${i}" style="background:rgba(220,40,40,.2);border:none;color:#f88;border-radius:5px;padding:2px 7px;cursor:pointer">✕</button>
        </div>
    `).join('') || '<p style="font-size:.8em;color:rgba(255,200,200,.4);margin:0 0 8px">Sin servicios configurados.</p>';
}

document.getElementById('addServiceBtn').onclick = () => {
    const name  = document.getElementById('svcName').value.trim();
    const price = document.getElementById('svcPrice').value;
    if (!name) return;
    bankServices.push({ name, price: parseFloat(price) || 0 });
    renderServices();
    document.getElementById('svcName').value  = '';
    document.getElementById('svcPrice').value = '';
};

window.removeService = (i) => {
    bankServices.splice(i, 1);
    renderServices();
};

document.getElementById('saveBankBtn').onclick = async () => {
    const btn = document.getElementById('saveBankBtn');
    btnLoad(btn);
    const body = {
        bankName:      document.getElementById('bkBank').value.trim(),
        accountType:   document.getElementById('bkType').value,
        accountNumber: document.getElementById('bkAccount').value.trim(),
        accountHolder: document.getElementById('bkHolder').value.trim(),
        ruc:           document.getElementById('bkRuc').value.trim(),
        email:         document.getElementById('bkEmail').value.trim(),
        address:       document.getElementById('bkAddress').value.trim(),
        phone:         document.getElementById('bkPhone').value.trim(),
        services:      bankServices
    };
    try {
        const r = await fetch('/api/bank-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.ok) showToast('✓ Configuración guardada'); else showToast('Error al guardar', true);
    } finally {
        btnDone(btn);
    }
};

async function loadOrders() {
    const r = await fetch('/api/orders', { credentials: 'same-origin' });
    allOrders = await r.json();
    renderOrders();
    maybeStartSriPolling();
}

let _sriPoll = null;
function maybeStartSriPolling() {
    const pending = allOrders.filter(o => o.status === 'confirmado' && (!o.sri || o.sri.status === 'procesando'));
    if (pending.length && !_sriPoll) {
        _sriPoll = setInterval(async () => {
            const r2 = await fetch('/api/orders', { credentials: 'same-origin' });
            allOrders = await r2.json();
            renderOrders();
            const stillPending = allOrders.filter(o => o.status === 'confirmado' && (!o.sri || o.sri.status === 'procesando'));
            if (!stillPending.length) { clearInterval(_sriPoll); _sriPoll = null; }
        }, 3000);
    } else if (!pending.length && _sriPoll) {
        clearInterval(_sriPoll); _sriPoll = null;
    }
}

function renderOrders() {
    const wrap = document.getElementById('ordersWrap');
    let list   = (currentFilter === 'todos' ? allOrders : allOrders.filter(o => o.status === currentFilter))
                    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const q    = ordersSearch.trim().toLowerCase();
    if (q) list = list.filter(o =>
        (o.customerName  || '').toLowerCase().includes(q) ||
        (o.customerEmail || '').toLowerCase().includes(q) ||
        (o.concept       || '').toLowerCase().includes(q)
    );
    if (!list.length) {
        wrap.innerHTML = q
            ? '<p class="no-users">Sin resultados para esa búsqueda.</p>'
            : '<p class="no-users">Sin pagos en esta categoría.</p>';
        return;
    }

    const page    = Math.min(ordersPage, Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1));
    ordersPage    = page;
    const slice   = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    wrap.innerHTML = `<div class="tbl-scroll"><table class="user-table">
        <thead><tr>
            <th>Fecha</th><th>Cliente</th><th>Concepto</th>
            <th>Total</th><th>Estado</th><th>SRI</th><th>Acciones</th>
        </tr></thead>
        <tbody>${slice.map(o => {
            const fecha = new Date(o.createdAt).toLocaleDateString('es-EC');
            const badge = o.status === 'confirmado'
                ? '<span style="color:#5d5;font-size:.8em">✅ Confirmado</span>'
                : o.status === 'rechazado'
                ? '<span style="color:#f66;font-size:.8em">❌ Rechazado</span>'
                : '<span style="color:#c9a227;font-size:.8em">🟡 Pendiente</span>';
            let sriBadge = '<span style="color:rgba(255,200,200,.35);font-size:.78em">—</span>';
            if (o.status === 'confirmado') {
                if (o.sri && o.sri.status === 'autorizado') {
                    sriBadge = `<span style="color:#5d5;font-size:.78em" title="Clave: ${o.sri.claveAcceso || ''}">✅ Autorizado</span>`;
                } else if (o.sri && o.sri.status === 'error') {
                    sriBadge = `<span style="color:#f99;font-size:.76em" title="${o.sri.error || ''}">⚠ Error</span>
                        <button data-action="sri-retry" data-id="${o.id}" style="margin-left:4px;padding:2px 8px;font-size:.72em;background:rgba(201,162,39,.2);color:#c9a227;border:1px solid rgba(201,162,39,.4);border-radius:4px;cursor:pointer">↺ Reintentar</button>`;
                } else {
                    sriBadge = '<span style="color:#c9a227;font-size:.78em">⏳ Procesando</span>';
                }
            }
            const receiptPath = o.receiptUrl && o.receiptUrl.startsWith('/uploads/') ? o.receiptUrl : null;
            const receiptLink = receiptPath
                ? `<button data-action="open-protected-url" data-path="${receiptPath}" class="edit-btn" style="margin-right:4px;background:rgba(201,162,39,.12);border-color:rgba(201,162,39,.4);color:#c9a227;cursor:pointer">📎 Comprobante</button>`
                : (o.receiptUrl
                    ? `<a href="${o.receiptUrl}" target="_blank" rel="noopener" class="edit-btn" style="margin-right:4px;background:rgba(201,162,39,.12);border-color:rgba(201,162,39,.4);color:#c9a227">📎 Comprobante</a>`
                    : '');
            const actions = o.status === 'pendiente' ? `
                <button data-action="verify-order" data-id="${o.id}" class="save-btn" style="padding:4px 10px;font-size:.78em;margin-right:4px;background:rgba(201,162,39,.25);color:#c9a227;border:1px solid rgba(201,162,39,.5)">🔍 Verificar</button>
                ${receiptLink}
            ` : o.status === 'confirmado' ? `
                ${receiptLink}
                ${o.sri && o.sri.status === 'autorizado'
                    ? `<button data-action="open-protected-url" data-path="/factura/${o.id}" class="edit-btn" style="cursor:pointer;background:rgba(201,162,39,.12);border-color:rgba(201,162,39,.4);color:#c9a227">🧾 Factura SRI</button>`
                    : ''}
            ` : `
                <span style="font-size:.78em;color:rgba(255,200,200,.5)">${esc(o.rejectionReason || '—')}</span>
                ${receiptLink}
            `;
            return `<tr>
                <td style="font-size:.8em">${fecha}</td>
                <td><strong style="font-size:.88em">${esc(o.customerName)}</strong><br><small style="color:rgba(255,200,200,.5)">${esc(o.customerEmail)}</small></td>
                <td style="font-size:.82em;max-width:180px">${esc(o.concept)}</td>
                <td style="font-size:.88em;color:#c9a227;font-weight:600">$${parseFloat(o.amount).toFixed(2)}</td>
                <td>${badge}</td>
                <td style="min-width:110px">${sriBadge}</td>
                <td>${actions}</td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>
    ${buildPager(list.length, page, 'page-orders')}`;
}

window.confirmOrder = async (id) => {
    if (!confirm('¿Confirmar este pago y generar el comprobante?')) return;
    const r = await fetch(`/api/orders/${id}/confirm`, { method: 'PUT', credentials: 'same-origin' });
    const d = await r.json();
    if (d.ok) { showToast('✓ Pago confirmado — No. ' + d.invoiceNumber); await loadOrders(); maybeStartSriPolling(); }
    else showToast('Error: ' + d.message, true);
};

window.rejectOrder = async (id) => {
    const reason = prompt('Motivo del rechazo (opcional):') ?? '';
    const r = await fetch(`/api/orders/${id}/reject`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const d = await r.json();
    if (d.ok) { showToast('Pago rechazado'); loadOrders(); }
    else showToast('Error: ' + d.message, true);
};

window.sriRetry = async (id) => {
    showToast('Reintentando autorización SRI…');
    const r = await fetch(`/api/orders/${id}/sri-retry`, { method: 'POST', credentials: 'same-origin' });
    const d = await r.json();
    if (d.ok) showToast('✓ Factura autorizada por el SRI');
    else showToast('SRI error: ' + (d.error || d.message), true);
    loadOrders();
};

window.verifyOrder = async (id) => {
    const o = allOrders.find(x => x.id === id);
    if (!o) return;
    const rawReceiptUrl = o.receiptUrl || '';

    // Get signed URL for local uploads; Cloudinary URLs are self-served
    let authReceiptUrl = rawReceiptUrl;
    if (rawReceiptUrl.startsWith('/uploads/')) {
        try {
            const r = await fetch('/api/signed-url?path=' + encodeURIComponent(rawReceiptUrl), {
                credentials: 'same-origin'
            });
            const d = await r.json();
            if (d.ok) authReceiptUrl = d.url;
        } catch { /* use raw URL as fallback */ }
    }

    const isImg = rawReceiptUrl && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(rawReceiptUrl);
    const isPdf = rawReceiptUrl && /\.pdf(\?|$)/i.test(rawReceiptUrl);
    const preview = !rawReceiptUrl
        ? `<div class="vm-no-receipt">Sin comprobante adjunto</div>`
        : isImg
        ? `<img src="${authReceiptUrl}" alt="Comprobante" style="max-width:100%;border-radius:6px;display:block">`
        : isPdf
        ? `<iframe src="${authReceiptUrl}" style="width:100%;height:480px;border:none;border-radius:6px"></iframe>`
        : `<a href="${authReceiptUrl}" target="_blank" rel="noopener" class="edit-btn" style="display:inline-block;margin-top:8px">📎 Abrir archivo</a>`;

    document.getElementById('vmPreview').innerHTML  = preview;
    document.getElementById('vmName').textContent    = o.customerName;
    document.getElementById('vmDoc').textContent     = o.customerDoc;
    document.getElementById('vmEmail').textContent   = o.customerEmail;
    document.getElementById('vmConcept').textContent = o.concept;
    document.getElementById('vmNotes').textContent   = o.notes || '—';
    document.getElementById('vmAmount').textContent  = '$' + parseFloat(o.amount).toFixed(2);
    document.getElementById('vmSubtotal').textContent= '$' + parseFloat(o.subtotal || 0).toFixed(2);
    document.getElementById('vmIva').textContent     = '$' + parseFloat(o.iva || 0).toFixed(2);
    document.getElementById('vmDate').textContent    = new Date(o.createdAt).toLocaleString('es-EC');

    document.getElementById('vmConfirm').onclick = async () => {
        document.getElementById('verifyModal').style.display = 'none';
        await confirmOrder(id);
    };
    document.getElementById('vmReject').onclick = async () => {
        document.getElementById('verifyModal').style.display = 'none';
        await rejectOrder(id);
    };

    document.getElementById('verifyModal').style.display = 'flex';
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('vmClose').onclick = () => { document.getElementById('verifyModal').style.display = 'none'; };
    document.getElementById('verifyModal').addEventListener('click', e => {
        if (e.target === document.getElementById('verifyModal')) document.getElementById('verifyModal').style.display = 'none';
    });
});

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        ordersPage = 0;
        renderOrders();
    };
});

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'pagos')      { loadBankInfo(); loadOrders(); }
        if (btn.dataset.tab === 'respaldos')  { loadBackupList(); }
    });
});

/* ══════════════════════
   TAB RESPALDOS
   ══════════════════════ */
async function loadBackupList() {
    const wrap = document.getElementById('backupList');
    wrap.innerHTML = '<p class="no-users">Cargando…</p>';
    try {
        const r = await fetch('/api/backup', { credentials: 'same-origin' });
        const d = await r.json();
        if (d.storage) {
            document.getElementById('backupStatus').innerHTML =
                `<span style="color:rgba(255,200,200,.5);font-size:.80em">Almacenamiento: <b style="color:#c9a227">${d.storage}</b></span>`;
        }
        if (!d.ok || !d.backups.length) {
            wrap.innerHTML = '<p class="no-users">No hay respaldos todavía. Crea uno manualmente.</p>';
            return;
        }
        wrap.innerHTML = `<div class="tbl-scroll"><table class="user-table">
            <thead><tr><th>Fecha</th><th>Tamaño</th><th>Descargar</th></tr></thead>
            <tbody>${d.backups.map(b => `
                <tr>
                    <td style="font-size:.85em">${b.filename.replace('backup-','').replace('.json.gz','').replace('T',' ').replace(/(\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3')}</td>
                    <td style="font-size:.82em;color:rgba(255,200,200,.6)">${b.sizeKb} KB</td>
                    <td><a href="/api/backup/${encodeURIComponent(b.filename)}"
                            download="${b.filename}"
                            onclick="this.setAttribute('href', this.href)"
                            class="tbl-btn tbl-btn-view"
                            style="text-decoration:none"
                            data-backup-download="${b.filename}">
                        <i class="bx bx-download"></i> Descargar
                    </a></td>
                </tr>`).join('')}
            </tbody>
        </table></div>`;

        // Agregar header de autorización a los links de descarga vía fetch
        wrap.querySelectorAll('[data-backup-download]').forEach(a => {
            a.addEventListener('click', async e => {
                e.preventDefault();
                const filename = a.dataset.backupDownload;
                const res = await fetch('/api/backup/' + encodeURIComponent(filename), {
                    credentials: 'same-origin'
                });
                if (!res.ok) { showToast('Error al descargar', true); return; }
                const blob = await res.blob();
                const url  = URL.createObjectURL(blob);
                const tmp  = document.createElement('a');
                tmp.href = url; tmp.download = filename;
                tmp.click();
                URL.revokeObjectURL(url);
            });
        });
    } catch {
        wrap.innerHTML = '<p class="no-users">Error al cargar respaldos.</p>';
    }
}

document.getElementById('btnRunBackup').addEventListener('click', async () => {
    const btn    = document.getElementById('btnRunBackup');
    const status = document.getElementById('backupStatus');
    btn.disabled = true;
    status.innerHTML = '<span style="color:#c9a227">⏳ Generando respaldo…</span>';
    try {
        const r = await fetch('/api/backup', { method: 'POST', credentials: 'same-origin' });
        const d = await r.json();
        if (d.ok) {
            status.innerHTML = `<span style="color:#7ed97e">✓ Respaldo creado: ${d.filename} (${d.sizeKb} KB)</span>`;
            loadBackupList();
        } else {
            status.innerHTML = `<span style="color:#f66">Error: ${d.error || d.message}</span>`;
        }
    } catch {
        status.innerHTML = '<span style="color:#f66">Error de conexión</span>';
    }
    btn.disabled = false;
});

/* ── Búsqueda en tablas ── */
document.getElementById('usersSearch').addEventListener('input', function() {
    usersSearch = this.value;
    usersPage   = 0;
    renderUsers();
});
document.getElementById('usersSearch').addEventListener('focus', function() {
    this.style.borderColor = 'rgba(201,162,39,0.55)';
});
document.getElementById('usersSearch').addEventListener('blur', function() {
    this.style.borderColor = 'rgba(255,255,255,0.15)';
});

document.getElementById('eventsSearch').addEventListener('input', function() {
    eventsSearch = this.value;
    eventsPage   = 0;
    renderEvents();
});
document.getElementById('eventsSearch').addEventListener('focus', function() {
    this.style.borderColor = 'rgba(201,162,39,0.55)';
});
document.getElementById('eventsSearch').addEventListener('blur', function() {
    this.style.borderColor = 'rgba(255,255,255,0.15)';
});

document.getElementById('ordersSearch').addEventListener('input', function() {
    ordersSearch = this.value;
    ordersPage   = 0;
    renderOrders();
});
document.getElementById('ordersSearch').addEventListener('focus', function() {
    this.style.borderColor = 'rgba(201,162,39,0.55)';
});
document.getElementById('ordersSearch').addEventListener('blur', function() {
    this.style.borderColor = 'rgba(255,255,255,0.15)';
});

/* ── Event delegation for dynamic onclicks ── */
document.addEventListener('click', function(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'toggle-user') {
        toggleUser(el.dataset.uid, el.dataset.active === 'true');
    } else if (action === 'view-portfolio') {
        location.href = 'portafolio-alumno.html?id=' + el.dataset.uid;
    } else if (action === 'admin-reset-pw') {
        adminResetPassword(el.dataset.uid, el.dataset.username);
    } else if (action === 'delete-user') {
        deleteUser(el.dataset.uid, el.dataset.username);
    } else if (action === 'dismiss-reset') {
        dismissResetRequest(el.dataset.id);
    } else if (action === 'edit-event') {
        const ev = adminEvts.find(x => x.id === el.dataset.eventId);
        if (ev) editEvent(ev);
    } else if (action === 'delete-event') {
        deleteEvent(el.dataset.id, el.dataset.title);
    } else if (action === 'remove-service') {
        window.removeService(parseInt(el.dataset.idx));
    } else if (action === 'sri-retry') {
        window.sriRetry(el.dataset.id);
    } else if (action === 'verify-order') {
        window.verifyOrder(el.dataset.id);
    } else if (action === 'page-users') {
        usersPage = parseInt(el.dataset.page); renderUsers();
    } else if (action === 'page-events') {
        eventsPage = parseInt(el.dataset.page); renderEvents();
    } else if (action === 'page-orders') {
        ordersPage = parseInt(el.dataset.page); renderOrders();
    } else if (action === 'open-protected-url') {
        openProtectedUrl(el.dataset.path);
    }
});
