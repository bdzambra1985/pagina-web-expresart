const tok = localStorage.getItem('exp_token');
if (!tok) location.href = 'login.html';

document.getElementById('changeForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('changeBtn');
    const err = document.getElementById('changeError');
    const ok  = document.getElementById('changeSuccess');
    const np  = document.getElementById('newPassword').value;
    const cp  = document.getElementById('confirmPassword').value;

    err.style.display = 'none';
    ok.style.display  = 'none';

    if (np !== cp) {
        err.textContent   = 'Las contraseñas no coinciden';
        err.style.display = 'block';
        return;
    }
    if (np.length < 8) {
        err.textContent   = 'La contraseña debe tener al menos 8 caracteres';
        err.style.display = 'block';
        return;
    }

    btn.disabled    = true;
    btn.textContent = 'Guardando…';

    try {
        const res  = await fetch('/api/change-password', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': tok },
            body:    JSON.stringify({ newPassword: np })
        });
        const data = await res.json();
        if (data.ok) {
            ok.textContent   = '¡Contraseña actualizada! Redirigiendo…';
            ok.style.display = 'block';
            setTimeout(() => location.href = 'mi-portafolio.html', 1500);
        } else {
            throw new Error(data.message || 'Error al cambiar la contraseña');
        }
    } catch (ex) {
        err.textContent   = ex.message;
        err.style.display = 'block';
        btn.disabled      = false;
        btn.textContent   = 'Guardar y Continuar';
    }
};
