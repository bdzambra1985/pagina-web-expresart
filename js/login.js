function redirectByRole(role) {
    location.href = role === 'admin' ? 'admin.html' : 'mi-portafolio.html';
}

fetch('/api/auth')
    .then(r => r.json())
    .then(d => { if (d.ok) redirectByRole(d.role); })
    .catch(() => {});

async function sendResetRequest() {
    const btn  = document.getElementById('resetBtn');
    const err  = document.getElementById('resetError');
    const succ = document.getElementById('resetSuccess');
    const user = document.getElementById('resetUsername').value.trim();
    err.style.display  = 'none';
    succ.style.display = 'none';
    if (!user) { err.textContent = 'Ingresa tu nombre de usuario'; err.style.display = 'block'; return; }
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
        const res = await fetch('/api/users/reset-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user })
        });
        if (!res.ok) throw new Error();
        succ.textContent   = 'Solicitud enviada. El administrador te comunicará tu nueva clave.';
        succ.style.display = 'block';
        document.getElementById('resetUsername').value = '';
    } catch {
        err.textContent   = 'Error al enviar la solicitud. Intenta más tarde.';
        err.style.display = 'block';
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Solicitar reseteo';
    }
}

document.querySelector('.forgot-link').addEventListener('click', function() {
    document.getElementById('resetPanel').classList.toggle('visible');
});

document.getElementById('resetBtn').addEventListener('click', sendResetRequest);

document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    const err = document.getElementById('loginError');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    err.style.display = 'none';

    try {
        const res  = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value.trim(),
                password: document.getElementById('password').value
            })
        });
        const data = await res.json();
        if (data.ok) {
            localStorage.setItem('exp_role', data.role);
            if (data.mustChangePassword) {
                location.href = 'cambiar-password.html';
            } else {
                redirectByRole(data.role);
            }
        } else {
            throw new Error(data.message || 'Error de acceso');
        }
    } catch (ex) {
        err.textContent   = ex.message;
        err.style.display = 'block';
        btn.disabled      = false;
        btn.textContent   = 'Entrar al panel';
    }
};

document.getElementById('pwdToggle').addEventListener('click', function () {
    const inp  = document.getElementById('password');
    const icon = document.getElementById('pwdEyeIcon');
    const show = inp.type === 'password';
    inp.type       = show ? 'text' : 'password';
    icon.className = show ? 'bx bx-show' : 'bx bx-hide';
    this.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
});
