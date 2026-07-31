'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../db');
const totp   = require('../utils/totp');
const { verifyPassword } = require('../utils/crypto');
const { requireAuth, logSecurity, revokeUserSessions } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');

/* ══════════════════════════════════════════════════════════════
   Segundo factor (TOTP) — opcional y por usuario.

   Mientras nadie lo active, el login funciona exactamente igual que
   antes. Está pensado sobre todo para la cuenta de administrador,
   que puede gestionar usuarios, pagos y respaldos con solo una
   contraseña.
   ══════════════════════════════════════════════════════════════ */

/* Estado intermedio entre "contraseña correcta" y "código correcto".
   Vive en memoria a propósito: dura 5 minutos y perderlo en un
   reinicio solo obliga a volver a introducir la contraseña. */
const pending = new Map();          // challenge → { userId, exp, tries }
const PENDING_TTL   = 5 * 60 * 1000;
const PENDING_TRIES = 5;

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (now >= v.exp) pending.delete(k);
}, 60 * 1000).unref();

function createChallenge(userId) {
    const challenge = crypto.randomBytes(32).toString('hex');
    pending.set(challenge, { userId, exp: Date.now() + PENDING_TTL, tries: 0 });
    return challenge;
}

function takeChallenge(challenge) {
    if (typeof challenge !== 'string') return null;
    const entry = pending.get(challenge);
    if (!entry) return null;
    if (Date.now() >= entry.exp) { pending.delete(challenge); return null; }
    return entry;
}

function consumeChallenge(challenge) { pending.delete(challenge); }

/* ── Estado del 2FA del usuario en sesión ── */
router.get('/2fa/status', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        res.json({
            ok: true,
            enabled: !!user.totpEnabled,
            recoveryRemaining: (user.totpRecovery || []).length
        });
    } catch (e) {
        console.error('[/api/2fa/status]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Paso 1: generar secreto y QR (todavía sin activar) ── */
router.post('/2fa/setup', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.totpEnabled)
            return res.status(409).json({ ok: false, message: 'El segundo factor ya está activo. Desactívalo antes de volver a configurarlo.' });

        const secret = totp.generateSecret();
        // Se guarda como pendiente: no protege nada hasta que se confirma
        // con un código válido, así que no se puede quedar el usuario fuera.
        await db.updateUser(user.userId, { totpSecret: secret, totpEnabled: false });

        const uri = totp.otpauthUri(secret, user.username);
        const qrSvg = await require('qrcode').toString(uri, {
            type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M'
        });

        res.json({ ok: true, secret, uri, qrSvg });
    } catch (e) {
        console.error('[/api/2fa/setup]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Paso 2: confirmar con un código y activar ── */
router.post('/2fa/enable', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.totpEnabled)
            return res.status(409).json({ ok: false, message: 'El segundo factor ya está activo' });
        if (!user.totpSecret)
            return res.status(400).json({ ok: false, message: 'Primero genera un código QR' });

        if (!totp.verifyCode(user.totpSecret, req.body?.code)) {
            logSecurity('TOTP_ENABLE_FAIL', `userId=${user.userId} ip=${req.ip}`, { userId: user.userId, ip: req.ip });
            return res.status(400).json({ ok: false, message: 'Código incorrecto. Revisa la hora de tu teléfono e inténtalo otra vez.' });
        }

        const recoveryCodes = totp.generateRecoveryCodes(10);
        await db.updateUser(user.userId, {
            totpEnabled:  true,
            totpRecovery: recoveryCodes.map(totp.hashRecoveryCode)
        });
        logSecurity('TOTP_ENABLED', `userId=${user.userId}`, { userId: user.userId, ip: req.ip });

        // Los códigos en claro se devuelven una única vez: solo se
        // almacena su hash, así que no hay forma de volver a mostrarlos.
        res.json({ ok: true, recoveryCodes });
    } catch (e) {
        console.error('[/api/2fa/enable]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Desactivar — exige contraseña Y código vigente ── */
router.post('/2fa/disable', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (!user.totpEnabled)
            return res.status(400).json({ ok: false, message: 'El segundo factor no está activo' });

        // Pedir ambos evita que alguien que encuentre la sesión abierta en
        // un equipo desatendido pueda quitar el segundo factor.
        const { password, code } = req.body || {};
        if (!await verifyPassword(password, user.passwordHash))
            return res.status(401).json({ ok: false, message: 'Contraseña incorrecta' });
        if (!totp.verifyCode(user.totpSecret, code))
            return res.status(400).json({ ok: false, message: 'Código incorrecto' });

        await db.updateUser(user.userId, { totpEnabled: false, totpSecret: null, totpRecovery: [] });
        logSecurity('TOTP_DISABLED', `userId=${user.userId} ip=${req.ip}`, { userId: user.userId, ip: req.ip });
        res.json({ ok: true });
    } catch (e) {
        console.error('[/api/2fa/disable]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

module.exports = {
    router,
    createChallenge, takeChallenge, consumeChallenge,
    PENDING_TRIES
};
