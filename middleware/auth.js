'use strict';
const { tokenHash, newToken } = require('../utils/crypto');

/* ── TTL constants ── */
const SESSION_TTL     = 60 * 60 * 1000;       // 1 h inactivity
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;   // 8 h absolute maximum
const SHARE_TTL       = 24 * 60 * 60 * 1000;  // 24 h for share-link sessions
const GC_INTERVAL     = 10 * 60 * 1000;       // clean up every 10 min

/* ── Brute-force lockout constants ── */
const LOGIN_MAX_TRIES = 5;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;

/* ── In-memory stores ── */
const sessions      = new Map(); // tokenHash → session object
const loginAttempts = new Map(); // username  → { count, lockedUntil }

/* ── Session lifecycle ── */

function createSession(data) {
    const token = newToken();
    const now   = Date.now();
    sessions.set(tokenHash(token), { ...data, ts: now, createdAt: now });
    return token;
}

function _resolve(rawToken) {
    const key  = tokenHash(rawToken);
    const sess = sessions.get(key);
    if (!sess) return null;

    const now    = Date.now();
    const maxAge = sess.expiresAt ?? (sess.createdAt + SESSION_MAX_AGE);
    const idle   = sess.ts + SESSION_TTL;

    if (now >= maxAge || now >= idle) {
        sessions.delete(key);
        return null;
    }

    // Slide inactivity timer only for regular sessions (not share-link which use expiresAt)
    if (sess.expiresAt === undefined) sess.ts = now;
    return sess;
}

function getSession(req) {
    const raw = req.headers['x-session-token'];
    return raw ? _resolve(raw) : null;
}

function getSessionByRawToken(raw) {
    return raw ? _resolve(raw) : null;
}

function revokeSession(rawToken) {
    if (rawToken) sessions.delete(tokenHash(rawToken));
}

function revokeUserSessions(userId) {
    for (const [k, v] of sessions) {
        if (v.userId === userId) sessions.delete(k);
    }
}

/* ── Auth guards ── */

function requireAuth(req, res) {
    const sess = getSession(req);
    if (!sess) {
        res.status(401).json({ ok: false, message: 'No autorizado' });
        return null;
    }
    return sess;
}

function requireAdmin(req, res) {
    const sess = requireAuth(req, res);
    if (!sess) return null;
    if (sess.role !== 'admin') {
        res.status(403).json({ ok: false, message: 'Solo administradores' });
        return null;
    }
    return sess;
}

/* ── Security logging ── */

function logSecurity(event, detail) {
    const ts = new Date().toISOString();
    console.log(`[SEC ${ts}] ${event} — ${detail}`);
}

/* ── Session GC — runs every 10 min, does not block process exit ── */
setInterval(() => {
    const now     = Date.now();
    let   removed = 0;
    for (const [k, sess] of sessions) {
        const maxAge = sess.expiresAt ?? (sess.createdAt + SESSION_MAX_AGE);
        const idle   = sess.ts + SESSION_TTL;
        if (now >= maxAge || now >= idle) { sessions.delete(k); removed++; }
    }
    if (removed > 0)
        console.log(`[Auth GC] ${removed} sesión(es) expirada(s) eliminada(s). Activas: ${sessions.size}`);
}, GC_INTERVAL).unref();

module.exports = {
    /* stores (read-only outside auth.js) */
    sessions, loginAttempts,
    /* constants */
    SESSION_TTL, SESSION_MAX_AGE, SHARE_TTL,
    LOGIN_MAX_TRIES, LOGIN_LOCK_MS,
    /* session management */
    createSession, getSession, getSessionByRawToken,
    revokeSession, revokeUserSessions,
    /* guards */
    requireAuth, requireAdmin,
    /* logging */
    logSecurity
};
