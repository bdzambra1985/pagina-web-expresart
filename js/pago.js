initNavAuth();

(function() {
    const tok = localStorage.getItem('exp_token');
    if (!tok) return;
    fetch('/api/auth', { headers: { 'x-session-token': tok } })
        .then(r => r.json())
        .then(d => {
            if (!d.ok || d.role === 'admin') return;
            if (d.displayName) {
                const el = document.getElementById('heroTitlePago');
                if (el) el.textContent = d.displayName;
            }
            const bar = document.getElementById('alumnoBar');
            if (bar) bar.style.display = 'flex';
            const logoutBtn = document.getElementById('logoutBtn');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', async () => {
                    await fetch('/api/logout', { method: 'POST', headers: { 'x-session-token': tok } }).catch(() => {});
                    localStorage.removeItem('exp_token');
                    location.href = 'login.html';
                });
            }
        })
        .catch(() => {});
})();

let bankInfo = {};

async function loadBankInfo() {
    try {
        const r = await fetch('/api/bank-info');
        bankInfo = await r.json();
        renderBank(bankInfo);
        loadServices(bankInfo.services || []);
    } catch {
        document.getElementById('bankData').innerHTML = '<p class="no-bank">No se pudieron cargar los datos bancarios.</p>';
    }
}

function renderBank(info) {
    const container = document.getElementById('bankData');
    if (!info.bankName && !info.accountNumber) {
        container.innerHTML = '<p class="no-bank">Los datos bancarios aún no han sido configurados.<br>Contáctanos directamente.</p>';
        return;
    }
    const rows = [
        { label: 'Banco',          value: info.bankName      || '—' },
        { label: 'Tipo de cuenta', value: info.accountType   || '—' },
        { label: 'No. de cuenta',  value: info.accountNumber || '—', copy: true },
        { label: 'Titular',        value: info.accountHolder || '—' },
        { label: 'RUC / Cédula',   value: info.ruc           || '—' },
    ].filter(r => r.value !== '—');

    container.innerHTML = rows.map(r => `
        <div class="bank-row">
            <span class="bank-label">${r.label}</span>
            <span class="bank-value">
                ${r.value}
                ${r.copy ? `<button class="copy-btn" data-action="copy-text" data-val="${esc(r.value)}">Copiar</button>` : ''}
            </span>
        </div>
    `).join('');
}

function loadServices(services) {
    const sel = document.getElementById('fConcept');
    if (services.length) {
        services.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.name + (s.price ? ` — $${s.price}` : '');
            opt.textContent = s.name + (s.price ? ` — $${parseFloat(s.price).toFixed(2)}` : '');
            if (s.price) opt.dataset.price = s.price;
            sel.appendChild(opt);
        });
    }
    const other = document.createElement('option');
    other.value = 'Otro';
    other.textContent = 'Otro (especificar en notas)';
    sel.appendChild(other);
}

document.getElementById('fConcept').addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    if (opt && opt.dataset.price) {
        document.getElementById('fAmount').value = parseFloat(opt.dataset.price).toFixed(2);
        updateIVA();
    }
});

function updateIVA() {
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
document.getElementById('fAmount').addEventListener('input', updateIVA);

document.getElementById('fReceipt').addEventListener('change', function () {
    const zone = document.getElementById('uploadZone');
    const name = document.getElementById('uploadName');
    if (this.files[0]) {
        name.textContent = '✓ ' + this.files[0].name;
        zone.classList.add('has-file');
    } else {
        name.textContent = '';
        zone.classList.remove('has-file');
    }
});

function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {});
}

document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action="copy-text"]');
    if (btn) copyText(btn.dataset.val);
});

document.getElementById('submitBtn').addEventListener('click', async () => {
    const name    = document.getElementById('fName').value.trim();
    const doc     = document.getElementById('fDoc').value.trim();
    const email   = document.getElementById('fEmail').value.trim();
    const concept = document.getElementById('fConcept').value;
    const amount  = document.getElementById('fAmount').value;
    const notes        = document.getElementById('fNotes').value.trim();
    const paymentMonth = document.getElementById('fMonth').value;
    const receipt      = document.getElementById('fReceipt').files[0];

    if (!name || !doc || !email || !concept || !amount) {
        alert('Por favor completa todos los campos obligatorios.');
        return;
    }
    if (!receipt) {
        alert('Por favor adjunta el comprobante de transferencia.');
        return;
    }

    const btn = document.getElementById('submitBtn');
    btnLoad(btn);

    const fd = new FormData();
    fd.append('customerName',  name);
    fd.append('customerDoc',   doc);
    fd.append('customerEmail', email);
    fd.append('concept',       concept);
    fd.append('amount',        amount);
    fd.append('notes',         notes);
    fd.append('paymentMonth',  paymentMonth);
    fd.append('receipt',       receipt);

    const sessionTok = localStorage.getItem('exp_token');
    const headers = sessionTok ? { 'x-session-token': sessionTok } : {};

    try {
        const r    = await fetch('/api/orders', { method: 'POST', headers, body: fd });
        const data = await r.json();
        if (!data.ok) throw new Error(data.message);
        document.getElementById('successId').textContent = 'Ref: ' + data.orderId;
        document.getElementById('formPanel').style.display    = 'none';
        document.getElementById('successPanel').style.display = 'block';
    } catch (e) {
        alert('Error al enviar: ' + e.message);
        btnDone(btn);
    }
});

document.getElementById('fMonth').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 7);

loadBankInfo();
