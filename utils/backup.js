'use strict';
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const db     = require('../db');

/* ══════════════════════════════════════════════════════════════
   CIFRADO DE RESPALDOS — AES-256-GCM

   El snapshot incluye la tabla `users` (con los hashes de contraseña)
   y todos los pedidos con datos de clientes. Sin cifrar, quien acceda
   al bucket de R2 —o a una copia local— tiene la base entera.

   GCM además autentica: si alguien altera un byte del respaldo, el
   descifrado falla en vez de devolver datos manipulados.

   Formato del archivo:  "EXPBK1" | IV (12 B) | authTag (16 B) | ciphertext
   ══════════════════════════════════════════════════════════════ */
const MAGIC     = Buffer.from('EXPBK1');
const IV_LEN    = 12;
const TAG_LEN   = 16;

function _backupKey() {
    // Clave dedicada si existe; si no, se deriva de un secreto que el
    // despliegue ya tiene. Derivar es preferible a no cifrar, pero una
    // clave propia permite rotarla sin invalidar las firmas de URLs.
    const explicit = process.env.BACKUP_ENCRYPTION_KEY;
    if (explicit) {
        const key = Buffer.from(explicit, 'hex');
        if (key.length !== 32)
            throw new Error('BACKUP_ENCRYPTION_KEY debe ser de 32 bytes en hex (64 caracteres)');
        return key;
    }
    const base = process.env.EXP_SIGN_SECRET || process.env.EXP_SALT;
    if (!base) return null;
    return crypto.hkdfSync('sha256', Buffer.from(base), Buffer.alloc(0),
                           Buffer.from('expresart-backup:v1'), 32);
}

function encryptBackup(plain) {
    const key = _backupKey();
    if (!key) {
        console.warn('[BACKUP] AVISO: sin BACKUP_ENCRYPTION_KEY ni EXP_SIGN_SECRET — respaldo SIN cifrar.');
        return { buffer: plain, encrypted: false };
    }
    const iv     = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct     = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
        buffer: Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]),
        encrypted: true
    };
}

// Descifra si el archivo lleva la cabecera; si no, lo devuelve tal cual
// (respaldos creados antes de este cambio siguen siendo descargables).
function decryptBackup(buf) {
    if (buf.length < MAGIC.length + IV_LEN + TAG_LEN) return buf;
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return buf;

    const key = _backupKey();
    if (!key) throw new Error('Respaldo cifrado pero no hay clave para descifrarlo');

    const iv  = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
    const ct  = buf.subarray(MAGIC.length + IV_LEN + TAG_LEN);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

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
/* Versión 2 del formato: añade profiles, content y privacyMessages.
   La v1 guardaba users pero no profiles, así que los portafolios de los
   alumnos —el contenido central del sitio— quedaban fuera de la copia.
   Tampoco entraban el contenido editable de las páginas ni la bandeja de
   privacidad, que son registros con valor legal (LOPDP).
   El restaurador acepta ambas versiones. */
const SNAPSHOT_VERSION = 2;

async function buildSnapshot() {
    const [users, profiles, events, content, orders,
           bankInfo, shareLinks, resetRequests, privacyMessages] = await Promise.all([
        db.getUsers(),
        db.getAllProfiles(),
        db.getEvents(),
        db.getContent(),
        db.getOrders(),
        db.getBankInfo(),
        db.getShareLinks(),
        db.getResetRequests(),
        db.getPrivacyMessages(),
    ]);
    return {
        exportedAt: new Date().toISOString(),
        version: SNAPSHOT_VERSION,
        tables: {
            users, profiles, events, orders,
            content:  content  ? [content]  : [],
            bankInfo: bankInfo ? [bankInfo] : [],
            shareLinks, resetRequests, privacyMessages
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
    const now      = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `backup-${now}.json.gz`;
    console.log(`[BACKUP] Iniciando respaldo: ${filename}`);

    try {
        const snapshot   = await buildSnapshot();
        const compressed = zlib.gzipSync(JSON.stringify(snapshot));
        const { buffer, encrypted } = encryptBackup(compressed);
        const kb  = Math.round(buffer.length / 1024);
        const tag = encrypted ? 'cifrado' : 'SIN CIFRAR';

        if (USE_R2) {
            await uploadToR2(filename, buffer);
            console.log(`[BACKUP] ✓ Subido a R2: ${filename} — ${kb} KB, ${tag} (${Date.now() - started}ms)`);
            await _rotateR2();
        } else {
            /* Guardar en disco local si no hay R2 */
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            // mode 0600: solo el usuario del proceso puede leerlo
            fs.writeFileSync(path.join(BACKUP_DIR, filename), buffer, { mode: 0o600 });
            console.log(`[BACKUP] ✓ Guardado localmente: ${filename} — ${kb} KB, ${tag} (${Date.now() - started}ms)`);
            _rotateLocal();
        }

        return { ok: true, filename, sizeKb: kb, encrypted, storage: USE_R2 ? 'r2' : 'local' };
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
            .filter(o => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/.test(o.Key))
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
        .filter(f => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/.test(f))
        .sort().reverse()
        .map(f => {
            const stat = fs.statSync(path.join(BACKUP_DIR, f));
            return { filename: f, sizeKb: Math.round(stat.size / 1024), mtime: stat.mtime.toISOString() };
        });
}

/* ══════════════════════════════════════
   OBTENER STREAM PARA DESCARGA
   ══════════════════════════════════════ */
async function _toBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

// Devuelve el respaldo YA DESCIFRADO, listo para descargar como .json.gz.
// Se resuelve entero en memoria porque GCM solo puede verificar la etiqueta
// de autenticación con el archivo completo — y son de pocos MB.
async function getBackupStream(filename) {
    if (!/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/.test(filename)) return null;

    let raw;
    if (USE_R2) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        try {
            const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
            raw = await _toBuffer(res.Body);
        } catch { return null; }
    } else {
        const fp = path.join(BACKUP_DIR, filename);
        if (!fs.existsSync(fp)) return null;
        raw = fs.readFileSync(fp);
    }

    return Readable.from(decryptBackup(raw));
}

/* ── Rotar backups en R2 (elimina los que superan MAX_BACKUPS) ── */
async function _rotateR2() {
    const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET }));
    const all = (res.Contents || [])
        .filter(o => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/.test(o.Key))
        .sort((a, b) => a.Key.localeCompare(b.Key));
    while (all.length > MAX_BACKUPS) {
        const old = all.shift();
        await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: old.Key }));
        console.log(`[BACKUP] Eliminado respaldo antiguo de R2: ${old.Key}`);
    }
}

/* ── Rotar backups locales (solo sin R2) ── */
function _rotateLocal() {
    const all = fs.readdirSync(BACKUP_DIR)
        .filter(f => /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/.test(f))
        .sort();
    while (all.length > MAX_BACKUPS) {
        fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
    }
}

module.exports = {
    runBackup, listBackups, getBackupStream, USE_R2, R2_BUCKET,
    encryptBackup, decryptBackup   // exportadas para poder probarlas
};
