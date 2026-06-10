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

const app  = express();
const PORT = process.env.PORT || 9090;

/* ── Rutas de datos ── */
const DATA_DIR      = path.join(__dirname, 'data');
const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const PROFILES_DIR  = path.join(DATA_DIR, 'profiles');
const CONTENT_FILE  = path.join(DATA_DIR, 'content.json');
const EVENTS_FILE   = path.join(DATA_DIR, 'events.json');
const SESSIONS_FILE    = path.join(DATA_DIR, 'sessions.json');
const SHARE_LINKS_FILE = path.join(DATA_DIR, 'share-links.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');

[DATA_DIR, PROFILES_DIR, UPLOADS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ── Cloudinary (activo solo si las tres variables están definidas) ── */
/* Acepta CLOUDINARY_URL, o las variables individuales en cualquier variante de nombre */
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
const SALT_FILE = path.join(DATA_DIR, '.salt');
function getPwSalt() {
    if (process.env.EXP_SALT) return process.env.EXP_SALT;
    if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE, 'utf8').trim();
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
    console.warn('  WARN: EXP_SALT no definido. Salt generado y guardado en data/.salt');
    return salt;
}
const PW_SALT = getPwSalt();
function hashPassword(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, 100000, 64, 'sha256').toString('hex');
}
function verifyPassword(pw, hash) {
    return crypto.timingSafeEqual(Buffer.from(hashPassword(pw), 'hex'), Buffer.from(hash, 'hex'));
}

/* ── Helpers JSON ── */
function readJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error('readJSON error:', file, e.message);
        return fallback;
    }
}
function writeJSON(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/* ── Escape HTML para salida server-side ── */
function htmlEncode(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function readUsers()        { return readJSON(USERS_FILE, []); }
function writeUsers(d)      { writeJSON(USERS_FILE, d); }
function readShareLinks()   { return readJSON(SHARE_LINKS_FILE, []); }
function writeShareLinks(d) { writeJSON(SHARE_LINKS_FILE, d); }
function randomAlphaNum(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
    return s;
}
function readProfile(userId) {
    if (!/^[\w-]+$/.test(userId)) return null;
    return readJSON(path.join(PROFILES_DIR, userId + '.json'), null);
}
function writeProfile(userId, data) {
    if (!/^[\w-]+$/.test(userId)) return;
    writeJSON(path.join(PROFILES_DIR, userId + '.json'), data);
}
function readContent()   { return readJSON(CONTENT_FILE, {}); }
function writeContent(d) { writeJSON(CONTENT_FILE, d); }
function readEvents()    { return readJSON(EVENTS_FILE, []); }
function writeEvents(d)  { writeJSON(EVENTS_FILE, d); }

/* ── Rate limiting ── */
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
    message: { ok: false, message: 'Demasiados intentos. Intenta en 15 minutos.' }
});
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/')
});

/* ── Admin inicial ── */
function initAdmin() {
    const users    = readUsers();
    const pw       = process.env.EXP_ADMIN_PW || 'expresart2025';
    const existing = users.find(u => u.role === 'admin');
    if (!existing) {
        users.push({
            userId: 'admin', username: 'admin',
            passwordHash: hashPassword(pw),
            role: 'admin', active: true, createdAt: new Date().toISOString()
        });
        writeUsers(users);
        console.log('  Usuario admin creado.');
    } else if (process.env.EXP_ADMIN_PW) {
        existing.passwordHash = hashPassword(pw);
        writeUsers(users);
        console.log('  Contraseña admin actualizada desde EXP_ADMIN_PW.');
    }
}

/* ── Sesiones persistidas en disco ── */
const SESSION_TTL   = 1 * 60 * 60 * 1000;       // 1 hora  (usuarios normales)
const SHARE_TTL     = 24 * 60 * 60 * 1000;       // 24 horas (tokens de enlace privado)

function loadSessions() {
    try {
        const raw = readJSON(SESSIONS_FILE, {});
        const now = Date.now();
        const map = new Map();
        Object.entries(raw).forEach(([k, v]) => {
            // Respetar expiresAt si existe, si no usar SESSION_TTL
            const expiry = v.expiresAt || (v.ts + SESSION_TTL);
            if (now < expiry) map.set(k, v);
        });
        return map;
    } catch(e) { return new Map(); }
}
function saveSessions(map) {
    const obj = {};
    map.forEach((v, k) => { obj[k] = v; });
    writeJSON(SESSIONS_FILE, obj);
}
const sessions = loadSessions();

function newToken() { return crypto.randomBytes(32).toString('hex'); }
function getSession(req) {
    const token = req.headers['x-session-token'];
    if (!token) return null;
    const sess = sessions.get(token);
    if (!sess) return null;
    const expiry = sess.expiresAt || (sess.ts + SESSION_TTL);
    if (Date.now() >= expiry) { sessions.delete(token); saveSessions(sessions); return null; }
    // Solo refrescar actividad en sesiones de usuario normal (no en tokens de enlace)
    if (!sess.expiresAt) sess.ts = Date.now();
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

/* ── Multer + Cloudinary ── */
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
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
    /* Fallback: disco local */
    const dest = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const ext      = path.extname(originalname).toLowerCase();
    const filename = 'foto-' + Date.now() + ext;
    fs.writeFileSync(path.join(dest, filename), buffer);
    return '/uploads/' + userId + '/' + filename;
}

/* ── Perfil vacío ── */
const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: []
});

/* ══════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════ */
app.set('trust proxy', 1);

/* Redirigir a HTTPS cuando se usa detrás de un proxy en producción */
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
            scriptSrc:      ["'self'", "'unsafe-inline'"],
            styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
            fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'https://unpkg.com'],
            imgSrc:         ["'self'", 'https://res.cloudinary.com', 'https://img.youtube.com', 'data:', 'blob:'],
            connectSrc:     ["'self'"],
            frameSrc:       ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
            frameAncestors: ["'none'"],
            baseUri:        ["'self'"],
            formAction:     ["'self'"],
            scriptSrcAttr:  ["'unsafe-inline'"],
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
app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders(res) { res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}`); }
}));

/* ══════════════════════════════════════════
   AUTENTICACIÓN
   ══════════════════════════════════════════ */
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
        return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
    const user = readUsers().find(u => u.username === username.trim());
    if (!user || !verifyPassword(password, user.passwordHash))
        return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    if (!user.active)
        return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });
    const token = newToken();
    sessions.set(token, { ts: Date.now(), userId: user.userId, role: user.role });
    saveSessions(sessions);
    res.json({ ok: true, token, role: user.role, mustChangePassword: !!user.mustChangePassword });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['x-session-token'];
    if (token) { sessions.delete(token); saveSessions(sessions); }
    res.json({ ok: true });
});

app.post('/api/change-password', (req, res) => {
    const sess = getSession(req);
    if (!sess) return res.status(401).json({ ok: false, message: 'No autenticado' });
    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string')
        return res.status(400).json({ ok: false, message: 'Nueva contraseña requerida' });
    if (newPassword.length < 8)
        return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });
    const users = readUsers();
    const idx = users.findIndex(u => u.userId === sess.userId);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    users[idx].passwordHash = hashPassword(newPassword);
    delete users[idx].mustChangePassword;
    writeUsers(users);
    res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
    const sess = getSession(req);
    if (!sess) return res.json({ ok: false });
    const profile = sess.role === 'alumno' ? (readProfile(sess.userId) || {}) : {};
    res.json({
        ok: true,
        userId: sess.userId,
        role: sess.role,
        displayName: profile.displayName || '',
        photoUrl:    profile.photoUrl    || ''
    });
});

/* ══════════════════════════════════════════
   PERFILES PÚBLICOS
   ══════════════════════════════════════════ */
app.get('/api/profiles', (req, res) => {
    const profiles = readUsers()
        .filter(u => u.role === 'alumno' && u.active)
        .map(u => {
            const p = readProfile(u.userId) || {};
            return {
                userId:         u.userId,
                displayName:    p.displayName    || u.username,
                bio_short:      p.bio_short      || '',
                especialidades: p.especialidades || [],
                photoUrl:       p.photoUrl       || '',
                producciones:   (p.producciones  || []).length,
                videos:         (p.videos        || []).length
            };
        });
    res.json(profiles);
});

app.get('/api/profile/:userId', (req, res) => {
    const user = readUsers().find(u => u.userId === req.params.userId);
    if (!user || !user.active || user.role !== 'alumno')
        return res.status(404).json({ ok: false, message: 'Perfil no encontrado' });
    res.json({ ok: true, profile: readProfile(user.userId) || {} });
});

/* ══════════════════════════════════════════
   MI PERFIL (alumno autenticado)
   ══════════════════════════════════════════ */
app.get('/api/my-profile', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    res.json({ ok: true, profile: readProfile(sess.userId) || emptyProfile(sess.userId) });
});

app.post('/api/my-profile', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const current = readProfile(sess.userId) || emptyProfile(sess.userId);
    ['displayName', 'bio', 'bio_short', 'especialidades', 'producciones', 'videos'].forEach(k => {
        if (req.body[k] !== undefined) current[k] = req.body[k];
    });
    writeProfile(sess.userId, current);
    res.json({ ok: true });
});

/* ── Subir foto de perfil ── */
app.post('/api/upload-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId);
            const p   = readProfile(sess.userId) || emptyProfile(sess.userId);
            p.photoUrl = url;
            writeProfile(sess.userId, p);
            res.json({ ok: true, url });
        } catch(e) {
            console.error('upload-photo error:', e);
            res.status(500).json({ ok: false, message: 'Error al guardar imagen' });
        }
    });
});

/* ── Subir foto de producción ── */
app.post('/api/upload-prod-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        try {
            const url = await saveFile(req.file.buffer, req.file.originalname, sess.userId);
            res.json({ ok: true, url });
        } catch(e) {
            console.error('upload-prod-photo error:', e.message);
            res.status(500).json({ ok: false, message: 'Error al guardar imagen' });
        }
    });
});

/* ── Agregar video ── */
app.post('/api/add-video', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ ok: false, message: 'URL requerida' });
    const p = readProfile(sess.userId) || emptyProfile(sess.userId);
    if (!p.videos) p.videos = [];
    p.videos.push({ url, title: title || '' });
    writeProfile(sess.userId, p);
    res.json({ ok: true });
});

/* ── Eliminar video ── */
app.delete('/api/video/:idx', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const p   = readProfile(sess.userId);
    const idx = parseInt(req.params.idx);
    if (!p || !p.videos || isNaN(idx) || idx < 0 || idx >= p.videos.length)
        return res.status(400).json({ ok: false, message: 'Índice inválido' });
    p.videos.splice(idx, 1);
    writeProfile(sess.userId, p);
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   GESTIÓN DE USUARIOS (admin)
   ══════════════════════════════════════════ */
app.get('/api/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(readUsers().map(u => ({
        userId: u.userId, username: u.username,
        role: u.role, active: u.active, createdAt: u.createdAt
    })));
});

app.post('/api/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { username, password, displayName } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
        return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
    if (username.trim().length < 3 || username.trim().length > 40)
        return res.status(400).json({ ok: false, message: 'Usuario debe tener entre 3 y 40 caracteres' });
    if (password.length < 8)
        return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });
    const users = readUsers();
    if (users.find(u => u.username === username.trim()))
        return res.status(409).json({ ok: false, message: 'Ese nombre de usuario ya existe' });
    const userId = 'alu_' + Date.now();
    users.push({ userId, username: username.trim(), passwordHash: hashPassword(password), role: 'alumno', active: true, mustChangePassword: true, createdAt: new Date().toISOString() });
    writeUsers(users);
    writeProfile(userId, { ...emptyProfile(userId), displayName: displayName || username.trim() });
    res.json({ ok: true, userId });
});

app.put('/api/users/:userId', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = readUsers();
    const idx   = users.findIndex(u => u.userId === req.params.userId);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    if (users[idx].role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede modificar el admin' });
    if (req.body.active !== undefined) users[idx].active = Boolean(req.body.active);
    if (req.body.password) users[idx].passwordHash = hashPassword(req.body.password);
    writeUsers(users);
    res.json({ ok: true });
});

app.delete('/api/users/:userId', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = readUsers();
    const idx   = users.findIndex(u => u.userId === req.params.userId);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    if (users[idx].role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede eliminar el admin' });
    const userId = users[idx].userId;
    users.splice(idx, 1);
    writeUsers(users);
    const profileFile = path.join(PROFILES_DIR, userId + '.json');
    if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile);
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
});

/* ══════════════════════════════════════════
   EVENTOS
   ══════════════════════════════════════════ */
app.get('/api/events', (req, res) => {
    res.json(readEvents().sort((a, b) => a.date.localeCompare(b.date)));
});

const VALID_CATEGORIES = new Set(['obra', 'taller', 'audicion', 'otro']);
const VALID_AUDIENCES  = new Set(['publico', 'alumnos']);

app.post('/api/events', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { title, date, time, location, description, category, audience } = req.body;
    if (!title || !date || typeof title !== 'string' || typeof date !== 'string')
        return res.status(400).json({ ok: false, message: 'Título y fecha son requeridos' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
        return res.status(400).json({ ok: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
    const events = readEvents();
    const event  = {
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
    events.push(event);
    writeEvents(events);
    res.json({ ok: true, event });
});

app.put('/api/events/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const events = readEvents();
    const idx    = events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
    const { title, date, time, location, description, category, audience } = req.body;
    if (title       !== undefined) events[idx].title       = title;
    if (date        !== undefined) events[idx].date        = date;
    if (time        !== undefined) events[idx].time        = time;
    if (location    !== undefined) events[idx].location    = location;
    if (description !== undefined) events[idx].description = description;
    if (category    !== undefined) events[idx].category    = VALID_CATEGORIES.has(category) ? category : 'otro';
    if (audience    !== undefined) events[idx].audience    = VALID_AUDIENCES.has(audience)  ? audience : 'publico';
    writeEvents(events);
    res.json({ ok: true });
});

app.delete('/api/events/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const events = readEvents();
    const idx    = events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
    events.splice(idx, 1);
    writeEvents(events);
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   CONTENIDO GLOBAL (admin)
   ══════════════════════════════════════════ */
app.get('/api/content', (req, res) => res.json(readContent()));

app.post('/api/content', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const data = readContent();
        const body = req.body;
        if (body.section === 'profile')        data.profile        = body.data;
        if (body.section === 'destacada')      data.destacada      = { ...data.destacada, ...body.data };
        if (body.section === 'producciones')   data.producciones   = body.data;
        if (body.section === 'formacion')      data.formacion      = body.data;
        if (body.section === 'especialidades') data.especialidades = body.data;
        writeContent(data);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

app.post('/api/upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    uploader.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url  = await saveFile(req.file.buffer, req.file.originalname, 'admin');
        const data = readContent();
        data.destacada       = data.destacada || {};
        data.destacada.photo = url;
        writeContent(data);
        res.json({ ok: true, url });
    });
});

/* ══════════════════════════════════════════
   PAGOS / TRANSFERENCIAS BANCARIAS
   ══════════════════════════════════════════ */
const ORDERS_FILE   = path.join(DATA_DIR, 'orders.json');
const BANKINFO_FILE = path.join(DATA_DIR, 'bank-info.json');

function readOrders()     { return readJSON(ORDERS_FILE, []); }
function writeOrders(d)   { writeJSON(ORDERS_FILE, d); }
function readBankInfo()   { return readJSON(BANKINFO_FILE, {}); }
function writeBankInfo(d) { writeJSON(BANKINFO_FILE, d); }

function nextInvoiceNumber() {
    const count = readOrders().filter(o => o.invoiceNumber).length + 1;
    return '001-001-' + String(count).padStart(9, '0');
}

function generateComprobanteHTML(order, info) {
    const fecha = new Date(order.confirmedAt).toLocaleDateString('es-EC',
        { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Comprobante ${order.invoiceNumber}</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222}
.no-print{text-align:right;margin-bottom:16px}
.print-btn{background:#333;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.9rem}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #c9a227;padding-bottom:16px;margin-bottom:24px;gap:16px}
.company h1{font-size:1.5rem;margin:0 0 4px;color:#111}.company p{margin:2px 0;font-size:.82rem;color:#555}
.inv-info{text-align:right;min-width:200px}.inv-info h2{font-size:.85rem;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 6px;color:#777}
.inv-info p{margin:2px 0;font-size:.88rem}.badge{display:inline-block;background:#2a7a2a;color:#fff;padding:4px 12px;border-radius:4px;font-size:.78rem;font-weight:600;margin-top:6px}
.section{margin-bottom:22px}.section h3{font-size:.75rem;text-transform:uppercase;letter-spacing:1.5px;color:#999;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid #eee}
table{width:100%;border-collapse:collapse}th{background:#f7f7f7;padding:8px 12px;text-align:left;font-size:.82rem;color:#555}
td{padding:8px 12px;font-size:.9rem;border-bottom:1px solid #f0f0f0}.totals td{border:none;padding:5px 12px}
.total-final td{font-size:1.05rem;font-weight:700;border-top:2px solid #333;padding-top:10px}
.footer{margin-top:32px;text-align:center;font-size:.72rem;color:#bbb;border-top:1px solid #eee;padding-top:16px}
.note{background:#fffbec;border-left:3px solid #c9a227;padding:8px 12px;font-size:.83rem;color:#666;margin-top:8px;border-radius:0 4px 4px 0}
@media print{.no-print{display:none}body{margin:0}}
</style></head><body>
<div class="no-print"><button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
<div class="header">
  <div class="company">
    <h1>EXPRESART</h1>
    <p>Escuela de Actuación</p>
    ${info.ruc     ? `<p><strong>RUC:</strong> ${htmlEncode(info.ruc)}</p>`   : ''}
    ${info.address ? `<p>${htmlEncode(info.address)}</p>`                     : ''}
    ${info.email   ? `<p>${htmlEncode(info.email)}</p>`                       : ''}
    ${info.phone   ? `<p>${htmlEncode(info.phone)}</p>`                       : ''}
  </div>
  <div class="inv-info">
    <h2>Comprobante de Pago</h2>
    <p><strong>No.</strong> ${order.invoiceNumber}</p>
    <p><strong>Fecha:</strong> ${fecha}</p>
    <span class="badge">✓ PAGO CONFIRMADO</span>
  </div>
</div>
<div class="section">
  <h3>Datos del cliente</h3>
  <table><tr><td><strong>Nombre:</strong></td><td>${htmlEncode(order.customerName)}</td></tr>
  <tr><td><strong>RUC / Cédula:</strong></td><td>${htmlEncode(order.customerDoc)}</td></tr>
  <tr><td><strong>Correo:</strong></td><td>${htmlEncode(order.customerEmail)}</td></tr></table>
</div>
<div class="section">
  <h3>Detalle del servicio</h3>
  <table><thead><tr><th>Concepto</th><th style="text-align:right">Subtotal sin IVA</th></tr></thead>
  <tbody><tr><td>${htmlEncode(order.concept)}</td><td style="text-align:right">$${order.subtotal.toFixed(2)}</td></tr></tbody></table>
</div>
<div class="section">
  <table class="totals">
    <tr><td>Subtotal (tarifa ${order.ivaRate}% IVA)</td><td style="text-align:right">$${order.subtotal.toFixed(2)}</td></tr>
    <tr><td>IVA ${order.ivaRate}%</td><td style="text-align:right">$${order.iva.toFixed(2)}</td></tr>
    <tr class="total-final"><td>TOTAL PAGADO</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
  </table>
</div>
<div class="section">
  <h3>Forma de pago</h3>
  <p>Transferencia bancaria · ${htmlEncode(info.bankName)} · ${htmlEncode(info.accountType)} No. ${htmlEncode(info.accountNumber)}</p>
  ${order.notes ? `<div class="note">Nota: ${htmlEncode(order.notes)}</div>` : ''}
</div>
<div class="footer">
  <p>Este comprobante es un documento de respaldo de pago.</p>
  <p>La factura electrónica autorizada por el SRI será enviada a su correo una vez disponible.</p>
  <p><strong>EXPRESART — Escuela de Actuación · Donde el Arte Cobra Vida</strong></p>
</div>
</body></html>`;
}

/* Datos bancarios públicos */
app.get('/api/bank-info', (req, res) => res.json(readBankInfo()));

/* Guardar datos bancarios (admin) */
app.post('/api/bank-info', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services } = req.body;
    writeBankInfo({ bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services: services || [] });
    res.json({ ok: true });
});

/* Crear orden de pago (público) */
app.post('/api/orders', (req, res) => {
    uploader.single('receipt')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        const { customerName, customerDoc, customerEmail, concept, amount, notes } = req.body;
        if (!customerName || !customerDoc || !customerEmail || !concept || !amount)
            return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos' });
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0)
            return res.status(400).json({ ok: false, message: 'Monto inválido' });
        const receiptUrl = req.file
            ? await saveFile(req.file.buffer, req.file.originalname, 'receipts')
            : '';
        const subtotal = Math.round((amountNum / 1.15) * 100) / 100;
        const iva      = Math.round((amountNum - subtotal) * 100) / 100;
        const order = {
            id:              'ord_' + Date.now(),
            token:           crypto.randomBytes(16).toString('hex'),
            status:          'pendiente',
            customerName:    customerName.trim().slice(0, 200),
            customerDoc:     customerDoc.trim().slice(0, 20),
            customerEmail:   customerEmail.trim().slice(0, 200),
            concept:         concept.trim().slice(0, 300),
            amount:          amountNum,
            subtotal,
            iva,
            ivaRate:         15,
            receiptUrl,
            notes:           (notes || '').trim().slice(0, 500),
            invoiceNumber:   null,
            rejectionReason: '',
            createdAt:       new Date().toISOString(),
            confirmedAt:     null
        };
        const orders = readOrders();
        orders.push(order);
        writeOrders(orders);
        res.json({ ok: true, orderId: order.id, token: order.token });
    });
});

/* Listar órdenes (admin) */
app.get('/api/orders', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(readOrders().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

/* Confirmar pago (admin) */
app.put('/api/orders/:id/confirm', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const orders = readOrders();
    const idx    = orders.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
    if (orders[idx].status === 'confirmado') return res.json({ ok: true, invoiceNumber: orders[idx].invoiceNumber });
    orders[idx].status        = 'confirmado';
    orders[idx].invoiceNumber = nextInvoiceNumber();
    orders[idx].confirmedAt   = new Date().toISOString();
    writeOrders(orders);
    res.json({ ok: true, invoiceNumber: orders[idx].invoiceNumber });

    /* Lanzar flujo SRI de forma asíncrona sin bloquear la respuesta */
    const orderId     = req.params.id;
    const secuencial  = orders[idx].invoiceNumber;
    const orderSnap   = { ...orders[idx] };
    setImmediate(async () => {
        try {
            if (!getSRIConfig().ruc) return; // SRI no configurado — omitir silenciosamente
            const result = await emitirFactura(orderSnap, secuencial);
            const all    = readOrders();
            const i2     = all.findIndex(o => o.id === orderId);
            if (i2 === -1) return;
            if (!result.ok) console.error('SRI error:', result.error);
            all[i2].sri = result.ok
                ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
            writeOrders(all);
        } catch (e) {
            console.error('SRI error en confirm:', e.message);
            const all = readOrders();
            const i2  = all.findIndex(o => o.id === orderId);
            if (i2 !== -1) { all[i2].sri = { status: 'error', error: e.message }; writeOrders(all); }
        }
    });
});

/* Reintentar autorización SRI (admin) */
app.post('/api/orders/:id/sri-retry', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const orders = readOrders();
    const idx    = orders.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
    if (orders[idx].status !== 'confirmado') return res.status(400).json({ ok: false, message: 'Solo se puede reintentar en órdenes confirmadas' });
    res.json({ ok: true, message: 'Reintento iniciado' });

    const orderId    = req.params.id;
    const secuencial = orders[idx].invoiceNumber;
    const orderSnap  = { ...orders[idx] };
    setImmediate(async () => {
        try {
            const result = await emitirFactura(orderSnap, secuencial);
            const all    = readOrders();
            const i2     = all.findIndex(o => o.id === orderId);
            if (i2 === -1) return;
            all[i2].sri = result.ok
                ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
            writeOrders(all);
        } catch (e) {
            const all = readOrders();
            const i2  = all.findIndex(o => o.id === orderId);
            if (i2 !== -1) { all[i2].sri = { status: 'error', error: e.message }; writeOrders(all); }
        }
    });
});

/* Subir certificado .p12 (admin) */
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

/* Rechazar pago (admin) */
app.put('/api/orders/:id/reject', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const orders = readOrders();
    const idx    = orders.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
    orders[idx].status          = 'rechazado';
    orders[idx].rejectionReason = (req.body.reason || '').trim().slice(0, 300);
    writeOrders(orders);
    res.json({ ok: true });
});

/* Ver comprobante */
app.get('/factura/:id', (req, res) => {
    const order = readOrders().find(o => o.id === req.params.id);
    if (!order) return res.status(404).send('<h2>Comprobante no encontrado</h2>');
    const sess    = getSession(req);
    const isAdmin = sess && sess.role === 'admin';
    if (!isAdmin && req.query.token !== order.token)
        return res.status(403).send('<h2>Acceso no autorizado</h2>');
    if (order.status !== 'confirmado')
        return res.status(400).send('<h2>El pago aún no ha sido confirmado por EXPRESART.</h2>');
    res.send(generateComprobanteHTML(order, readBankInfo()));
});

/* ══════════════════════════════════════════
   ENLACES PRIVADOS DE PORTAFOLIO
   ══════════════════════════════════════════ */

/* Info pública de un enlace (solo userId, sin hash) */
app.get('/api/share-links/:shareId/info', (req, res) => {
    const link = readShareLinks().find(l => l.shareId === req.params.shareId && l.active !== false);
    if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido o inactivo' });
    res.json({ ok: true, userId: link.userId });
});

/* Verificar contraseña del enlace — emite token con TTL de 24 h */
app.post('/api/share-links/:shareId/auth', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ ok: false, message: 'Contraseña requerida' });
    const link = readShareLinks().find(l => l.shareId === req.params.shareId && l.active !== false);
    if (!link) return res.status(404).json({ ok: false, message: 'Enlace no válido' });
    if (!verifyPassword(password, link.passwordHash))
        return res.status(401).json({ ok: false, message: 'Contraseña incorrecta' });
    const token     = newToken();
    const expiresAt = Date.now() + SHARE_TTL;
    sessions.set(token, { role: 'share', shareId: req.params.shareId, userId: link.userId, ts: Date.now(), expiresAt });
    saveSessions(sessions);
    res.json({ ok: true, userId: link.userId, token, expiresAt });
});

/* Crear enlace privado */
app.post('/api/share-links', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const { label } = req.body || {};
    const shareId  = randomAlphaNum(10);
    const password = randomAlphaNum(8);
    const links = readShareLinks();
    links.push({
        shareId,
        userId: sess.userId,
        passwordHash: hashPassword(password),
        label: String(label || '').trim().slice(0, 80),
        active: true,
        createdAt: new Date().toISOString()
    });
    writeShareLinks(links);
    const base = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    res.json({ ok: true, shareId, password, url: base + '/portafolio-alumno.html?share=' + shareId });
});

/* Listar mis enlaces */
app.get('/api/share-links', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const all = readShareLinks();
    const mine = sess.role === 'admin' ? all : all.filter(l => l.userId === sess.userId);
    res.json(mine.map(({ shareId, label, active, createdAt }) => ({ shareId, label, active, createdAt })));
});

/* Revocar enlace */
app.delete('/api/share-links/:shareId', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const links = readShareLinks();
    const idx = links.findIndex(l => l.shareId === req.params.shareId);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'No encontrado' });
    if (links[idx].userId !== sess.userId && sess.role !== 'admin')
        return res.status(403).json({ ok: false, message: 'No autorizado' });
    links.splice(idx, 1);
    writeShareLinks(links);
    res.json({ ok: true });
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

/* ── Iniciar ── */
initAdmin();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  EXPRESART Server corriendo en puerto ${PORT}`);
    console.log(`  Imágenes: ${USE_CLOUDINARY ? 'Cloudinary (CDN)' : 'disco local'}\n`);
});
