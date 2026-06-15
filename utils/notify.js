'use strict';

const { Resend } = require('resend');

const _resend      = new Resend(process.env.RESEND_API_KEY);
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function notifyEmail(subject, text) {
    if (!NOTIFY_EMAIL || !process.env.RESEND_API_KEY) return;
    const { error } = await _resend.emails.send({
        from:    'EXPRESART <onboarding@resend.dev>',
        to:      NOTIFY_EMAIL,
        subject,
        text,
    });
    if (error) console.error('[Email notify]', error.message);
}

module.exports = { notifyEmail };
