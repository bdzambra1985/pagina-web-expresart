'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const db   = require('../db');

/* ── Cloudflare R2 (S3-compatible) ── */
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET     = process.env.R2_BUCKET || 'expresart-backups';
const USE_R2        = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY);

let r2;
if (USE_R2) {
    const { S3Client } = require('@aws-sdk/client-s3');
    r2 = new S3Client({
        region:   'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
    });
}

/* ── Directorio local temporal (solo si no hay R2) ── */
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 30;

/* ══════════════════════════════════════
   GENERAR SNAPSHOT DE TODAS LAS TABLAS
   ══════════════════════════════════════ */
async function buildSnapshot() {
    const [users, events, orders, bankInfo, shareLinks, resetRequests] = await Promise.all([
        db.getUsers(),
        db.getEvents(),
        db.getOrders(),
        db.getBankInfo(),
        db.getShareLinks(),
        db.getResetRequests(),
    ]);
    return {
        exportedAt: new Date().toISOString(),
        version: 1,
        tables: {
            users, events, orders,
            bankInfo: bankInfo ? [bankInfo] : [],
            shareLinks, resetRequests
        }
    };
}

/* ══════════════════════════════════════
   SUBIR A R2
   ══════════════════════════════════════ */
async function uploadToR2(filename, buffer) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await r2.send(new PutObjectCommand({
        Bucket:      R2_BUCKET,
        Key:         filename,
        Body:        buffer,
        ContentType: 'application/gzip',
    }));
}

/* ══════════════════════════════════════
   EJECUTAR RESPALDO
   ══════════════════════════════════════ */
async function runBackup() {
    const started  = Date.now();
    const date     = new Date().toISOString().slice(0, 10);
    const filename = `backup-${date}.json.gz`;
    console.log(`[BACKUP] Iniciando respaldo: ${filename}`);

    try {
        const snapshot   = await buildSnapshot();
        const compressed = zlib.gzipSync(JSON.stringify(snapshot));
        const kb         = Math.round(compressed.length / 1024);

        if (USE_R2) {
            await uploadToR2(filename, compressed);
            console.log(`[BACKUP] ✓ Subido a R2: ${filename} — ${kb} KB (${Date.now() - started}ms)`);
        } else {
            /* Guardar en disco local si no hay R2 */
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            fs.writeFileSync(path.join(BACKUP_DIR, filename), compressed);
            console.log(`[BACKUP] ✓ Guardado localmente: ${filename} — ${kb} KB (${Date.now() - started}ms)`);
            _rotateLocal();
        }

        return { ok: true, filename, sizeKb: kb, storage: USE_R2 ? 'r2' : 'local' };
    } catch (e) {
        console.error('[BACKUP] Error:', e.message);
        return { ok: false, error: e.message };
    }
}

/* ══════════════════════════════════════
   LISTAR RESPALDOS
   ══════════════════════════════════════ */
async function listBackups() {
    if (USE_R2) {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET }));
        return (res.Contents || [])
            .filter(o => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(o.Key))
            .sort((a, b) => b.Key.localeCompare(a.Key))
            .map(o => ({
                filename: o.Key,
                sizeKb:   Math.round(o.Size / 1024),
                mtime:    o.LastModified?.toISOString() || ''
            }));
    }
    /* Local */
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
        .sort().reverse()
        .map(f => {
            const stat = fs.statSync(path.join(BACKUP_DIR, f));
            return { filename: f, sizeKb: Math.round(stat.size / 1024), mtime: stat.mtime.toISOString() };
        });
}

/* ══════════════════════════════════════
   OBTENER STREAM PARA DESCARGA
   ══════════════════════════════════════ */
async function getBackupStream(filename) {
    if (!/^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(filename)) return null;

    if (USE_R2) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        try {
            const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
            return res.Body; // ReadableStream
        } catch { return null; }
    }
    /* Local */
    const fp = path.join(BACKUP_DIR, filename);
    return fs.existsSync(fp) ? fs.createReadStream(fp) : null;
}

/* ── Rotar backups locales (solo sin R2) ── */
function _rotateLocal() {
    const all = fs.readdirSync(BACKUP_DIR)
        .filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
        .sort();
    while (all.length > MAX_BACKUPS) {
        fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    }
}

module.exports = { runBackup, listBackups, getBackupStream, USE_R2, R2_BUCKET };
