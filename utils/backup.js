'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const db   = require('../db');

const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 30;

async function runBackup() {
    const started = Date.now();
    console.log('[BACKUP] Iniciando respaldo…');

    try {
        const [users, events, orders, bankInfo, shareLinks, resetRequests] = await Promise.all([
            db.getUsers(),
            db.getEvents(),
            db.getOrders(),
            db.getBankInfo(),
            db.getShareLinks(),
            db.getResetRequests(),
        ]);

        // Perfiles: no hay getProfiles() global — se omiten (se regeneran de users)
        const snapshot = {
            exportedAt: new Date().toISOString(),
            version: 1,
            tables: { users, events, orders, bankInfo: bankInfo ? [bankInfo] : [], shareLinks, resetRequests }
        };

        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

        const date       = new Date().toISOString().slice(0, 10);
        const filename   = `backup-${date}.json.gz`;
        const filepath   = path.join(BACKUP_DIR, filename);
        const compressed = zlib.gzipSync(JSON.stringify(snapshot));
        fs.writeFileSync(filepath, compressed);

        const kb = Math.round(compressed.length / 1024);
        console.log(`[BACKUP] ✓ ${filename} — ${kb} KB (${Date.now() - started}ms)`);

        /* Rotar: conservar solo los últimos MAX_BACKUPS */
        const all = fs.readdirSync(BACKUP_DIR)
            .filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
            .sort();
        while (all.length > MAX_BACKUPS) {
            const old = all.shift();
            fs.unlinkSync(path.join(BACKUP_DIR, old));
            console.log(`[BACKUP] Eliminado: ${old}`);
        }

        return { ok: true, filename, sizeKb: kb };
    } catch (e) {
        console.error('[BACKUP] Error:', e.message);
        return { ok: false, error: e.message };
    }
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
        .sort().reverse()
        .map(f => {
            const stat = fs.statSync(path.join(BACKUP_DIR, f));
            return { filename: f, sizeKb: Math.round(stat.size / 1024), mtime: stat.mtime.toISOString() };
        });
}

function getBackupPath(filename) {
    if (!/^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(filename)) return null;
    const fp = path.join(BACKUP_DIR, filename);
    return fs.existsSync(fp) ? fp : null;
}

module.exports = { runBackup, listBackups, getBackupPath };
