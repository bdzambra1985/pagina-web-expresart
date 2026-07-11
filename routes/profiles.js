'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireAuth }                              = require('../middleware/auth');
const { uploader, saveFile, detectMime, ALLOWED_MIMES_IMAGE } = require('../middleware/upload');
const { emptyProfile }                             = require('../utils/html');

/* ── Public: list active portfolios ── */
router.get('/profiles', async (req, res) => {
    try {
        const users   = await db.getUsers();
        const results = [];
        for (const u of users) {
            if (u.role !== 'alumno' || !u.active) continue;
            const p = await db.getProfile(u.userId) || {};
            if (p.portfolioActive === false) continue;
            results.push({
                userId:         u.userId,
                displayName:    p.displayName    || u.username,
                bio_short:      p.bio_short      || '',
                especialidades: p.especialidades || [],
                photoUrl:       p.photoUrl       || '',
                producciones:   (p.producciones  || []).length,
                videos:         (p.videos        || []).length
            });
        }
        res.json(results);
    } catch (e) {
        console.error('[GET /api/profiles]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Public: single portfolio ── */
router.get('/profile/:userId', async (req, res) => {
    try {
        const user = await db.getUserById(req.params.userId);
        if (!user || !user.active || user.role !== 'alumno')
            return res.status(404).json({ ok: false, message: 'Perfil no encontrado' });
        const profile = await db.getProfile(user.userId) || {};
        if (profile.portfolioActive === false)
            return res.status(404).json({ ok: false, message: 'Portafolio no disponible' });
        res.json({ ok: true, profile });
    } catch (e) {
        console.error('[GET /api/profile/:userId]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Authenticated: get own profile ── */
router.get('/my-profile', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        res.json({ ok: true, profile: await db.getProfile(sess.userId) || emptyProfile(sess.userId) });
    } catch (e) {
        console.error('[GET /api/my-profile]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Authenticated: update own profile ── */
router.post('/my-profile', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const current = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
        const b = req.body;
        if (b.displayName    !== undefined) current.displayName    = String(b.displayName).trim().slice(0, 100);
        if (b.bio_short      !== undefined) current.bio_short      = String(b.bio_short).trim().slice(0, 300);
        if (b.bio            !== undefined) current.bio            = String(b.bio).trim().slice(0, 3000);
        if (b.especialidades !== undefined) current.especialidades = Array.isArray(b.especialidades) ? b.especialidades.slice(0, 20) : [];
        if (b.producciones   !== undefined) current.producciones   = Array.isArray(b.producciones)   ? b.producciones.slice(0, 50)   : [];
        if (b.videos         !== undefined) current.videos         = Array.isArray(b.videos)         ? b.videos.slice(0, 30)         : [];
        if (b.portfolioActive !== undefined) current.portfolioActive = Boolean(b.portfolioActive);
        // certificados solo se modifican via /api/users/:userId/certificados (admin)
        await db.upsertProfile(sess.userId, current);
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/my-profile]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Authenticated: upload profile photo ── */
router.post('/upload-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err)        return res.status(400).json({ ok: false, message: err.message });
        if (!req.file)  return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes (JPEG, PNG, WebP, GIF)' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId, { compress: true });
            const p   = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
            p.photoUrl = url;
            await db.upsertProfile(sess.userId, p);
            res.json({ ok: true, url });
        } catch (e) {
            console.error('[POST /api/upload-photo]', e);
            res.status(500).json({ ok: false, message: 'Error al guardar imagen' });
        }
    });
});

/* ── Authenticated: upload production photo (no profile update, returns URL) ── */
router.post('/upload-prod-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err)       return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes (JPEG, PNG, WebP, GIF)' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId, { compress: true });
            res.json({ ok: true, url });
        } catch (e) {
            console.error('[POST /api/upload-prod-photo]', e);
            res.status(500).json({ ok: false, message: 'Error al guardar imagen' });
        }
    });
});

/* ── Authenticated: add video ── */
router.post('/add-video', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const { url, title } = req.body;
        if (!url) return res.status(400).json({ ok: false, message: 'URL requerida' });
        const VIDEO_HOSTS = /^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com|player\.vimeo\.com)(\/|$)/i;
        if (!VIDEO_HOSTS.test(url))
            return res.status(400).json({ ok: false, message: 'Solo se permiten videos de YouTube o Vimeo' });
        const p = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
        if (!p.videos) p.videos = [];
        p.videos.push({ url, title: title || '' });
        await db.upsertProfile(sess.userId, p);
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/add-video]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Authenticated: delete video ── */
router.delete('/video/:idx', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const p   = await db.getProfile(sess.userId);
        const idx = parseInt(req.params.idx);
        if (!p || !p.videos || isNaN(idx) || idx < 0 || idx >= p.videos.length)
            return res.status(400).json({ ok: false, message: 'Índice inválido' });
        p.videos.splice(idx, 1);
        await db.upsertProfile(sess.userId, p);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/video/:idx]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

module.exports = router;
