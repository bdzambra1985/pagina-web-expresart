'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireAdmin, getSession }                 = require('../middleware/auth');
const { uploader, saveFile, detectMime, ALLOWED_MIMES_IMAGE } = require('../middleware/upload');

const VALID_CATEGORIES = new Set(['obra', 'taller', 'audicion', 'otro']);
const VALID_AUDIENCES  = new Set(['publico', 'alumnos']);
const VALID_SECTIONS   = new Set(['destacada', 'producciones', 'formacion', 'especialidades', 'profile', 'nosotros', 'obras']);

/* ── Events ── */
router.get('/events', async (req, res) => {
    try {
        const sess = getSession(req);
        const isAuth = !!(sess && (sess.role === 'admin' || sess.role === 'alumno'));
        const events = (await db.getEvents())
            .filter(e => isAuth || e.audience !== 'alumnos')
            .sort((a, b) => a.date.localeCompare(b.date));
        res.json(events);
    } catch (e) {
        console.error('[GET /api/events]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.post('/events', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { title, date, time, location, description, category, audience } = req.body;
        if (!title || !date || typeof title !== 'string' || typeof date !== 'string')
            return res.status(400).json({ ok: false, message: 'Título y fecha son requeridos' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
            return res.status(400).json({ ok: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });

        const event = {
            id:          'evt_' + Date.now(),
            title:       title.trim().slice(0, 200),
            date:        date.trim(),
            time:        (time        || '').slice(0, 10),
            location:    (location    || '').slice(0, 200),
            description: (description || '').slice(0, 1000),
            category:    VALID_CATEGORIES.has(category) ? category : 'otro',
            audience:    VALID_AUDIENCES.has(audience)  ? audience : 'publico',
            createdAt:   new Date().toISOString()
        };
        await db.createEvent(event);
        res.json({ ok: true, event });
    } catch (e) {
        console.error('[POST /api/events]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.put('/events/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { title, date, time, location, description, category, audience } = req.body;
        const fields = {};
        if (title       !== undefined) fields.title       = String(title).trim().slice(0, 200);
        if (date        !== undefined) fields.date        = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
        if (time        !== undefined) fields.time        = String(time).slice(0, 10);
        if (location    !== undefined) fields.location    = String(location).slice(0, 200);
        if (description !== undefined) fields.description = String(description).slice(0, 1000);
        if (category    !== undefined) fields.category    = VALID_CATEGORIES.has(category) ? category : 'otro';
        if (audience    !== undefined) fields.audience    = VALID_AUDIENCES.has(audience)  ? audience : 'publico';
        // Remove undefined values introduced by date validation
        Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);
        const ok = await db.updateEvent(req.params.id, fields);
        if (!ok) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
        res.json({ ok: true });
    } catch (e) {
        console.error('[PUT /api/events/:id]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.delete('/events/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        await db.deleteEvent(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/events/:id]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Global content (admin) ── */
router.get('/content', async (_req, res) => {
    try {
        res.json(await db.getContent());
    } catch (e) {
        console.error('[GET /api/content]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.post('/content', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { section, data } = req.body;
        if (!section || !data) return res.status(400).json({ ok: false, message: 'section y data son requeridos' });
        if (!VALID_SECTIONS.has(section)) return res.status(400).json({ ok: false, message: 'Sección no válida' });
        if (JSON.stringify(data).length > 200_000) return res.status(400).json({ ok: false, message: 'Datos demasiado grandes' });
        await db.saveContentSection(section, data);
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/content]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Admin image upload for content ── */
router.post('/upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err)       return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, 'admin', { compress: true });
            await db.saveContentPhoto(url);
            res.json({ ok: true, url });
        } catch (e) {
            console.error('[POST /api/upload]', e);
            res.status(500).json({ ok: false, message: 'Error al subir imagen' });
        }
    });
});

module.exports = router;
