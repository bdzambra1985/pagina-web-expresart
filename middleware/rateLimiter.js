'use strict';
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { ok: false, message: 'Demasiados intentos. Intenta en 15 minutos.' }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/')
});

const resetRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false
});

// Limit payment submissions to prevent admin email spam and DB flooding
const orderLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { ok: false, message: 'Demasiados envíos. Espera 10 minutos.' }
});

module.exports = { loginLimiter, apiLimiter, resetRequestLimiter, orderLimiter };
