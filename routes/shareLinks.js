'use strict';
const router = require('express').Router();
const db     = require('../db');
const { hashPassword, verifyPassword, randomAlphaNum } = require('../utils/crypto');
const { requireAuth, createSession, SHARE_TTL }        = require('../middleware/auth');
const { loginLimiter }                                  = require('../middleware/rateLimiter');

/* ── Get share-link info (public — just returns userId, no secrets) ── */
router.get('/:shareId/info', async (req, res) => {
    try {
        const link = await db.getShareLink(req.params.shareId);
        if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido o inactivo' });
        res.json({ ok: true, userId: link.userId });
    } catch (e) {
        console.error('[GET /api/share-links/:shareId/info]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Authenticate share-link visitor ── */
router.post('/:shareId/auth', loginLimiter, async (req, res) => {
    try {
        const { password } = req.body || {};
        if (!password) return res.status(400).json({ ok: false, message: 'Contraseña requerida' });

        const link = await db.getShareLink(req.params.shareId);
        if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido' });
        if (!verifyPassword(password, link.passwordHash))
            return res.status(401).json({ ok: false, message: 'Contraseña incorrecta' });

        const expiresAt = Date.now() + SHARE_TTL;
        const token     = createSession({
            role: 'share', shareId: req.params.shareId,
            userId: link.userId, expiresAt
        });
        res.json({ ok: true, userId: link.userId, token, expiresAt });
    } catch (e) {
        console.error('[POST /api/share-links/:shareId/auth]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Create share-link ── */
router.post('/', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const { label } = req.body || {};
        const shareId   = randomAlphaNum(10);
        const password  = randomAlphaNum(8);
        await db.createShareLink({
            shareId, userId: sess.userId, passwordHash: hashPassword(password),
            label: String(label || '').trim().slice(0, 80),
            active: true, createdAt: new Date().toISOString()
        });
        const base = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
        res.json({ ok: true, shareId, password, url: base + '/portafolio-alumno.html?share=' + shareId });
    } catch (e) {
        console.error('[POST /api/share-links]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── List share-links ── */
router.get('/', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const all  = await db.getShareLinks();
        const mine = sess.role === 'admin' ? all : all.filter(l => l.userId === sess.userId);
        res.json(mine.map(({ shareId, label, active, createdAt }) => ({ shareId, label, active, createdAt })));
    } catch (e) {
        console.error('[GET /api/share-links]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Delete share-link ── */
router.delete('/:shareId', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;

        const allLinks = await db.getShareLinks();
        const target   = allLinks.find(l => l.shareId === req.params.shareId);
        if (!target) return res.status(404).json({ ok: false, message: 'No encontrado' });
        if (target.userId !== sess.userId && sess.role !== 'admin')
            return res.status(403).json({ ok: false, message: 'No autorizado' });

        await db.deleteShareLink(req.params.shareId);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/share-links/:shareId]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

module.exports = router;
