'use strict';

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function notifyEmail(subject, text, html, to, attachments) {
    const apiKey    = process.env.RESEND_API_KEY;
    const recipient = to || NOTIFY_EMAIL;

    if (!apiKey) {
        console.warn('[Email notify] RESEND_API_KEY no configurado — email no enviado:', subject);
        return;
    }
    if (!recipient) {
        console.warn('[Email notify] NOTIFY_EMAIL no configurado — email no enviado:', subject);
        return;
    }

    const FROM = process.env.RESEND_FROM || 'EXPRESART <noreply@expresart.ec>';

    try {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);
        const payload = { from: FROM, to: recipient, subject, text, html };
        if (attachments && attachments.length) payload.attachments = attachments;
        const { data, error } = await resend.emails.send(payload);
        if (error) {
            console.error('[Email notify] Error Resend:', JSON.stringify(error));
        } else {
            console.log('[Email notify] Enviado OK — id:', data?.id, '| para:', recipient, '| asunto:', subject);
        }
    } catch (e) {
        console.error('[Email notify] Excepción:', e.message);
    }
}

module.exports = { notifyEmail };
