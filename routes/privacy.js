'use strict';
const router = require('express').Router();
const db     = require('../db');
const { requireAdmin, logSecurity } = require('../middleware/auth');

const INBOX_ADDRESS = 'privacidad@expresart.ec';

/* ── Webhook de Resend: email recibido en privacidad@expresart.ec ──
   Configurar en el dashboard de Resend (Inbound) para que apunte a
   POST /api/webhooks/resend-inbound, y setear RESEND_WEBHOOK_SECRET
   con el secreto que genera Resend al crear el webhook.
*/
router.post('/webhooks/resend-inbound', async (req, res) => {
    try {
        const apiKey  = process.env.RESEND_API_KEY;
        const secret  = process.env.RESEND_WEBHOOK_SECRET;
        if (!apiKey || !secret) {
            console.warn('[privacidad-inbox] RESEND_API_KEY o RESEND_WEBHOOK_SECRET no configurados');
            return res.status(503).json({ ok: false });
        }

        const { Resend } = require('resend');
        const resend = new Resend(apiKey);

        let event;
        try {
            event = resend.webhooks.verify({
                payload: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body),
                headers: {
                    id:        req.headers['svix-id'],
                    timestamp: req.headers['svix-timestamp'],
                    signature: req.headers['svix-signature']
                },
                webhookSecret: secret
            });
        } catch (e) {
            logSecurity('INBOUND_WEBHOOK_INVALID_SIGNATURE', e.message);
            return res.status(400).json({ ok: false, message: 'Firma inválida' });
        }

        if (event.type !== 'email.received') return res.status(200).json({ ok: true });

        const data = event.data;
        const toList = (data.to || []).map(a => String(a).toLowerCase());
        if (!toList.some(a => a.includes(INBOX_ADDRESS))) {
            // No es para la bandeja de privacidad — ignorar silenciosamente.
            return res.status(200).json({ ok: true });
        }

        // El evento del webhook solo trae metadata; el cuerpo hay que pedirlo aparte.
        let body = '';
        try {
            const full = await resend.emails.receiving.get(data.email_id);
            body = full.data?.text || full.data?.html || '';
        } catch (e) {
            console.error('[privacidad-inbox] error obteniendo cuerpo del email:', e.message);
        }

        await db.createPrivacyMessage({
            id:         data.email_id,
            fromEmail:  data.from,
            subject:    data.subject || '(sin asunto)',
            body,
            receivedAt: data.created_at || new Date().toISOString()
        });

        logSecurity('INBOUND_PRIVACY_EMAIL', `from=${data.from} subject=${data.subject || ''}`);
        res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[/api/webhooks/resend-inbound]', e);
        res.status(500).json({ ok: false });
    }
});

/* ── Admin: listar / marcar leído / eliminar ── */
router.get('/privacy-messages', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const messages = await db.getPrivacyMessages();
        res.json({ ok: true, messages });
    } catch (e) {
        console.error('[GET /api/privacy-messages]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.put('/privacy-messages/:id/read', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        await db.markPrivacyMessageRead(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[PUT /api/privacy-messages/:id/read]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.delete('/privacy-messages/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        await db.deletePrivacyMessage(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/privacy-messages/:id]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

module.exports = router;
