require('dotenv').config();
const express     = require('express');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const cloudinary  = require('cloudinary').v2;
const { emitirFactura, getSRIConfig, getP12 } = require('./sri/index');
const db          = require('./db');

const app  = express();
const PORT = process.env.PORT || 9090;

/* ── Cloudinary ── */
const CLD_NAME   = process.env.CLOUDINARY_NAME   || process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_KEY    || process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_SECRET || process.env.CLOUDINARY_API_SECRET;
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_URL || (CLD_NAME && CLD_KEY && CLD_SECRET));
if (USE_CLOUDINARY) {
    if (process.env.CLOUDINARY_URL) {
        cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
    } else {
        cloudinary.config({ cloud_name: CLD_NAME, api_key: CLD_KEY, api_secret: CLD_SECRET });
    }
}

/* ── Contraseñas ── */
const DATA_DIR  = db.DATA_DIR;
const SALT_FILE = path.join(DATA_DIR, '.salt');
function getPwSalt() {
    if (process.env.EXP_SALT) return process.env.EXP_SALT;
    if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE, 'utf8').trim();
    const salt = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
    console.warn('  WARN: EXP_SALT no definido. Salt generado en data/.salt');
    return salt;
}
const PW_SALT = getPwSalt();
function hashPassword(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, 100000, 64, 'sha256').toString('hex');
}
function verifyPassword(pw, hash) {
    try {
        return crypto.timingSafeEqual(Buffer.from(hashPassword(pw), 'hex'), Buffer.from(hash, 'hex'));
    } catch { return false; }
}

/* ── Escape HTML ── */
function htmlEncode(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/* ── Helpers de perfil vacío ── */
const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: []
});

/* ── Rate limiting ── */
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
    message: { ok: false, message: 'Demasiados intentos. Intenta en 15 minutos.' }
});
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, max: 120,
    standardHeaders: true, legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/')
});

/* ── Admin inicial ── */
async function initAdmin() {
    const pw       = process.env.EXP_ADMIN_PW || 'expresart2025';
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

/* ══════════════════════════════════════════
   SESIONES — in-memory (sin persistencia en disco)
   ══════════════════════════════════════════ */
const SESSION_TTL = 1 * 60 * 60 * 1000;
const SHARE_TTL   = 24 * 60 * 60 * 1000;

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

const sessions = new Map();

function getSession(req) {
    const rawToken = req.headers['x-session-token'];
    if (!rawToken) return null;
    const key  = tokenHash(rawToken);
    const sess = sessions.get(key);
    if (!sess) return null;
    const expiry = sess.expiresAt || (sess.ts + SESSION_TTL);
    if (Date.now() >= expiry) { sessions.delete(key); return null; }
    if (!sess.expiresAt) sess.ts = Date.now();
    return sess;
}
function getSessionByRawToken(rawToken) {
    if (!rawToken) return null;
    const sess = sessions.get(tokenHash(rawToken));
    if (!sess) return null;
    const expiry = sess.expiresAt || (sess.ts + SESSION_TTL);
    if (Date.now() >= expiry) return null;
    return sess;
}
function requireAuth(req, res) {
    const sess = getSession(req);
    if (!sess) { res.status(401).json({ ok: false, message: 'No autorizado' }); return null; }
    return sess;
}
function requireAdmin(req, res) {
    const sess = requireAuth(req, res);
    if (!sess) return null;
    if (sess.role !== 'admin') { res.status(403).json({ ok: false, message: 'Solo administradores' }); return null; }
    return sess;
}
function revokeUserSessions(userId) {
    for (const [k, v] of sessions) {
        if (v.userId === userId) sessions.delete(k);
    }
}

/* ══════════════════════════════════════════
   LOCKOUT POR USUARIO
   ══════════════════════════════════════════ */
const loginAttempts   = new Map();
const LOGIN_MAX_TRIES = 5;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;

/* ══════════════════════════════════════════
   VALIDACIÓN MAGIC BYTES
   ══════════════════════════════════════════ */
const MAGIC = [
    { mime: 'image/jpeg',      check: b => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF },
    { mime: 'image/png',       check: b => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47 },
    { mime: 'image/webp',      check: b => b.length>=12 && b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50 },
    { mime: 'image/gif',       check: b => b[0]===0x47 && b[1]===0x49 && b[2]===0x46 },
    { mime: 'application/pdf', check: b => b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46 },
];
const ALLOWED_MIMES_IMAGE   = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const ALLOWED_MIMES_RECEIPT = new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf']);
function detectMime(buffer) {
    if (!buffer || buffer.length < 4) return null;
    for (const { mime, check } of MAGIC) { if (check(buffer)) return mime; }
    return null;
}

/* ── Multer + Cloudinary ── */
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const ALLOWED_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.pdf']);
const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        cb(null, ALLOWED_EXTS.has(path.extname(file.originalname).toLowerCase()));
    }
});
async function saveFile(buffer, originalname, userId) {
    if (USE_CLOUDINARY) {
        return new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                { folder: 'expresart/' + userId },
                (err, result) => {
                    if (err) return reject(new Error(err.message || JSON.stringify(err)));
                    resolve(result.secure_url);
                }
            ).end(buffer);
        });
    }
    const dest = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const ext      = path.extname(originalname).toLowerCase();
    const filename = 'foto-' + Date.now() + ext;
    fs.writeFileSync(path.join(dest, filename), buffer);
    return '/uploads/' + userId + '/' + filename;
}

/* ══════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════ */
app.set('trust proxy', 1);

if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https')
            return res.redirect(301, 'https://' + req.headers.host + req.url);
        next();
    });
}

app.use(compression());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'"],
            styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
            fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'https://unpkg.com'],
            imgSrc:         ["'self'", 'https://res.cloudinary.com', 'https://img.youtube.com', 'data:', 'blob:'],
            connectSrc:     ["'self'"],
            frameSrc:       ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
            frameAncestors: ["'none'"],
            baseUri:        ["'self'"],
            formAction:     ["'self'"],
            scriptSrcAttr:  ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.use(apiLimiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const ONE_WEEK = 7 * 24 * 60 * 60;
app.use(express.static(__dirname, {
    setHeaders(res, filePath) {
        if (/\.(css|js|png|jpg|jpeg|webp|gif|ico|woff2?)$/.test(filePath))
            res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}, stale-while-revalidate=86400`);
        else if (filePath.endsWith('.html'))
            res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.use('/uploads/receipts', (req, res, next) => {
    const rawTok = req.query.t || req.headers['x-session-token'];
    if (!rawTok) return res.status(401).send('<!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;padding:40px"><h2>Acceso no autorizado</h2><p><a href="/login.html">Iniciar sesión</a></p></body></html>');
    const sess = getSessionByRawToken(rawTok);
    if (!sess) return res.status(401).send('<!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;padding:40px"><h2>Sesión inválida o expirada</h2><p><a href="/login.html">Iniciar sesión</a></p></body></html>');
    next();
});
app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders(res) { res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}`); }
}));

/* ══════════════════════════════════════════
   AUTENTICACIÓN
   ══════════════════════════════════════════ */
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });

        const uname = username.trim().toLowerCase();
        const att   = loginAttempts.get(uname) || { count: 0, lockedUntil: 0 };
        if (Date.now() < att.lockedUntil)
            return res.status(429).json({ ok: false, message: 'Cuenta bloqueada temporalmente. Intenta en 15 minutos.' });

        const user = await db.getUserByUsername(username.trim());
        if (!user || !verifyPassword(password, user.passwordHash)) {
            att.count++;
            if (att.count >= LOGIN_MAX_TRIES) { att.lockedUntil = Date.now() + LOGIN_LOCK_MS; att.count = 0; }
            loginAttempts.set(uname, att);
            return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
        }
        if (!user.active)
            return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });

        loginAttempts.delete(uname);
        const token = newToken();
        sessions.set(tokenHash(token), { ts: Date.now(), userId: user.userId, role: user.role });
        res.json({ ok: true, token, role: user.role, mustChangePassword: !!user.mustChangePassword });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/logout', (req, res) => {
    const rawToken = req.headers['x-session-token'];
    if (rawToken) sessions.delete(tokenHash(rawToken));
    res.json({ ok: true });
});

app.post('/api/change-password', async (req, res) => {
    try {
        const sess = getSession(req);
        if (!sess) return res.status(401).json({ ok: false, message: 'No autenticado' });
        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string')
            return res.status(400).json({ ok: false, message: 'Nueva contraseña requerida' });
        if (newPassword.length < 8)
            return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });
        const user = await db.getUserById(sess.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        await db.updateUser(sess.userId, { passwordHash: hashPassword(newPassword), mustChangePassword: false });
        revokeUserSessions(sess.userId);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/auth', async (req, res) => {
    try {
        const sess = getSession(req);
        if (!sess) return res.json({ ok: false });
        const profile = sess.role === 'alumno' ? (await db.getProfile(sess.userId) || {}) : {};
        res.json({
            ok: true, userId: sess.userId, role: sess.role,
            displayName: profile.displayName || '',
            photoUrl:    profile.photoUrl    || ''
        });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   PERFILES PÚBLICOS
   ══════════════════════════════════════════ */
app.get('/api/profiles', async (req, res) => {
    try {
        const users = await db.getUsers();
        const results = [];
        for (const u of users) {
            if (u.role !== 'alumno' || !u.active) continue;
            const p = await db.getProfile(u.userId) || {};
            if (p.portfolioActive === false) continue;
            results.push({
                userId:         u.userId,
                displayName:    p.displayName    || u.username,
                bio_short:      p.bio_short      || '',
                especialidades: p.especialidades || [],
                photoUrl:       p.photoUrl       || '',
                producciones:   (p.producciones  || []).length,
                videos:         (p.videos        || []).length
            });
        }
        res.json(results);
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/profile/:userId', async (req, res) => {
    try {
        const user = await db.getUserById(req.params.userId);
        if (!user || !user.active || user.role !== 'alumno')
            return res.status(404).json({ ok: false, message: 'Perfil no encontrado' });
        const profile = await db.getProfile(user.userId) || {};
        if (profile.portfolioActive === false)
            return res.status(404).json({ ok: false, message: 'Portafolio no disponible' });
        res.json({ ok: true, profile });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   MI PERFIL (alumno autenticado)
   ══════════════════════════════════════════ */
app.get('/api/my-profile', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        res.json({ ok: true, profile: await db.getProfile(sess.userId) || emptyProfile(sess.userId) });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/my-profile', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const current = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
        ['displayName','bio','bio_short','especialidades','producciones','videos','portfolioActive'].forEach(k => {
            if (req.body[k] !== undefined) current[k] = req.body[k];
        });
        await db.upsertProfile(sess.userId, current);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/upload-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes (JPEG, PNG, WebP, GIF)' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId);
            const p   = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
            p.photoUrl = url;
            await db.upsertProfile(sess.userId, p);
            res.json({ ok: true, url });
        } catch(e) { console.error('upload-photo error:', e); res.status(500).json({ ok: false, message: 'Error al guardar imagen' }); }
    });
});

app.post('/api/upload-prod-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes (JPEG, PNG, WebP, GIF)' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId);
            res.json({ ok: true, url });
        } catch(e) { console.error('upload-prod-photo error:', e.message); res.status(500).json({ ok: false, message: 'Error al guardar imagen' }); }
    });
});

app.post('/api/add-video', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const { url, title } = req.body;
        if (!url) return res.status(400).json({ ok: false, message: 'URL requerida' });
        const p = await db.getProfile(sess.userId) || emptyProfile(sess.userId);
        if (!p.videos) p.videos = [];
        p.videos.push({ url, title: title || '' });
        await db.upsertProfile(sess.userId, p);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.delete('/api/video/:idx', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const p   = await db.getProfile(sess.userId);
        const idx = parseInt(req.params.idx);
        if (!p || !p.videos || isNaN(idx) || idx < 0 || idx >= p.videos.length)
            return res.status(400).json({ ok: false, message: 'Índice inválido' });
        p.videos.splice(idx, 1);
        await db.upsertProfile(sess.userId, p);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   GESTIÓN DE USUARIOS (admin)
   ══════════════════════════════════════════ */
app.get('/api/users', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const users = await db.getUsers();
        res.json(users.map(u => ({
            userId: u.userId, username: u.username,
            role: u.role, active: u.active, createdAt: u.createdAt
        })));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/users', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { username, password, displayName } = req.body;
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
        if (username.trim().length < 3 || username.trim().length > 40)
            return res.status(400).json({ ok: false, message: 'Usuario debe tener entre 3 y 40 caracteres' });
        if (password.length < 8)
            return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });
        if (await db.getUserByUsername(username.trim()))
            return res.status(409).json({ ok: false, message: 'Ese nombre de usuario ya existe' });
        const userId = 'alu_' + Date.now();
        await db.createUser({ userId, username: username.trim(), passwordHash: hashPassword(password), role: 'alumno', active: true, mustChangePassword: true, createdAt: new Date().toISOString() });
        await db.upsertProfile(userId, { ...emptyProfile(userId), displayName: displayName || username.trim() });
        res.json({ ok: true, userId });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.put('/api/users/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede modificar el admin' });
        const fields = {};
        if (req.body.active !== undefined) fields.active = Boolean(req.body.active);
        if (req.body.password) fields.passwordHash = hashPassword(req.body.password);
        await db.updateUser(req.params.userId, fields);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.delete('/api/users/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede eliminar el admin' });
        const userId = user.userId;
        revokeUserSessions(userId);
        await db.deleteUser(userId); // cascade borra el profile en PostgreSQL
        if (!db.USE_DB) await db.deleteProfile(userId); // JSON: borrar manualmente
        if (USE_CLOUDINARY) {
            cloudinary.api.delete_resources_by_prefix('expresart/' + userId + '/')
                .then(() => cloudinary.api.delete_folder('expresart/' + userId))
                .catch(() => {});
        } else {
            const uploadDir = path.join(UPLOADS_DIR, userId);
            if (fs.existsSync(uploadDir)) {
                fs.readdirSync(uploadDir).forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
                fs.rmdirSync(uploadDir);
            }
        }
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/users/:userId/reset-password', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const user = await db.getUserById(req.params.userId);
        if (!user) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
        if (user.role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede resetear el admin' });
        const tempPassword = randomAlphaNum(10);
        await db.updateUser(user.userId, { passwordHash: hashPassword(tempPassword), mustChangePassword: true });
        revokeUserSessions(user.userId);
        await db.markResetRequestDone(user.userId);
        res.json({ ok: true, tempPassword });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

const resetRequestLimiter = rateLimit({ windowMs: 60*60*1000, max: 5, standardHeaders: true, legacyHeaders: false });
app.post('/api/reset-request', resetRequestLimiter, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username || typeof username !== 'string')
            return res.status(400).json({ ok: false, message: 'Usuario requerido' });
        const user = await db.getUserByUsername(username.trim());
        if (!user || user.role === 'admin') return res.json({ ok: true });
        await db.createResetRequest({
            id: 'rr_' + Date.now(), userId: user.userId, username: user.username,
            requestedAt: new Date().toISOString(), status: 'pending'
        });
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/reset-requests', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json(await db.getResetRequests());
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.delete('/api/reset-requests/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        await db.dismissResetRequest(req.params.id);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   EVENTOS
   ══════════════════════════════════════════ */
app.get('/api/events', async (req, res) => {
    try {
        res.json((await db.getEvents()).sort((a, b) => a.date.localeCompare(b.date)));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

const VALID_CATEGORIES = new Set(['obra','taller','audicion','otro']);
const VALID_AUDIENCES  = new Set(['publico','alumnos']);

app.post('/api/events', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { title, date, time, location, description, category, audience } = req.body;
        if (!title || !date || typeof title !== 'string' || typeof date !== 'string')
            return res.status(400).json({ ok: false, message: 'Título y fecha son requeridos' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
            return res.status(400).json({ ok: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
        const event = {
            id: 'evt_' + Date.now(),
            title:       title.trim().slice(0, 200),
            date:        date.trim(),
            time:        (time        || '').slice(0, 10),
            location:    (location    || '').slice(0, 200),
            description: (description || '').slice(0, 1000),
            category:    VALID_CATEGORIES.has(category) ? category : 'otro',
            audience:    VALID_AUDIENCES.has(audience)  ? audience : 'publico',
            createdAt:   new Date().toISOString()
        };
        await db.createEvent(event);
        res.json({ ok: true, event });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.put('/api/events/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { title, date, time, location, description, category, audience } = req.body;
        const fields = {};
        if (title       !== undefined) fields.title       = title;
        if (date        !== undefined) fields.date        = date;
        if (time        !== undefined) fields.time        = time;
        if (location    !== undefined) fields.location    = location;
        if (description !== undefined) fields.description = description;
        if (category    !== undefined) fields.category    = VALID_CATEGORIES.has(category) ? category : 'otro';
        if (audience    !== undefined) fields.audience    = VALID_AUDIENCES.has(audience)  ? audience : 'publico';
        const ok = await db.updateEvent(req.params.id, fields);
        if (!ok) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.delete('/api/events/:id', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        await db.deleteEvent(req.params.id);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   CONTENIDO GLOBAL (admin)
   ══════════════════════════════════════════ */
app.get('/api/content', async (req, res) => {
    try { res.json(await db.getContent()); }
    catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/content', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { section, data } = req.body;
        await db.saveContentSection(section, data);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const mime = detectMime(req.file.buffer);
        if (!mime || !ALLOWED_MIMES_IMAGE.has(mime))
            return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, 'admin');
            await db.saveContentPhoto(url);
            res.json({ ok: true, url });
        } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error al subir imagen' }); }
    });
});

/* ══════════════════════════════════════════
   PAGOS / TRANSFERENCIAS
   ══════════════════════════════════════════ */
function seqFromInvoice(inv) {
    return parseInt((inv || '001-001-000000000').split('-').pop(), 10) || 0;
}
function invoiceFromSeq(n) {
    return '001-001-' + String(n).padStart(9, '0');
}

async function emitirConAutoRetry(orderSnap, startSecuencial, maxAttempts = 15) {
    let seq = seqFromInvoice(startSecuencial);
    let result;
    for (let i = 0; i < maxAttempts; i++) {
        const inv = invoiceFromSeq(seq);
        result = await emitirFactura(orderSnap, inv);
        if (result.ok) return { result, invoiceNumber: inv };
        if (!result.error || !result.error.includes('SECUENCIAL REGISTRADO'))
            return { result, invoiceNumber: inv };
        console.log(`Secuencial ${inv} ya registrado en SRI, probando ${invoiceFromSeq(seq+1)}…`);
        seq++;
    }
    return { result, invoiceNumber: invoiceFromSeq(seq) };
}

function generateComprobanteHTML(order, info) {
    const fecha = new Date(order.confirmedAt).toLocaleDateString('es-EC',
        { timeZone:'America/Guayaquil', year:'numeric', month:'long', day:'numeric' });
    const sri = order.sri || {};
    const sriBlock = sri.status === 'autorizado' ? `
<div class="section">
  <h3>Factura Electrónica — SRI</h3>
  <p><strong>Clave de acceso:</strong> <span style="font-size:0.78em;word-break:break-all;font-family:monospace">${htmlEncode(sri.claveAcceso||'')}</span></p>
  <p><strong>Número de autorización:</strong> ${htmlEncode(sri.numeroAutorizacion||'')}</p>
  <p><strong>Fecha autorización:</strong> ${htmlEncode(sri.fechaAutorizacion||'')}</p>
</div>` : '';
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Comprobante ${htmlEncode(order.invoiceNumber||'')}</title>
<style>
body{font-family:Arial,sans-serif;color:#222;max-width:780px;margin:40px auto;padding:0 20px}
h1{color:#8b0000;border-bottom:2px solid #8b0000;padding-bottom:8px}
h3{color:#555;margin:0 0 8px}
.section{margin:20px 0;padding:16px;border:1px solid #ddd;border-radius:6px}
table{width:100%;border-collapse:collapse}
td,th{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}
th{background:#f5f5f5;font-size:0.82em;text-transform:uppercase;letter-spacing:1px}
.totals td{border-bottom:none;padding:4px 10px}
.total-final td{font-weight:bold;font-size:1.05em;border-top:2px solid #222;padding-top:10px}
.footer{margin-top:40px;font-size:0.78em;color:#888;text-align:center}
</style></head><body>
<h1>EXPRESART — Comprobante de Pago</h1>
<div class="section">
  <table>
    <tr><td><strong>No. Comprobante</strong></td><td>${htmlEncode(order.invoiceNumber||'')}</td></tr>
    <tr><td><strong>Fecha</strong></td><td>${fecha}</td></tr>
    <tr><td><strong>Estado</strong></td><td>✅ Pago confirmado</td></tr>
  </table>
</div>
<div class="section">
  <h3>Datos del cliente</h3>
  <table>
    <tr><td><strong>Nombre</strong></td><td>${htmlEncode(order.customerName)}</td></tr>
    <tr><td><strong>Documento</strong></td><td>${htmlEncode(order.customerDoc)}</td></tr>
    <tr><td><strong>Email</strong></td><td>${htmlEncode(order.customerEmail)}</td></tr>
  </table>
</div>
<div class="section">
  <h3>Detalle del pago</h3>
  <table>
    <thead><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr></thead>
    <tbody>
      <tr><td>${htmlEncode(order.concept)}</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
    </tbody>
  </table>
</div>
<div class="section">
  <table class="totals">
    <tr><td style="color:#666">Subtotal (tarifa ${order.ivaRate||15}% IVA)</td><td style="text-align:right">$${order.subtotal.toFixed(2)}</td></tr>
    <tr><td style="color:#666">IVA ${order.ivaRate||15}%</td><td style="text-align:right">$${order.iva.toFixed(2)}</td></tr>
    <tr class="total-final"><td>TOTAL PAGADO</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
  </table>
</div>
<div class="section">
  <h3>Forma de pago</h3>
  <p>Transferencia bancaria · <strong>${htmlEncode(info.bankName||'')}</strong> · ${htmlEncode(info.accountType||'')} No. <strong>${htmlEncode(info.accountNumber||'')}</strong></p>
</div>
${sriBlock}
<div class="footer">
  <p>Este comprobante es un documento de respaldo de pago.</p>
  <p>La factura electrónica autorizada por el SRI ha sido registrada con los datos indicados.</p>
  <p><strong>EXPRESART — Escuela de Actuación · Donde el Arte Cobra Vida</strong></p>
</div>
</body></html>`;
}

app.get('/api/bank-info', async (req, res) => {
    try { res.json(await db.getBankInfo()); }
    catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/bank-info', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services } = req.body;
        await db.saveBankInfo({ bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services: services || [] });
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/orders', (req, res) => {
    uploader.single('receipt')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        try {
            const { customerName, customerDoc, customerEmail, concept, amount, notes, paymentMonth } = req.body;
            if (!customerName || !customerDoc || !customerEmail || !concept || !amount)
                return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos' });
            const amountNum = parseFloat(amount);
            if (isNaN(amountNum) || amountNum <= 0)
                return res.status(400).json({ ok: false, message: 'Monto inválido' });
            if (req.file) {
                const mime = detectMime(req.file.buffer);
                if (!mime || !ALLOWED_MIMES_RECEIPT.has(mime))
                    return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes o PDF como comprobante' });
            }
            const receiptUrl = req.file ? await saveFile(req.file.buffer, req.file.originalname, 'receipts') : '';
            const subtotal = Math.round((amountNum / 1.15) * 100) / 100;
            const iva      = Math.round((amountNum - subtotal) * 100) / 100;
            let linkedUserId = null;
            const rawSessTok = req.headers['x-session-token'] || req.body.sessionToken;
            if (rawSessTok) {
                const sess = sessions.get(tokenHash(rawSessTok));
                if (sess && sess.role === 'alumno') linkedUserId = sess.userId;
            }
            const order = {
                id: 'ord_' + Date.now(), token: crypto.randomBytes(16).toString('hex'),
                status: 'pendiente', userId: linkedUserId,
                customerName: customerName.trim().slice(0, 200),
                customerDoc:  customerDoc.trim().slice(0, 20),
                customerEmail: customerEmail.trim().slice(0, 200),
                concept: concept.trim().slice(0, 300),
                amount: amountNum, subtotal, iva, ivaRate: 15,
                receiptUrl, notes: (notes || '').trim().slice(0, 500),
                paymentMonth: /^\d{4}-\d{2}$/.test(paymentMonth || '') ? paymentMonth : null,
                invoiceNumber: null, rejectionReason: '',
                createdAt: new Date().toISOString(), confirmedAt: null
            };
            await db.createOrder(order);
            res.json({ ok: true, orderId: order.id, token: order.token });
        } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
    });
});

app.get('/api/orders', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json((await db.getOrders()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/my-orders', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        res.json(await db.getOrdersByUser(sess.userId));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/orders/by-user/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json(await db.getOrdersByUser(req.params.userId));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.put('/api/orders/:id/confirm', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        if (order.status === 'confirmado') return res.json({ ok: true, invoiceNumber: order.invoiceNumber });
        const invoiceNumber = await db.nextInvoiceNumber();
        const confirmedAt   = new Date().toISOString();
        await db.updateOrder(req.params.id, { status: 'confirmado', invoiceNumber, confirmedAt });
        res.json({ ok: true, invoiceNumber });

        const orderId   = req.params.id;
        const orderSnap = { ...order, status: 'confirmado', invoiceNumber, confirmedAt };
        setImmediate(async () => {
            try {
                if (!getSRIConfig().ruc) return;
                const { result, invoiceNumber: usedInv } = await emitirConAutoRetry(orderSnap, invoiceNumber);
                const sriData = result.ok
                    ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                    : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
                const fields = { sri: sriData };
                if (usedInv !== invoiceNumber) fields.invoiceNumber = usedInv;
                if (!result.ok) console.error('SRI error completo:', JSON.stringify(result));
                await db.updateOrder(orderId, fields);
            } catch(e) {
                console.error('SRI error en confirm:', e.message);
                await db.updateOrder(orderId, { sri: { status: 'error', error: e.message } });
            }
        });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/orders/:id/sri-retry', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        if (order.status !== 'confirmado') return res.status(400).json({ ok: false, message: 'Solo se puede reintentar en órdenes confirmadas' });

        const startSeq      = invoiceFromSeq(seqFromInvoice(order.invoiceNumber) + 1);
        await db.updateOrder(req.params.id, { invoiceNumber: startSeq });
        res.json({ ok: true, message: 'Reintento iniciado' });

        const orderId   = req.params.id;
        const orderSnap = { ...order, invoiceNumber: startSeq, confirmedAt: new Date().toISOString() };
        setImmediate(async () => {
            try {
                const { result, invoiceNumber: usedInv } = await emitirConAutoRetry(orderSnap, startSeq);
                const sriData = result.ok
                    ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                    : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
                const fields = { sri: sriData };
                if (usedInv !== startSeq) fields.invoiceNumber = usedInv;
                await db.updateOrder(orderId, fields);
            } catch(e) {
                await db.updateOrder(orderId, { sri: { status: 'error', error: e.message } });
            }
        });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/p12-upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    uploader.single('p12')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió el archivo' });
        const dest = path.join(DATA_DIR, '.p12');
        fs.writeFileSync(dest, req.file.buffer, { mode: 0o600 });
        res.json({ ok: true, message: 'Certificado .p12 guardado correctamente' });
    });
});

app.put('/api/orders/:id/reject', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        await db.updateOrder(req.params.id, {
            status: 'rechazado',
            rejectionReason: (req.body.reason || '').trim().slice(0, 300)
        });
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/factura/:id', async (req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).send('<h2>Comprobante no encontrado</h2>');
        let sess = getSession(req);
        if (!sess && req.query.t) sess = getSessionByRawToken(req.query.t);
        const isAdmin = sess && sess.role === 'admin';
        if (!isAdmin && req.query.token !== order.token)
            return res.status(403).send('<h2>Acceso no autorizado</h2>');
        if (order.status !== 'confirmado')
            return res.status(400).send('<h2>El pago aún no ha sido confirmado por EXPRESART.</h2>');
        const info = await db.getBankInfo();
        res.send(generateComprobanteHTML(order, info));
    } catch(e) { console.error(e); res.status(500).send('<h2>Error interno</h2>'); }
});

/* ══════════════════════════════════════════
   ENLACES PRIVADOS DE PORTAFOLIO
   ══════════════════════════════════════════ */
app.get('/api/share-links/:shareId/info', async (req, res) => {
    try {
        const link = await db.getShareLink(req.params.shareId);
        if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido o inactivo' });
        res.json({ ok: true, userId: link.userId });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/share-links/:shareId/auth', loginLimiter, async (req, res) => {
    try {
        const { password } = req.body || {};
        if (!password) return res.status(400).json({ ok: false, message: 'Contraseña requerida' });
        const link = await db.getShareLink(req.params.shareId);
        if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido' });
        if (!verifyPassword(password, link.passwordHash))
            return res.status(401).json({ ok: false, message: 'Contraseña incorrecta' });
        const token     = newToken();
        const expiresAt = Date.now() + SHARE_TTL;
        sessions.set(tokenHash(token), { role: 'share', shareId: req.params.shareId, userId: link.userId, ts: Date.now(), expiresAt });
        res.json({ ok: true, userId: link.userId, token, expiresAt });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.post('/api/share-links', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const { label } = req.body || {};
        const shareId  = randomAlphaNum(10);
        const password = randomAlphaNum(8);
        await db.createShareLink({
            shareId, userId: sess.userId, passwordHash: hashPassword(password),
            label: String(label || '').trim().slice(0, 80),
            active: true, createdAt: new Date().toISOString()
        });
        const base = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
        res.json({ ok: true, shareId, password, url: base + '/portafolio-alumno.html?share=' + shareId });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.get('/api/share-links', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const all  = await db.getShareLinks();
        const mine = sess.role === 'admin' ? all : all.filter(l => l.userId === sess.userId);
        res.json(mine.map(({ shareId, label, active, createdAt }) => ({ shareId, label, active, createdAt })));
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

app.delete('/api/share-links/:shareId', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        const link = await db.getShareLink(req.params.shareId);
        if (!link) {
            // Also check inactive links (getShareLink only returns active)
            const all = await db.getShareLinks();
            const any = all.find(l => l.shareId === req.params.shareId);
            if (!any) return res.status(404).json({ ok: false, message: 'No encontrado' });
            if (any.userId !== sess.userId && sess.role !== 'admin')
                return res.status(403).json({ ok: false, message: 'No autorizado' });
            await db.deleteShareLink(req.params.shareId);
            return res.json({ ok: true });
        }
        if (link.userId !== sess.userId && sess.role !== 'admin')
            return res.status(403).json({ ok: false, message: 'No autorizado' });
        await db.deleteShareLink(req.params.shareId);
        res.json({ ok: true });
    } catch(e) { console.error(e); res.status(500).json({ ok: false, message: 'Error interno' }); }
});

/* ══════════════════════════════════════════
   CATCH-ALL
   ══════════════════════════════════════════ */
app.use((req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/'))
        res.redirect('/');
    else
        res.status(404).json({ ok: false, message: 'No encontrado' });
});

/* ── Helpers ── */
function randomAlphaNum(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
    return s;
}

/* ── Iniciar ── */
(async () => {
    try {
        await db.initDB();
        await initAdmin();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n  EXPRESART server running on port ${PORT}`);
            console.log(`  DB mode: ${db.USE_DB ? 'PostgreSQL' : 'JSON files'}\n`);
        });
    } catch(e) {
        console.error('Startup error:', e);
        process.exit(1);
    }
})();
