'use strict';
const crypto = require('crypto');

/* ══════════════════════════════════════════════════════════════
   TOTP — segundo factor por app autenticadora (RFC 6238).

   Implementado sobre `crypto` en vez de tirar de una librería: el
   algoritmo son treinta líneas, y cada dependencia nueva en la ruta
   de autenticación es superficie de ataque de cadena de suministro
   que hay que vigilar para siempre.

   Compatible con Google Authenticator, Authy, 1Password, Aegis…:
   HMAC-SHA1, 6 dígitos, ventanas de 30 segundos.
   ══════════════════════════════════════════════════════════════ */

const DIGITS   = 6;
const PERIOD   = 30;               // segundos por código
const WINDOW   = 1;                // acepta ±1 ventana (±30 s) por desfase de reloj
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // base32 RFC 4648

/* ── Base32 ── */
function base32Encode(buf) {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xFF);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/* Secreto de 20 bytes (160 bits), el tamaño que recomienda el RFC para SHA-1. */
function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

/* Código para un contador concreto (HOTP, RFC 4226). */
function _hotp(secretBuf, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();

    // Truncamiento dinámico: los 4 bits bajos del último byte indican
    // desde dónde leer los 4 bytes que forman el código.
    const offset = hmac[hmac.length - 1] & 0x0F;
    const bin = ((hmac[offset]     & 0x7F) << 24)
              | ((hmac[offset + 1] & 0xFF) << 16)
              | ((hmac[offset + 2] & 0xFF) << 8)
              |  (hmac[offset + 3] & 0xFF);

    return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function generateCode(secret, atMs = Date.now()) {
    return _hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD));
}

/**
 * Verifica un código, aceptando ±WINDOW ventanas por desfase de reloj.
 * Comparación en tiempo constante para no filtrar el código por timing.
 */
function verifyCode(secret, code, atMs = Date.now()) {
    if (typeof code !== 'string' && typeof code !== 'number') return false;
    const clean = String(code).replace(/\D/g, '');
    if (clean.length !== DIGITS) return false;

    const secretBuf = base32Decode(secret);
    if (!secretBuf.length) return false;

    const counter = Math.floor(atMs / 1000 / PERIOD);
    let match = false;
    for (let w = -WINDOW; w <= WINDOW; w++) {
        const expected = _hotp(secretBuf, counter + w);
        // Se recorren todas las ventanas siempre (sin cortar al primer
        // acierto) para que el tiempo de respuesta no dependa de cuál acertó.
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) match = true;
    }
    return match;
}

/* URI otpauth:// que se codifica en el QR. */
function otpauthUri(secret, account, issuer = 'EXPRESART') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD)
    });
    return `otpauth://totp/${label}?${params}`;
}

/* ── Códigos de recuperación ──
   Para no quedarse fuera si se pierde el teléfono. Alta entropía
   (50 bits), así que basta con guardarlos hasheados con SHA-256:
   no son adivinables por fuerza bruta como sí lo sería una contraseña. */
function generateRecoveryCodes(n = 10) {
    const codes = [];
    for (let i = 0; i < n; i++) {
        const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
        codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
    }
    return codes;
}

function hashRecoveryCode(code) {
    return crypto.createHash('sha256')
        .update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .digest('hex');
}

module.exports = {
    generateSecret, generateCode, verifyCode, otpauthUri,
    generateRecoveryCodes, hashRecoveryCode,
    base32Encode, base32Decode, PERIOD, DIGITS
};
