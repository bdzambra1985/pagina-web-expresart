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
   Password hashing — scrypt con salt aleatorio POR USUARIO.

   scrypt es "memory-hard": obliga al atacante a reservar 64 MiB por
   intento, lo que anula la ventaja de las GPU/ASIC que hace barato
   atacar PBKDF2 por fuerza bruta.

   Formatos aceptados al verificar, de más nuevo a más viejo:
     1. scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>   ← actual
     2. pbkdf2$<iteraciones>$<saltHex>$<hashHex> ← salt por usuario
     3. 128 hex                                  ← salt global (PW_SALT)

   needsRehash() marca 2 y 3 para que login los migre al esquema 1 de
   forma transparente, aprovechando que ahí sí se tiene la contraseña
   en claro.
   ══════════════════════════════════════════════════════════════ */
const SCRYPT_N      = 1 << 16;  // 65536 — coste CPU/memoria (≈64 MiB con r=8)
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 160 * 1024 * 1024;  // holgura sobre los 64 MiB que pide N·r·128

const PBKDF2_ITERS  = 100_000;
const PBKDF2_KEYLEN = 64;

// Tope defensivo: sin él, una contraseña de varios MB convierte cada
// intento de login en trabajo de hashing gratis para el atacante.
const MAX_PW_LEN = 200;

/* Todas las funciones de hashing son asíncronas a propósito: scrypt con
   estos parámetros tarda ~300 ms, y la variante síncrona bloquearía el
   event loop ese tiempo en cada login, convirtiendo el propio login en
   un vector de denegación de servicio. Las versiones async delegan en
   el threadpool de libuv. */

function _scrypt(pw, salt, N, r, p, keylen) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(pw, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM },
            (err, key) => (err ? reject(err) : resolve(key)));
    });
}

function _pbkdf2(pw, salt, iters, keylen) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(pw, salt, iters, keylen, 'sha256',
            (err, key) => (err ? reject(err) : resolve(key)));
    });
}

/* Política de contraseñas — única fuente de verdad.
   Antes estaba duplicada en tres endpoints y uno de ellos (el admin
   editando a un alumno) no la aplicaba en absoluto. */
function validatePassword(pw) {
    if (!pw || typeof pw !== 'string')       return 'Contraseña requerida';
    if (pw.length < 10)                      return 'La contraseña debe tener al menos 10 caracteres';
    if (pw.length > MAX_PW_LEN)              return `La contraseña no puede superar ${MAX_PW_LEN} caracteres`;
    if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw))
        return 'La contraseña debe incluir letras y números';
    return null;
}

async function hashPassword(pw) {
    if (typeof pw !== 'string' || pw.length > MAX_PW_LEN)
        throw new Error(`La contraseña no puede superar ${MAX_PW_LEN} caracteres`);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await _scrypt(pw, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(pw, stored) {
    try {
        if (typeof pw !== 'string' || pw.length > MAX_PW_LEN) return false;

        if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
            const [, nStr, rStr, pStr, salt, expected] = stored.split('$');
            const actual = await _scrypt(
                pw, salt,
                parseInt(nStr, 10) || SCRYPT_N,
                parseInt(rStr, 10) || SCRYPT_R,
                parseInt(pStr, 10) || SCRYPT_P,
                expected.length / 2
            );
            return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
        }

        if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) {
            const [, itersStr, salt, expected] = stored.split('$');
            const iters  = parseInt(itersStr, 10) || PBKDF2_ITERS;
            const actual = await _pbkdf2(pw, salt, iters, expected.length / 2);
            return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
        }

        // Formato legado: hex plano con salt global.
        const actual = await _pbkdf2(pw, PW_SALT, PBKDF2_ITERS, PBKDF2_KEYLEN);
        return crypto.timingSafeEqual(actual, Buffer.from(stored, 'hex'));
    } catch { return false; }
}

// true si el hash no usa ya el esquema actual (conviene migrarlo al iniciar sesión).
function needsRehash(stored) {
    return typeof stored !== 'string' || !stored.startsWith('scrypt$');
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
    hashPassword, verifyPassword, needsRehash, validatePassword, MAX_PW_LEN,
    tokenHash, newToken, randomAlphaNum,
    signViewPath, verifyViewPath
};
