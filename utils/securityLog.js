'use strict';
const fs   = require('fs');
const path = require('path');

/* ══════════════════════════════════════════════════════════════
   Registro de eventos de seguridad.

   Antes solo se hacía console.log: en cuanto el proceso reinicia o
   el buffer del hosting rota, no queda rastro de qué pasó. Sin
   registro persistente no hay forma de investigar un incidente
   después de que ocurra.

   Se escribe una línea JSON por evento (formato JSONL, cómodo de
   filtrar con jq o grep) en logs/security-YYYY-MM-DD.log, y se
   conservan los últimos RETENTION_DAYS días.

   Los eventos marcados como críticos disparan además un email al
   administrador, con antirebote para no convertir un ataque de
   fuerza bruta en una inundación de correo.
   ══════════════════════════════════════════════════════════════ */

const LOG_DIR        = process.env.SECURITY_LOG_DIR || path.join(__dirname, '..', 'logs');
const RETENTION_DAYS = parseInt(process.env.SECURITY_LOG_RETENTION_DAYS, 10) || 90;

/* Eventos que merecen despertar a alguien. */
const CRITICAL = new Set([
    'LOGIN_LOCKOUT',      // fuerza bruta en curso
    'ADMIN_LOGIN',        // alguien entró como administrador
    'ADMIN_PW_CHANGED',
    'BACKUP_DOWNLOADED',  // alguien se llevó una copia de la base
    'TOTP_DISABLED',      // se desactivó el segundo factor
]);

/* Antirebote: máximo un email por tipo de evento cada ALERT_WINDOW_MS. */
const ALERT_WINDOW_MS = 15 * 60 * 1000;
const lastAlert = new Map();

let _dirReady = false;
function _ensureDir() {
    if (_dirReady) return true;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 });
        _dirReady = true;
        return true;
    } catch (e) {
        console.error('[SEC] No se pudo crear el directorio de logs:', e.message);
        return false;
    }
}

function _logFile(date) {
    return path.join(LOG_DIR, `security-${date.toISOString().slice(0, 10)}.log`);
}

/* Borra los logs más antiguos que RETENTION_DAYS. */
function pruneOldLogs() {
    if (!_ensureDir()) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    try {
        for (const f of fs.readdirSync(LOG_DIR)) {
            const m = /^security-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
            if (!m) continue;
            if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff)
                fs.unlinkSync(path.join(LOG_DIR, f));
        }
    } catch (e) {
        console.error('[SEC] Error al rotar logs:', e.message);
    }
}

function _maybeAlert(event, detail, entry) {
    if (!CRITICAL.has(event)) return;
    const now  = Date.now();
    const last = lastAlert.get(event) || 0;
    if (now - last < ALERT_WINDOW_MS) return;
    lastAlert.set(event, now);

    // require diferido: notify.js carga el SDK de Resend, y no queremos
    // pagar ese coste en el arranque si nunca se dispara una alerta.
    let notifyEmail;
    try { ({ notifyEmail } = require('./notify')); } catch { return; }

    const body = `Evento de seguridad en EXPRESART\n\n`
               + `Evento:  ${event}\n`
               + `Detalle: ${detail}\n`
               + `Fecha:   ${entry.ts}\n\n`
               + `Si no reconoces esta actividad, cambia la contraseña de administrador `
               + `y revisa ${LOG_DIR}.`;

    Promise.resolve(notifyEmail(`[SEGURIDAD] ${event}`, body))
        .catch(e => console.error('[SEC] No se pudo enviar la alerta:', e.message));
}

/**
 * Registra un evento de seguridad.
 * @param {string} event  Identificador corto en mayúsculas (LOGIN_FAIL, …)
 * @param {string} detail Texto libre con el contexto
 * @param {object} [meta] Campos extra (ip, userId, …) que se guardan en el JSON
 */
function logSecurity(event, detail, meta = {}) {
    const entry = { ts: new Date().toISOString(), event, detail, ...meta };

    // Se mantiene la salida por consola: es lo que se ve en los logs del hosting.
    console.log(`[SEC ${entry.ts}] ${event} — ${detail}`);

    if (_ensureDir()) {
        try {
            fs.appendFileSync(_logFile(new Date()), JSON.stringify(entry) + '\n', { mode: 0o640 });
        } catch (e) {
            console.error('[SEC] No se pudo escribir el log:', e.message);
        }
    }

    _maybeAlert(event, detail, entry);
}

/* Lectura para el panel admin: últimas N entradas, de más reciente a más antigua. */
function readRecent(limit = 200) {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR)
        .filter(f => /^security-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort().reverse();

    const out = [];
    for (const f of files) {
        const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            try { out.push(JSON.parse(lines[i])); } catch { /* línea corrupta: se ignora */ }
        }
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { logSecurity, readRecent, pruneOldLogs, LOG_DIR };
