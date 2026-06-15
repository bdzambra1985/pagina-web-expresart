'use strict';

const dns        = require('dns');
const nodemailer = require('nodemailer');

// Railway has no IPv6 egress — force all DNS lookups to return IPv4 first
dns.setDefaultResultOrder('ipv4first');

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

const _transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

function notifyEmail(subject, text) {
    if (!NOTIFY_EMAIL || !process.env.GMAIL_USER) return;
    _transporter.sendMail({
        from: `"EXPRESART" <${process.env.GMAIL_USER}>`,
        to:   NOTIFY_EMAIL,
        subject,
        text,
    }).catch(e => console.error('[Email notify]', e.message));
}

module.exports = { notifyEmail };
