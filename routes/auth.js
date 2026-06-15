'use strict';
const router  = require('express').Router();
const db      = require('../db');
const { hashPassword, verifyPassword, signViewPath, verifyViewPath } = require('../utils/crypto');
const {
    createSession, getSession, revokeSession,
    requireAuth, loginAttempts,
    LOGIN_MAX_TRIES, LOGIN_LOCK_MS, logSecurity
} = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');

/* ── Login ── */
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });

        const uname  = username.trim().toLowerCase();
        const ip     = req.ip || 'unknown';
        const lockKey = `${ip}:${uname}`;                        // lockout per IP+username
        const att    = loginAttempts.get(lockKey) || { count: 0, lockedUntil: 0 };

        if (Date.now() < att.lockedUntil) {
            logSecurity('LOGIN_BLOCKED', `usuario=${uname} ip=${ip}`);
            return res.status(429).json({ ok: false, message: 'Cuenta bloqueada temporalmente. Intenta en 15 minutos.' });
        }

        const user = await db.getUserByUsername(username.trim());
        if (!user || !verifyPassword(password, user.passwordHash)) {
            att.count++;
            if (att.count >= LOGIN_MAX_TRIES) {
                att.lockedUntil = Date.now() + LOGIN_LOCK_MS;
                att.count       = 0;
                logSecurity('LOGIN_LOCKOUT', `usuario=${uname} ip=${ip}`);
            } else {
                logSecurity('LOGIN_FAIL', `usuario=${uname} ip=${ip} intento=${att.count}`);
            }
            loginAttempts.set(lockKey, att);
            return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
        }

        if (!user.active) {
            logSecurity('LOGIN_INACTIVE', `usuario=${uname} ip=${ip}`);
            return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });
        }

        loginAttempts.delete(lockKey);
        logSecurity('LOGIN_OK', `usuario=${uname} ip=${ip} rol=${user.role}`);

        const token    = createSession({ userId: user.userId, role: user.role });
        const isProd   = process.env.NODE_ENV === 'production';
        const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: isProd, path: '/' };
        res.cookie('exp_session', token, cookieOpts);
        res.cookie('exp_role', user.role, { sameSite: 'strict', secure: isProd, path: '/' });
        res.json({ ok: true, role: user.role, mustChangePassword: !!user.mustChangePassword });
    } catch (e) {
        console.error('[/api/login]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Logout ── */
router.post('/logout', (req, res) => {
    const cookieToken = req.cookies?.exp_session;
    if (cookieToken) revokeSession(cookieToken);
    const raw = req.headers['x-session-token'];
    if (raw) revokeSession(raw);
    res.clearCookie('exp_session', { path: '/' });
    res.clearCookie('exp_role',    { path: '/' });
    res.json({ ok: true });
});

/* ── Change password ── */
router.post('/change-password', async (req, res) => {
    try {
        const sess = getSession(req);
        if (!sess) return res.status(401).json({ ok: false, message: 'No autenticado' });

        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string')
            return res.status(400).json({ ok: false, message: 'Nueva contraseña requerida' });
        if (newPassword.length < 8)
            return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });

        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });

        const { revokeUserSessions } = require('../middleware/auth');
        await db.updateUser(sess.userId, { passwordHash: hashPassword(newPassword), mustChangePassword: false });
        revokeUserSessions(sess.userId);

        logSecurity('PASSWORD_CHANGED', `userId=${sess.userId}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[/api/change-password]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Session status ── */
router.get('/auth', async (req, res) => {
    try {
        const sess = getSession(req);
        if (!sess) return res.json({ ok: false });
        const profile = sess.role === 'alumno' ? (await db.getProfile(sess.userId) || {}) : {};
        res.json({
            ok: true, userId: sess.userId, role: sess.role,
            displayName: profile.displayName || '',
            photoUrl:    profile.photoUrl    || ''
        });
    } catch (e) {
        console.error('[/api/auth]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Signed view URL (replaces ?t=TOKEN in protected links) ──
   Admin requests a short-lived HMAC-signed URL for a protected resource.
   The signed token is valid for ~15–30 minutes and is resource-specific —
   a token for /factura/X cannot be used to access /uploads/Y.
*/
const SIGNED_URL_PATTERN = /^(\/factura\/ord_[a-z0-9_]+|\/uploads\/receipts\/.+)$/;

router.get('/signed-url', (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });

        const resourcePath = req.query.path;
        if (!resourcePath || typeof resourcePath !== 'string' || resourcePath.length > 300)
            return res.status(400).json({ ok: false, message: 'path inválido' });
        if (!SIGNED_URL_PATTERN.test(resourcePath))
            return res.status(403).json({ ok: false, message: 'Recurso no permitido' });

        const sv  = signViewPath(resourcePath);
        const sep = resourcePath.includes('?') ? '&' : '?';
        res.json({ ok: true, url: resourcePath + sep + 'sv=' + sv });
    } catch (e) {
        console.error('[/api/signed-url]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ══════════════════════════════════
   BACKUP — solo admin
   ══════════════════════════════════ */
const { runBackup, listBackups, getBackupStream, USE_R2, R2_BUCKET } = require('../utils/backup');

/* Listar backups disponibles */
router.get('/backup', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });
        const backups = await listBackups();
        res.json({ ok: true, backups, storage: USE_R2 ? `R2: ${R2_BUCKET}` : 'local' });
    } catch (e) {
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* Ejecutar backup manual ahora */
router.post('/backup', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });
        const result = await runBackup();
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* Descargar un backup por nombre */
router.get('/backup/:filename', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });

        const stream = await getBackupStream(req.params.filename);
        if (!stream) return res.status(404).json({ ok: false, message: 'Backup no encontrado' });

        const safeName = encodeURIComponent(req.params.filename);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
        res.setHeader('Content-Type', 'application/gzip');
        stream.pipe(res);
    } catch (e) {
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Test email (admin only, temporal) ── */
router.post('/test-email', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess || sess.role !== 'admin') return;
        const { getTransporter } = require('../utils/notify');
        const t = await getTransporter();
        await t.verify();
        await t.sendMail({
            from: `"EXPRESART" <${process.env.GMAIL_USER}>`,
            to:   process.env.NOTIFY_EMAIL,
            subject: '✅ Test email desde Railway',
            text: 'Si recibes esto, las notificaciones funcionan correctamente.'
        });
        res.json({ ok: true, from: process.env.GMAIL_USER, to: process.env.NOTIFY_EMAIL });
    } catch (e) {
        res.json({ ok: false, error: e.message, code: e.code });
    }
});

module.exports = router;
