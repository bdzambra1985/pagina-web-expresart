'use strict';
require('dotenv').config();

const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const compression  = require('compression');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');

const db               = require('./db');
const { hashPassword } = require('./utils/crypto');
const { apiLimiter }   = require('./middleware/rateLimiter');
const { getSessionByRawToken } = require('./middleware/auth');
const { verifyViewPath }       = require('./utils/crypto');
const { USE_CLOUDINARY, UPLOADS_DIR } = require('./middleware/upload');
const { runBackup }    = require('./utils/backup');
const cron             = require('node-cron');

/* ── Route modules ── */
const authRoutes       = require('./routes/auth');
const userRoutes       = require('./routes/users');
const profileRoutes    = require('./routes/profiles');
const orderRoutes      = require('./routes/orders');
const contentRoutes    = require('./routes/content');
const shareLinkRoutes  = require('./routes/shareLinks');
const privacyRoutes    = require('./routes/privacy');

const app  = express();
const PORT = process.env.PORT || 9090;

/* ── Bootstrap admin user ── */
async function initAdmin() {
    // En producción EXP_ADMIN_PW es obligatoria: nunca usar una contraseña por defecto.
    if (process.env.NODE_ENV === 'production' && !process.env.EXP_ADMIN_PW) {
        throw new Error('EXP_ADMIN_PW no está definida — requerida en producción para crear/actualizar el admin.');
    }
    const pw      = process.env.EXP_ADMIN_PW || 'expresart2025';
    const existing = await db.getUserById('admin');
    if (!existing) {
        await db.createUser({
            userId: 'admin', username: 'admin',
            passwordHash: hashPassword(pw),
            role: 'admin', active: true, createdAt: new Date().toISOString()
        });
        console.log('  Usuario admin creado.');
    } else if (process.env.EXP_ADMIN_PW) {
        await db.updateUser('admin', { passwordHash: hashPassword(pw) });
        console.log('  Contraseña admin actualizada desde EXP_ADMIN_PW.');
    }
}

/* ── Remove stale sessions.json (contains hashed tokens from old disk-session era) ── */
function cleanupLegacyFiles() {
    const stale = path.join(db.DATA_DIR, 'sessions.json');
    if (fs.existsSync(stale)) {
        fs.unlinkSync(stale);
        console.log('  Eliminado sessions.json obsoleto (sesiones ahora en memoria).');
    }
}

/* ══════════════════
   MIDDLEWARE STACK
   ══════════════════ */
app.set('trust proxy', 1);

// HTTPS redirect in production
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https')
            return res.redirect(301, 'https://' + req.headers.host + req.url);
        next();
    });
}

app.use(cookieParser());
app.use(compression());

/* ── Block access to server-side source files via static serving ── */
app.use((req, res, next) => {
    const p = req.path;
    if (
        /^\/(data|routes|middleware|utils|sri|node_modules)(\/|$)/i.test(p) ||
        /^\/(db|server|migrate|package|package-lock)(\.js(on)?)?$/i.test(p) ||
        (p.startsWith('/.') && !p.startsWith('/.well-known/'))
    ) return res.status(403).end();
    next();
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'"],
            styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
            fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'https://unpkg.com'],
            imgSrc:         ["'self'", 'https://res.cloudinary.com', 'https://img.youtube.com', 'data:', 'blob:'],
            connectSrc:     ["'self'", 'https://unpkg.com'],
            frameSrc:       ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
            frameAncestors: ["'none'"],
            baseUri:        ["'self'"],
            formAction:     ["'self'"],
            scriptSrcAttr:  ["'none'"],
        }
    },
    frameguard:              { action: 'deny' },
    crossOriginEmbedderPolicy: false
}));

// Permissions-Policy: deshabilitar APIs de hardware no necesarias
app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
});

app.use(apiLimiter);
app.use(express.json({
    limit: '1mb',
    // Guarda el body crudo: lo necesita la verificación de firma del
    // webhook de Resend (routes/privacy.js), que rompe si se recalcula
    // sobre el JSON ya parseado/re-serializado.
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/* ── Static files ── */
const ONE_WEEK = 7 * 24 * 60 * 60;
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// TWA / PWA: assetlinks.json en /.well-known/ — requerido para Trusted Web Activity
// El SHA256 se actualiza cuando se genera el APK con bubblewrap/PWABuilder
const _assetlinks = [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
        namespace: 'android_app',
        package_name: process.env.TWA_PACKAGE || 'ec.expresart.app',
        sha256_cert_fingerprints: (process.env.TWA_SHA256 || 'PLACEHOLDER').split(',')
    }
}];
app.get('/.well-known/assetlinks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(_assetlinks);
});
app.use(express.static(__dirname, {
    setHeaders(res, filePath) {
        if (/\.js$/.test(filePath))
            // no-cache: el navegador revalida con ETag antes de usar la copia local
            // Evita servir JS stale que impide cargar imágenes correctamente
            res.setHeader('Cache-Control', 'no-cache');
        else if (/\.(css|png|jpg|jpeg|webp|gif|ico|woff2?)$/.test(filePath))
            res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}`);
        else if (filePath.endsWith('.html'))
            res.setHeader('Cache-Control', 'no-cache');
    }
}));

/* ── Protected uploads: accept session cookie (admin) OR signed view token ── */
app.use('/uploads/receipts', (req, res, next) => {
    const cookieTok = req.cookies?.exp_session;
    if (cookieTok && getSessionByRawToken(cookieTok)) return next();

    const sv           = req.query.sv;
    const resourcePath = '/uploads/receipts' + req.path;
    if (sv && verifyViewPath(resourcePath, sv)) return next();

    res.status(401).send(
        '<!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;padding:40px">' +
        '<h2>Acceso no autorizado</h2><p><a href="/login.html">Iniciar sesión</a></p></body></html>'
    );
});
app.use('/uploads', require('express').static(UPLOADS_DIR, {
    setHeaders(res) { res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}`); }
}));

/* ══════════════════
   API ROUTES
   ══════════════════ */
app.use('/api', authRoutes);
app.use('/api', profileRoutes);
app.use('/api', orderRoutes);
app.use('/api', contentRoutes);
app.use('/api', privacyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/share-links', shareLinkRoutes);

/* ── Factura/comprobante accesible sin prefijo /api ── */
app.use('/', orderRoutes);

/* ── 404 catch-all ── */
app.use((req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/'))
        return res.redirect('/');
    res.status(404).json({ ok: false, message: 'No encontrado' });
});

/* ══════════════════
   STARTUP
   ══════════════════ */
(async () => {
    try {
        await db.initDB();
        cleanupLegacyFiles();
        await initAdmin();
        /* ── Respaldo diario a las 02:00 (hora del servidor) ── */
        cron.schedule('0 2 * * *', () => runBackup(), { timezone: 'America/Guayaquil' });
        console.log('  Respaldo automático: diario a las 02:00 (Guayaquil)');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n  EXPRESART server en puerto ${PORT}`);
            console.log(`  DB: ${db.USE_DB ? 'PostgreSQL' : 'JSON files'}`);
            console.log(`  Cloudinary: ${USE_CLOUDINARY ? 'habilitado' : 'deshabilitado'}\n`);
        });
    } catch (e) {
        console.error('Startup error:', e);
        process.exit(1);
    }
})();
