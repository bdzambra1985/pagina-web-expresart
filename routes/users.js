'use strict';
const path   = require('path');
const fs     = require('fs');
const router = require('express').Router();
const db     = require('../db');
const { hashPassword }              = require('../utils/crypto');
const { randomAlphaNum }            = require('../utils/crypto');
const { requireAdmin }              = require('../middleware/auth');
const { revokeUserSessions }        = require('../middleware/auth');
const { USE_CLOUDINARY, UPLOADS_DIR, cloudinary } = require('../middleware/upload');
const { resetRequestLimiter }       = require('../middleware/rateLimiter');
const { emptyProfile }              = require('../utils/html');

/* ── List students (admin) ── */
router.get('/', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const users = await db.getUsers();
        res.json(users.map(u => ({
            userId: u.userId, username: u.username, displayName: u.displayName || '',
            role: u.role, active: u.active, createdAt: u.createdAt
        })));
    } catch (e) {
        console.error('[GET /api/users]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Create student (admin) ── */
router.post('/', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { username, password, displayName } = req.body;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
        if (username.trim().length < 3 || username.trim().length > 40)
            return res.status(400).json({ ok: false, message: 'Usuario debe tener entre 3 y 40 caracteres' });
        if (password.length < 10)
            return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 10 caracteres' });
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
            return res.status(400).json({ ok: false, message: 'La contraseña debe incluir letras y números' });
        if (await db.getUserByUsername(username.trim()))
            return res.status(409).json({ ok: false, message: 'Ese nombre de usuario ya existe' });

        const userId = 'alu_' + Date.now();
        await db.createUser({
            userId, username: username.trim(), passwordHash: hashPassword(password),
            role: 'alumno', active: true, mustChangePassword: true, createdAt: new Date().toISOString()
        });
        await db.upsertProfile(userId, { ...emptyProfile(userId), displayName: displayName || username.trim() });
        res.json({ ok: true, userId });
    } catch (e) {
        console.error('[POST /api/users]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Update student (activate / deactivate) ── */
router.put('/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede modificar el admin' });

        const fields = {};
        if (req.body.active   !== undefined) fields.active       = Boolean(req.body.active);
        if (req.body.password)               fields.passwordHash = hashPassword(req.body.password);
        await db.updateUser(req.params.userId, fields);
        res.json({ ok: true });
    } catch (e) {
        console.error('[PUT /api/users/:userId]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Delete student (admin) ── */
router.delete('/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede eliminar el admin' });

        const { userId } = user;
        revokeUserSessions(userId);
        await db.deleteUser(userId);
        if (!db.USE_DB) await db.deleteProfile(userId);

        if (USE_CLOUDINARY) {
            cloudinary.api.delete_resources_by_prefix('expresart/' + userId + '/')
                .then(() => cloudinary.api.delete_folder('expresart/' + userId))
                .catch(() => {});
        } else {
            const uploadDir = path.join(UPLOADS_DIR, userId);
            if (fs.existsSync(uploadDir)) {
                fs.readdirSync(uploadDir).forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
                fs.rmdirSync(uploadDir);
            }
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/users/:userId]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Reset student password (admin generates temp password) ── */
router.post('/:userId/reset-password', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede resetear el admin' });

        const tempPassword = randomAlphaNum(10);
        await db.updateUser(user.userId, { passwordHash: hashPassword(tempPassword), mustChangePassword: true });
        revokeUserSessions(user.userId);
        await db.markResetRequestDone(user.userId);
        res.json({ ok: true, tempPassword });
    } catch (e) {
        console.error('[POST /api/users/:userId/reset-password]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Student requests password reset (public) ── */
router.post('/reset-request', resetRequestLimiter, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username || typeof username !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario requerido' });
        const user = await db.getUserByUsername(username.trim());
        // Always return ok=true to avoid user enumeration
        if (!user || user.role === 'admin') return res.json({ ok: true });
        await db.createResetRequest({
            id: 'rr_' + Date.now(), userId: user.userId, username: user.username,
            requestedAt: new Date().toISOString(), status: 'pending'
        });
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/reset-request]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── List reset requests (admin) ── */
router.get('/reset-requests', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json(await db.getResetRequests());
    } catch (e) {
        console.error('[GET /api/reset-requests]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Dismiss reset request (admin) ── */
router.delete('/reset-requests/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        await db.dismissResetRequest(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/reset-requests/:id]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

module.exports = router;
