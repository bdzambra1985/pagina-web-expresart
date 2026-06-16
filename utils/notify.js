'use strict';

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function notifyEmail(subject, text, html, to, attachments) {
    const apiKey = process.env.RESEND_API_KEY;
    const recipient = to || NOTIFY_EMAIL;
    if (!apiKey || !recipient) return;
    try {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);
        const payload = { from: 'EXPRESART <noreply@expresart.ec>', to: recipient, subject, text, html };
        if (attachments && attachments.length) payload.attachments = attachments;
        const { error } = await resend.emails.send(payload);
        if (error) console.error('[Email notify]', error.message);
    } catch (e) {
        console.error('[Email notify]', e.message);
    }
}

module.exports = { notifyEmail };
