'use strict';
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const sharp      = require('sharp');
const cloudinary = require('cloudinary').v2;

/* ── Cloudinary (optional) ── */
const CLD_NAME   = process.env.CLOUDINARY_NAME   || process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_KEY    || process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET;
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_URL || (CLD_NAME && CLD_KEY && CLD_SECRET));

if (USE_CLOUDINARY) {
    if (process.env.CLOUDINARY_URL)
        cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
    else
        cloudinary.config({ cloud_name: CLD_NAME, api_key: CLD_KEY, api_secret: CLD_SECRET });
}

/* ── Local storage ── */
const UPLOADS_DIR  = path.join(__dirname, '..', 'uploads');
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);

/* ── Magic-byte MIME detection (prevents extension spoofing) ── */
const MAGIC = [
    { mime: 'image/jpeg',      check: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
    { mime: 'image/png',       check: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
    { mime: 'image/webp',      check: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
    { mime: 'image/gif',       check: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
    { mime: 'application/pdf', check: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
];
const ALLOWED_MIMES_IMAGE   = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_MIMES_RECEIPT = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

function detectMime(buffer) {
    if (!buffer || buffer.length < 4) return null;
    for (const { mime, check } of MAGIC) {
        if (check(buffer)) return mime;
    }
    return null;
}

/* ── Image compression ── */
const MAX_DIM     = 2000;  // px — máxima dimensión (ancho o alto)
const IMG_QUALITY = 85;    // calidad JPEG/WebP

async function compressImage(buffer, mime) {
    // GIFs se pasan tal cual (pueden ser animados)
    if (mime === 'image/gif') return { buffer, ext: '.gif' };

    const pipeline = sharp(buffer)
        .rotate()                            // corrige orientación EXIF automáticamente
        .resize({
            width:             MAX_DIM,
            height:            MAX_DIM,
            fit:               'inside',     // mantiene proporción
            withoutEnlargement: true         // no agranda imágenes pequeñas
        });

    let compressed, ext;
    if (mime === 'image/webp') {
        compressed = await pipeline.webp({ quality: IMG_QUALITY }).toBuffer();
        ext = '.webp';
    } else {
        // JPEG y PNG → JPEG (fotos en PNG son innecesariamente grandes)
        compressed = await pipeline.jpeg({ quality: IMG_QUALITY, progressive: true }).toBuffer();
        ext = '.jpg';
    }

    const before = Math.round(buffer.length / 1024);
    const after  = Math.round(compressed.length / 1024);
    console.log(`  [IMG] ${before}KB → ${after}KB (ahorro: ${Math.round((1 - after/before)*100)}%)`);

    return { buffer: compressed, ext };
}

/* ── Multer instance (memory storage, 15 MB limit) ── */
const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, ALLOWED_EXTS.has(path.extname(file.originalname).toLowerCase()));
    }
});

/* ── File save (Cloudinary or local disk) ──
   opts.compress = true → comprime la imagen antes de guardar
*/
async function saveFile(buffer, originalname, userId, { compress = false } = {}) {
    let outBuffer = buffer;
    let ext = path.extname(originalname).toLowerCase() || '.jpg';

    if (compress) {
        const mime = detectMime(buffer);
        if (mime && ALLOWED_MIMES_IMAGE.has(mime)) {
            const result = await compressImage(buffer, mime);
            outBuffer = result.buffer;
            ext       = result.ext;
        }
    }

    if (USE_CLOUDINARY) {
        return new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                { folder: 'expresart/' + userId },
                (err, result) => {
                    if (err) return reject(new Error(err.message || JSON.stringify(err)));
                    resolve(result.secure_url);
                }
            ).end(outBuffer);
        });
    }
    const dest     = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const filename = 'foto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    fs.writeFileSync(path.join(dest, filename), outBuffer);
    return '/uploads/' + userId + '/' + filename;
}

module.exports = {
    USE_CLOUDINARY, UPLOADS_DIR, cloudinary,
    uploader, saveFile,
    detectMime, ALLOWED_MIMES_IMAGE, ALLOWED_MIMES_RECEIPT
};
