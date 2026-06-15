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

function hashPassword(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, 100_000, 64, 'sha256').toString('hex');
}

function verifyPassword(pw, hash) {
    try {
        return crypto.timingSafeEqual(
            Buffer.from(hashPassword(pw), 'hex'),
            Buffer.from(hash, 'hex')
        );
    } catch { return false; }
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
    hashPassword, verifyPassword,
    tokenHash, newToken, randomAlphaNum,
    signViewPath, verifyViewPath
};
