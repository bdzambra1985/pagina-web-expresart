'use strict';

const dns        = require('dns');
const nodemailer = require('nodemailer');

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

// Resolve smtp.gmail.com to IPv4 explicitly — Railway has no IPv6 egress
let _transporter = null;
function getTransporter() {
    if (_transporter) return Promise.resolve(_transporter);
    return new Promise((resolve, reject) => {
        dns.resolve4('smtp.gmail.com', (err, addrs) => {
            if (err) return reject(err);
            _transporter = nodemailer.createTransport({
                host:   addrs[0],
                port:   587,
                secure: false,
                auth:   { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
                tls:    { servername: 'smtp.gmail.com' },
            });
            resolve(_transporter);
        });
    });
}

function notifyEmail(subject, text) {
    if (!NOTIFY_EMAIL || !process.env.GMAIL_USER) return;
    getTransporter()
        .then(t => t.sendMail({
            from: `"EXPRESART" <${process.env.GMAIL_USER}>`,
            to:   NOTIFY_EMAIL,
            subject,
            text,
        }))
        .catch(e => console.error('[Email notify]', e.message));
}

module.exports = { notifyEmail, getTransporter };
