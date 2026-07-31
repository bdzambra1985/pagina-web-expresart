'use strict';
const crypto = require('crypto');
const { CSRF_COOKIE, cookieOpts, readCsrf } = require('../utils/cookies');

/* ══════════════════════════════════════════════════════════════
   CSRF — double-submit cookie.

   El sitio ya usa SameSite=strict, que por sí solo detiene el CSRF
   clásico en navegadores actuales. Esto es defensa en profundidad:
   si SameSite falla (navegador viejo, un futuro cambio a SameSite=lax
   para permitir enlaces entrantes, o un subdominio que pueda escribir
   cookies), el token sigue siendo necesario.

   Funcionamiento: la cookie `exp_csrf` NO es httpOnly, así que el JS
   propio la lee y la reenvía en la cabecera `X-CSRF-Token`. Un sitio
   atacante puede provocar que el navegador envíe la cookie, pero no
   puede leerla (same-origin policy), así que no puede fabricar la
   cabecera.
   ══════════════════════════════════════════════════════════════ */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* Rutas exentas: las llama un tercero, no el navegador del usuario, así
   que no hay sesión con la que hacer CSRF. Cada una tiene su propia
   autenticación (firma HMAC del webhook, credenciales de Payphone). */
const EXEMPT = [
    /^\/api\/webhooks\/resend-inbound$/,  // webhook de Resend — firma HMAC verificada
    /^\/api\/login$/,              // sin sesión previa que abusar; emite el token
    /^\/api\/login\/2fa$/,         // continuación del login, aún sin sesión
];

function issueToken(res) {
    const token = crypto.randomBytes(32).toString('hex');
    // httpOnly:false a propósito — el JS del sitio tiene que poder leerla.
    res.cookie(CSRF_COOKIE(), token, cookieOpts({ httpOnly: false }));
    return token;
}

function csrfProtection(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (EXEMPT.some(re => re.test(req.path))) return next();

    // Sin cookie de sesión no hay nada que falsificar en nombre del usuario.
    const { readSession } = require('../utils/cookies');
    if (!readSession(req)) return next();

    const cookieTok = readCsrf(req);
    const headerTok = req.get('X-CSRF-Token');

    if (!cookieTok || !headerTok || cookieTok.length !== headerTok.length) {
        return res.status(403).json({ ok: false, message: 'Token CSRF ausente o inválido' });
    }
    try {
        if (!crypto.timingSafeEqual(Buffer.from(cookieTok), Buffer.from(headerTok)))
            return res.status(403).json({ ok: false, message: 'Token CSRF ausente o inválido' });
    } catch {
        return res.status(403).json({ ok: false, message: 'Token CSRF ausente o inválido' });
    }
    next();
}

module.exports = { csrfProtection, issueToken };
