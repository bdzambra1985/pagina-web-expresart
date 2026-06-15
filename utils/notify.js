'use strict';

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function notifyEmail(subject, text, html) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || !NOTIFY_EMAIL) return;
    try {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);
        const { error } = await resend.emails.send({
            from:    'EXPRESART <onboarding@resend.dev>',
            to:      NOTIFY_EMAIL,
            subject,
            text,
            html,
        });
        if (error) console.error('[Email notify]', error.message);
    } catch (e) {
        console.error('[Email notify]', e.message);
    }
}

module.exports = { notifyEmail };
