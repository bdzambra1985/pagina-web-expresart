'use strict';
const router  = require('express').Router();
const db      = require('../db');
const {
    hashPassword, verifyPassword, needsRehash, validatePassword,
    signViewPath, verifyViewPath
} = require('../utils/crypto');
const {
    createSession, getSession, revokeSession,
    requireAuth, loginAttempts, setLoginAttempt, clearLoginAttempt,
    LOGIN_MAX_TRIES, LOGIN_LOCK_MS, logSecurity
} = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { issueToken }   = require('../middleware/csrf');
const { readRecent }   = require('../utils/securityLog');
const totp             = require('../utils/totp');
const {
    createChallenge, takeChallenge, consumeChallenge, PENDING_TRIES
} = require('./twofactor');
const {
    SESSION_COOKIE, ROLE_COOKIE, cookieOpts, readSession, clearAuthCookies
} = require('../utils/cookies');

/* Emite la sesión y las cookies. Se llama al terminar el login, con o
   sin segundo factor de por medio. */
function finishLogin(res, user, ip) {
    // El acceso de administrador se registra como evento propio: es el
    // que dispara alerta por correo.
    logSecurity(user.role === 'admin' ? 'ADMIN_LOGIN' : 'LOGIN_OK',
                `usuario=${user.username} ip=${ip} rol=${user.role}`,
                { userId: user.userId, ip, role: user.role });

    const token = createSession({ userId: user.userId, role: user.role });
    res.cookie(SESSION_COOKIE(), token, cookieOpts());
    res.cookie(ROLE_COOKIE(), user.role, cookieOpts());
    issueToken(res);
    res.json({ ok: true, role: user.role, mustChangePassword: !!user.mustChangePassword });
}

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
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            att.count++;
            att.ts = Date.now();   // permite al GC limpiar entradas sin bloqueo
            if (att.count >= LOGIN_MAX_TRIES) {
                att.lockedUntil = Date.now() + LOGIN_LOCK_MS;
                att.count       = 0;
                logSecurity('LOGIN_LOCKOUT', `usuario=${uname} ip=${ip}`);
            } else {
                logSecurity('LOGIN_FAIL', `usuario=${uname} ip=${ip} intento=${att.count}`);
            }
            setLoginAttempt(lockKey, att);
            return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
        }

        if (!user.active) {
            logSecurity('LOGIN_INACTIVE', `usuario=${uname} ip=${ip}`);
            return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });
        }

        clearLoginAttempt(lockKey);

        // Migración transparente: si el hash usa un esquema antiguo, se
        // re-hashea ahora que tenemos la contraseña en claro. Va antes del
        // segundo factor para que también alcance a quien lo tenga activo.
        if (needsRehash(user.passwordHash)) {
            try {
                await db.updateUser(user.userId, { passwordHash: await hashPassword(password) });
                logSecurity('PASSWORD_REHASHED', `userId=${user.userId}`);
            } catch (e) {
                console.error('[login rehash]', e.message);
            }
        }

        // Si el usuario tiene segundo factor, la contraseña sola no abre
        // sesión: se devuelve un desafío de corta vida y se exige el código.
        if (user.totpEnabled && user.totpSecret) {
            logSecurity('LOGIN_2FA_PENDING', `usuario=${uname} ip=${ip}`, { userId: user.userId, ip });
            return res.json({ ok: false, need2fa: true, challenge: createChallenge(user.userId) });
        }

        finishLogin(res, user, ip);
    } catch (e) {
        console.error('[/api/login]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Login, paso 2: código del segundo factor ── */
router.post('/login/2fa', loginLimiter, async (req, res) => {
    try {
        const { challenge, code } = req.body || {};
        const entry = takeChallenge(challenge);
        const ip    = req.ip || 'unknown';

        if (!entry)
            return res.status(401).json({ ok: false, message: 'La sesión de verificación caducó. Vuelve a iniciar sesión.' });

        // Límite de intentos por desafío: si no, el desafío se convierte en
        // una ventana de 5 minutos para probar el millón de códigos posibles.
        if (++entry.tries > PENDING_TRIES) {
            consumeChallenge(challenge);
            logSecurity('LOGIN_2FA_LOCKOUT', `userId=${entry.userId} ip=${ip}`, { userId: entry.userId, ip });
            return res.status(429).json({ ok: false, message: 'Demasiados códigos incorrectos. Vuelve a iniciar sesión.' });
        }

        const user = await db.getUserById(entry.userId);
        if (!user || !user.totpEnabled) {
            consumeChallenge(challenge);
            return res.status(401).json({ ok: false, message: 'No autorizado' });
        }

        let usedRecovery = false;
        if (!totp.verifyCode(user.totpSecret, code)) {
            // ¿Es un código de recuperación? Son de un solo uso.
            const hash  = totp.hashRecoveryCode(code || '');
            const codes = user.totpRecovery || [];
            const idx   = codes.indexOf(hash);
            if (idx === -1) {
                logSecurity('LOGIN_2FA_FAIL', `userId=${user.userId} ip=${ip} intento=${entry.tries}`,
                            { userId: user.userId, ip });
                return res.status(401).json({ ok: false, message: 'Código incorrecto' });
            }
            const remaining = codes.filter((_, i) => i !== idx);
            await db.updateUser(user.userId, { totpRecovery: remaining });
            usedRecovery = true;
            logSecurity('LOGIN_2FA_RECOVERY', `userId=${user.userId} ip=${ip} restantes=${remaining.length}`,
                        { userId: user.userId, ip });
        }

        consumeChallenge(challenge);
        if (usedRecovery) res.set('X-Recovery-Code-Used', '1');
        finishLogin(res, user, ip);
    } catch (e) {
        console.error('[/api/login/2fa]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Logout ── */
router.post('/logout', (req, res) => {
    const cookieToken = readSession(req);
    if (cookieToken) revokeSession(cookieToken);
    clearAuthCookies(res);
    res.json({ ok: true });
});

/* ── Change password ── */
router.post('/change-password', async (req, res) => {
    try {
        const sess = getSession(req);
        if (!sess) return res.status(401).json({ ok: false, message: 'No autenticado' });

        const { newPassword, consentAccepted } = req.body;
        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ ok: false, message: pwError });
        if (consentAccepted !== true)
            return res.status(400).json({ ok: false, message: 'Debes aceptar la Política de Privacidad para continuar' });

        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });

        const { revokeUserSessions } = require('../middleware/auth');
        await db.updateUser(sess.userId, {
            passwordHash: await hashPassword(newPassword),
            mustChangePassword: false,
            consentAcceptedAt: user.consentAcceptedAt || new Date().toISOString()
        });
        revokeUserSessions(sess.userId);

        logSecurity(user.role === 'admin' ? 'ADMIN_PW_CHANGED' : 'PASSWORD_CHANGED',
                    `userId=${sess.userId}`, { userId: sess.userId });
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
        // Reemite el token CSRF: las páginas cargadas con una sesión ya
        // existente (sin pasar por /login) también necesitan uno.
        issueToken(res);
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

/* ── Log de seguridad (solo admin) ── */
router.get('/security-log', (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, message: 'Solo administradores' });

        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
        res.json({ ok: true, entries: readRecent(limit) });
    } catch (e) {
        console.error('[/api/security-log]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Emitir token CSRF ──
   Lo usa el wrapper de fetch del frontend cuando va a hacer una mutación
   y todavía no tiene la cookie (p. ej. primera acción tras cargar la página).
*/
router.get('/csrf', (_req, res) => {
    issueToken(res);
    res.json({ ok: true });
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

        // Descargar un respaldo es sacar la base de datos entera del servidor:
        // queda registrado y alerta por correo.
        logSecurity('BACKUP_DOWNLOADED', `archivo=${req.params.filename} userId=${sess.userId}`,
                    { userId: sess.userId, ip: req.ip, file: req.params.filename });

        const safeName = encodeURIComponent(req.params.filename);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
        res.setHeader('Content-Type', 'application/gzip');
        stream.pipe(res);
    } catch (e) {
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});


module.exports = router;
