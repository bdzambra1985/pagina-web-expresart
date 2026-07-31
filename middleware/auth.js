'use strict';
const { tokenHash, newToken } = require('../utils/crypto');
const { readSession }         = require('../utils/cookies');

/* ── TTL constants ── */
const SESSION_TTL     = 60 * 60 * 1000;       // 1 h inactivity
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;   // 8 h absolute maximum
const SHARE_TTL       = 24 * 60 * 60 * 1000;  // 24 h for share-link sessions
const GC_INTERVAL     = 10 * 60 * 1000;       // clean up every 10 min

/* ── Brute-force lockout constants ── */
const LOGIN_MAX_TRIES = 5;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;

/* ── Almacenes en memoria, respaldados en la base de datos ──

   La lectura sigue siendo síncrona (la hacen ~50 guards en cada
   petición), pero toda escritura se replica a la BD en segundo plano y
   al arrancar se recarga lo guardado. Con eso:
     • un despliegue ya no cierra la sesión de todo el mundo;
     • un bloqueo por fuerza bruta ya no se borra reiniciando —antes
       bastaba con esperar al siguiente deploy para reintentar.

   Limitación conocida: esto NO comparte estado entre varias instancias
   del proceso. Para eso haría falta que getSession fuese asíncrono y
   consultara la BD en cada petición. Hoy el servidor corre en una sola
   instancia (el cron de respaldos también vive dentro del proceso).
*/
const sessions      = new Map(); // tokenHash → session object
const loginAttempts = new Map(); // ip:usuario → { count, lockedUntil, ts }

const db = require('../db');

// Las escrituras a BD no deben tumbar la petición si fallan: la sesión
// ya está en memoria y funciona; la persistencia es el extra.
function _bg(promise, label) {
    Promise.resolve(promise).catch(e =>
        console.error(`[auth persist] ${label}:`, e.message));
}

/* Recarga sesiones y bloqueos guardados. Lo llama server.js al arrancar. */
async function restoreFromDB() {
    const now = Date.now();
    try {
        let restored = 0, dropped = [];
        for (const row of await db.loadSessions()) {
            const maxAge = row.expiresAt ?? (row.createdAt + SESSION_MAX_AGE);
            const idle   = row.lastSeen + SESSION_TTL;
            if (now >= maxAge || now >= idle) { dropped.push(row.tokenHash); continue; }
            sessions.set(row.tokenHash, {
                ...row.data, ts: row.lastSeen,
                createdAt: row.createdAt, expiresAt: row.expiresAt
            });
            restored++;
        }
        if (dropped.length) _bg(db.deleteSessions(dropped), 'purga inicial');
        console.log(`  [auth] ${restored} sesión(es) restaurada(s), ${dropped.length} caducada(s).`);
    } catch (e) {
        console.error('[auth] No se pudieron restaurar las sesiones:', e.message);
    }
    try {
        let restored = 0;
        for (const row of await db.loadLoginAttempts()) {
            if (row.lockedUntil && now >= row.lockedUntil + LOGIN_LOCK_MS) continue;
            if (!row.lockedUntil && now - row.ts >= LOGIN_LOCK_MS) continue;
            loginAttempts.set(row.lockKey,
                { count: row.count, lockedUntil: row.lockedUntil, ts: row.ts });
            restored++;
        }
        if (restored) console.log(`  [auth] ${restored} bloqueo(s) de login restaurado(s).`);
    } catch (e) {
        console.error('[auth] No se pudieron restaurar los bloqueos:', e.message);
    }
}

/* ── Session lifecycle ── */

function createSession(data) {
    const token = newToken();
    const now   = Date.now();
    const hash  = tokenHash(token);
    const sess  = { ...data, ts: now, createdAt: now };
    sessions.set(hash, sess);
    _bg(db.saveSession(hash, sess), 'createSession');
    return token;
}

/* Registra un intento fallido / bloqueo, replicándolo a la BD. */
function setLoginAttempt(lockKey, att) {
    loginAttempts.set(lockKey, att);
    _bg(db.saveLoginAttempt(lockKey, att), 'setLoginAttempt');
}

function clearLoginAttempt(lockKey) {
    loginAttempts.delete(lockKey);
    _bg(db.deleteLoginAttempts([lockKey]), 'clearLoginAttempt');
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
        _bg(db.deleteSessions([key]), 'sesión caducada');
        return null;
    }

    // Slide inactivity timer only for regular sessions (not share-link which use expiresAt)
    if (sess.expiresAt === undefined) {
        sess.ts = now;
        // El nuevo last_seen se vuelca en lote desde el GC, no en cada
        // petición: si no, cada carga de página sería un UPDATE.
        pendingTouch.set(key, now);
    }
    return sess;
}

/* Sesiones cuyo last_seen cambió y aún no se ha escrito a la BD. */
const pendingTouch = new Map();

function flushTouches() {
    if (!pendingTouch.size) return;
    const entries = [...pendingTouch].map(([tokenHash, ts]) => ({ tokenHash, ts }));
    pendingTouch.clear();
    _bg(db.touchSessions(entries), 'flushTouches');
}

function getSession(req) {
    const cookieToken = readSession(req);
    return cookieToken ? _resolve(cookieToken) : null;
}

function getSessionByRawToken(raw) {
    return raw ? _resolve(raw) : null;
}

function revokeSession(rawToken) {
    if (!rawToken) return;
    const key = tokenHash(rawToken);
    sessions.delete(key);
    pendingTouch.delete(key);
    _bg(db.deleteSessions([key]), 'revokeSession');
}

function revokeUserSessions(userId) {
    const removed = [];
    for (const [k, v] of sessions) {
        if (v.userId === userId) { sessions.delete(k); pendingTouch.delete(k); removed.push(k); }
    }
    _bg(db.deleteSessions(removed), 'revokeUserSessions');
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

/* Requiere una sesión de miembro real (admin o alumno).
   Excluye explícitamente las sesiones 'share' (enlaces compartidos), que son
   de solo-lectura del portafolio público y NUNCA deben poder leer/modificar
   datos de la cuenta del alumno (órdenes, perfil, subidas, enlaces). */
function requireMember(req, res) {
    const sess = requireAuth(req, res);
    if (!sess) return null;
    if (sess.role !== 'admin' && sess.role !== 'alumno') {
        res.status(403).json({ ok: false, message: 'No autorizado' });
        return null;
    }
    return sess;
}

/* ── Security logging ──
   La implementación vive en utils/securityLog.js (persiste a disco y
   alerta por email). Se reexporta aquí para no tocar los llamadores. */
const { logSecurity } = require('../utils/securityLog');

/* ── Session GC — runs every 10 min, does not block process exit ── */
setInterval(() => {
    const now     = Date.now();
    const removed = [];
    for (const [k, sess] of sessions) {
        const maxAge = sess.expiresAt ?? (sess.createdAt + SESSION_MAX_AGE);
        const idle   = sess.ts + SESSION_TTL;
        if (now >= maxAge || now >= idle) {
            sessions.delete(k); pendingTouch.delete(k); removed.push(k);
        }
    }
    if (removed.length > 0) {
        console.log(`[Auth GC] ${removed.length} sesión(es) expirada(s) eliminada(s). Activas: ${sessions.size}`);
        _bg(db.deleteSessions(removed), 'GC sesiones');
    }
    // Clean up expired login lockout entries — y también las que solo
    // acumulan intentos fallidos (count) sin haber llegado a bloqueo, para
    // que el Map no crezca sin límite ante enumeración de usuarios.
    const staleLocks = [];
    for (const [k, att] of loginAttempts) {
        if (att.lockedUntil && now >= att.lockedUntil + LOGIN_LOCK_MS) { loginAttempts.delete(k); staleLocks.push(k); continue; }
        if (!att.lockedUntil && att.ts && now - att.ts >= LOGIN_LOCK_MS) { loginAttempts.delete(k); staleLocks.push(k); }
    }
    if (staleLocks.length) _bg(db.deleteLoginAttempts(staleLocks), 'GC bloqueos');

    // Vuelca los last_seen acumulados desde el ciclo anterior.
    flushTouches();
}, GC_INTERVAL).unref();

/* Al apagar el proceso, vuelca lo pendiente en vez de perderlo. */
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { flushTouches(); });
}

module.exports = {
    /* stores (read-only outside auth.js) */
    sessions, loginAttempts,
    /* constants */
    SESSION_TTL, SESSION_MAX_AGE, SHARE_TTL,
    LOGIN_MAX_TRIES, LOGIN_LOCK_MS,
    /* session management */
    createSession, getSession, getSessionByRawToken,
    revokeSession, revokeUserSessions,
    /* login lockout (usar estos, no loginAttempts.set/delete: persisten) */
    setLoginAttempt, clearLoginAttempt,
    /* persistencia */
    restoreFromDB, flushTouches,
    /* guards */
    requireAuth, requireAdmin, requireMember,
    /* logging */
    logSecurity
};
