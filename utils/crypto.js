'use strict';
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const SALT_FILE = path.join(DATA_DIR, '.salt');

function getPwSalt() {
    if (process.env.EXP_SALT) return process.env.EXP_SALT;
    if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE, 'utf8').trim();
    const salt = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
    console.warn('  WARN: EXP_SALT no definido — salt generado en data/.salt');
    return salt;
}

const PW_SALT = getPwSalt();

// Separate key for signing view URLs — uses EXP_SIGN_SECRET if set, otherwise derived from PW_SALT
const _signSecret  = process.env.EXP_SIGN_SECRET || PW_SALT;
const VIEW_SIGN_KEY = crypto.createHmac('sha256', _signSecret).update('signed-view-url:v1').digest();

/* ══════════════════════════════════════════════════════════════
   Password hashing — PBKDF2 con salt aleatorio POR USUARIO.

   Formato nuevo:  pbkdf2$<iteraciones>$<saltHex>$<hashHex>
   Formato legado: 128 caracteres hex (PBKDF2 con salt global PW_SALT)

   verifyPassword acepta ambos formatos para no invalidar contraseñas
   ya almacenadas. needsRehash() indica cuándo conviene re-hashear un
   hash legado tras un login exitoso (migración transparente).
   ══════════════════════════════════════════════════════════════ */
const PBKDF2_ITERS = 100_000;
const PBKDF2_KEYLEN = 64;

function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pw, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha256').toString('hex');
    return `pbkdf2$${PBKDF2_ITERS}$${salt}$${hash}`;
}

// Hashea con el esquema legado (salt global) — solo para verificación.
function _legacyHash(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha256').toString('hex');
}

function verifyPassword(pw, stored) {
    try {
        if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) {
            const [, itersStr, salt, expected] = stored.split('$');
            const iters = parseInt(itersStr, 10) || PBKDF2_ITERS;
            const actual = crypto.pbkdf2Sync(pw, salt, iters, expected.length / 2, 'sha256').toString('hex');
            return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
        }
        // Formato legado: hex plano con salt global.
        return crypto.timingSafeEqual(
            Buffer.from(_legacyHash(pw), 'hex'),
            Buffer.from(stored, 'hex')
        );
    } catch { return false; }
}

// true si el hash usa el esquema legado (conviene migrarlo al iniciar sesión).
function needsRehash(stored) {
    return typeof stored !== 'string' || !stored.startsWith('pbkdf2$');
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

function randomAlphaNum(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
    return s;
}

// HMAC-signed view token for protected URLs (replaces session token in ?t= params).
// Valid for current 15-min window + previous window (15–30 min total).
function signViewPath(resourcePath) {
    const window = Math.floor(Date.now() / (15 * 60 * 1000));
    return crypto.createHmac('sha256', VIEW_SIGN_KEY)
        .update(resourcePath + ':' + window)
        .digest('hex')
        .slice(0, 40);
}

function verifyViewPath(resourcePath, sv) {
    if (!sv || sv.length !== 40) return false;
    const window = Math.floor(Date.now() / (15 * 60 * 1000));
    for (const w of [window, window - 1]) {
        const expected = crypto.createHmac('sha256', VIEW_SIGN_KEY)
            .update(resourcePath + ':' + w)
            .digest('hex')
            .slice(0, 40);
        try {
            if (crypto.timingSafeEqual(Buffer.from(sv, 'hex'), Buffer.from(expected, 'hex')))
                return true;
        } catch { /* invalid hex */ }
    }
    return false;
}

module.exports = {
    hashPassword, verifyPassword, needsRehash,
    tokenHash, newToken, randomAlphaNum,
    signViewPath, verifyViewPath
};
