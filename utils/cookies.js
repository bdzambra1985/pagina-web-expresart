'use strict';

/* ══════════════════════════════════════════════════════════════
   Nombres y opciones de cookies.

   En producción se usa el prefijo `__Host-`, que el navegador solo
   acepta si la cookie va con Secure, Path=/ y sin atributo Domain.
   Eso impide que un subdominio comprometido (o un MITM en HTTP)
   sobrescriba la cookie de sesión — el ataque de "cookie tossing".

   En desarrollo no hay HTTPS, y el navegador rechazaría una cookie
   `__Host-` sin Secure, así que ahí se usa el nombre sin prefijo.
   ══════════════════════════════════════════════════════════════ */

const isProd = () => process.env.NODE_ENV === 'production';

const SESSION_COOKIE = () => (isProd() ? '__Host-exp_session' : 'exp_session');
const ROLE_COOKIE    = () => (isProd() ? '__Host-exp_role'    : 'exp_role');
const CSRF_COOKIE    = () => (isProd() ? '__Host-exp_csrf'    : 'exp_csrf');

/* Opciones base. `__Host-` exige exactamente estas: Secure, Path=/, sin Domain. */
function cookieOpts(extra = {}) {
    return { httpOnly: true, sameSite: 'strict', secure: isProd(), path: '/', ...extra };
}

/* Lee la cookie de sesión aceptando ambos nombres.
   Necesario durante un despliegue: los navegadores que ya tenían sesión
   traen el nombre viejo hasta que caduca. */
function readSession(req) {
    const c = req.cookies;
    if (!c) return null;
    return c[SESSION_COOKIE()] || c.exp_session || c['__Host-exp_session'] || null;
}

function readCsrf(req) {
    const c = req.cookies;
    if (!c) return null;
    return c[CSRF_COOKIE()] || c.exp_csrf || c['__Host-exp_csrf'] || null;
}

/* Borra ambos nombres, para no dejar huérfana la cookie del esquema anterior. */
function clearAuthCookies(res) {
    for (const name of ['exp_session', 'exp_role', 'exp_csrf',
                        '__Host-exp_session', '__Host-exp_role', '__Host-exp_csrf']) {
        res.clearCookie(name, { path: '/' });
    }
}

module.exports = {
    SESSION_COOKIE, ROLE_COOKIE, CSRF_COOKIE,
    cookieOpts, readSession, readCsrf, clearAuthCookies
};
