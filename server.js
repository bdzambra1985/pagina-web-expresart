const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 9090;

/* ── Rutas ── */
const DATA_DIR     = path.join(__dirname, 'data');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const EVENTS_FILE  = path.join(DATA_DIR, 'events.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');

[DATA_DIR, PROFILES_DIR, UPLOADS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ── Contraseñas ── */
const PW_SALT = process.env.EXP_SALT || 'expresart_salt_2025';
function hashPassword(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, 100000, 64, 'sha256').toString('hex');
}
function verifyPassword(pw, hash) {
    return crypto.timingSafeEqual(Buffer.from(hashPassword(pw), 'hex'), Buffer.from(hash, 'hex'));
}

/* ── Helpers de datos ── */
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
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readUsers()              { return readJSON(USERS_FILE, []); }
function writeUsers(data)         { writeJSON(USERS_FILE, data); }
function readProfile(userId) {
    if (!/^[\w-]+$/.test(userId)) return null;
    return readJSON(path.join(PROFILES_DIR, userId + '.json'), null);
}
function writeProfile(userId, data) {
    if (!/^[\w-]+$/.test(userId)) return;
    writeJSON(path.join(PROFILES_DIR, userId + '.json'), data);
}
function readContent()            { return readJSON(CONTENT_FILE, {}); }
function writeContent(data)       { writeJSON(CONTENT_FILE, data); }
function readEvents()             { return readJSON(EVENTS_FILE, []); }
function writeEvents(data)        { writeJSON(EVENTS_FILE, data); }

/* ── Rate limiting simple para /api/login ── */
const loginAttempts = new Map();
function checkRateLimit(ip) {
    const now  = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, first: now };
    if (now - entry.first > 15 * 60 * 1000) { loginAttempts.set(ip, { count: 1, first: now }); return true; }
    if (entry.count >= 10) return false;
    entry.count++;
    loginAttempts.set(ip, entry);
    return true;
}

/* ── Crear admin en primer inicio ── */
function initAdmin() {
    const users = readUsers();
    if (!users.find(u => u.role === 'admin')) {
        users.push({
            userId: 'admin',
            username: 'admin',
            passwordHash: hashPassword(process.env.EXP_ADMIN_PW || 'expresart2025'),
            role: 'admin',
            active: true,
            createdAt: new Date().toISOString()
        });
        writeUsers(users);
        console.log('  Usuario admin creado: admin / expresart2025');
    }
}

/* ── Sesiones en memoria ── */
const sessions    = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

function newToken() {
    return crypto.randomBytes(32).toString('hex');
}
function getSession(req) {
    const token = req.headers['x-session-token'] || req.query.token;
    if (!token) return null;
    const sess = sessions.get(token);
    if (!sess) return null;
    if (Date.now() - sess.ts > SESSION_TTL) { sessions.delete(token); return null; }
    sess.ts = Date.now();
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

/* ── Multer por usuario ── */
function uploaderFor(userId) {
    const dest = path.join(UPLOADS_DIR, userId);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    return multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, dest),
            filename: (req, file, cb) => {
                const ext = path.extname(file.originalname).toLowerCase();
                cb(null, 'foto-' + Date.now() + ext);
            }
        }),
        limits: { fileSize: 10 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            cb(null, ['.jpg','.jpeg','.png','.webp','.gif'].includes(
                path.extname(file.originalname).toLowerCase()
            ));
        }
    });
}

/* ── Middleware ── */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

/* ══════════════════════════════════════════
   AUTENTICACIÓN
   ══════════════════════════════════════════ */
app.post('/api/login', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ ok: false, message: 'Demasiados intentos. Intenta en 15 minutos.' });
    }
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
    }
    const users = readUsers();
    const user  = users.find(u => u.username === username.trim());
    if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    }
    if (!user.active) {
        return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });
    }
    const token = newToken();
    sessions.set(token, { ts: Date.now(), userId: user.userId, role: user.role });
    res.json({ ok: true, token, role: user.role });
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['x-session-token'];
    if (token) sessions.delete(token);
    res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
    const sess = getSession(req);
    if (!sess) return res.json({ ok: false });
    res.json({ ok: true, userId: sess.userId, role: sess.role });
});

/* ══════════════════════════════════════════
   PERFILES PÚBLICOS DE ALUMNOS
   ══════════════════════════════════════════ */
app.get('/api/profiles', (req, res) => {
    const users    = readUsers().filter(u => u.role === 'alumno' && u.active);
    const profiles = users.map(u => {
        const p = readProfile(u.userId) || {};
        return {
            userId:        u.userId,
            displayName:   p.displayName || u.username,
            bio_short:     p.bio_short   || '',
            especialidades: p.especialidades || [],
            photoUrl:      p.photoUrl    || '',
            producciones:  (p.producciones || []).length,
            videos:        (p.videos      || []).length
        };
    });
    res.json(profiles);
});

app.get('/api/profile/:userId', (req, res) => {
    const users = readUsers();
    const user  = users.find(u => u.userId === req.params.userId);
    if (!user || !user.active || user.role !== 'alumno') {
        return res.status(404).json({ ok: false, message: 'Perfil no encontrado' });
    }
    const p = readProfile(user.userId) || {};
    res.json({ ok: true, profile: p });
});

/* ══════════════════════════════════════════
   MI PERFIL (alumno autenticado)
   ══════════════════════════════════════════ */
const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: []
});

app.get('/api/my-profile', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const p = readProfile(sess.userId) || emptyProfile(sess.userId);
    res.json({ ok: true, profile: p });
});

app.post('/api/my-profile', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const current = readProfile(sess.userId) || emptyProfile(sess.userId);
    ['displayName','bio','bio_short','especialidades','producciones','videos'].forEach(k => {
        if (req.body[k] !== undefined) current[k] = req.body[k];
    });
    writeProfile(sess.userId, current);
    res.json({ ok: true });
});

/* ── Subir foto de perfil ── */
app.post('/api/upload-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploaderFor(sess.userId).single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url = '/uploads/' + sess.userId + '/' + req.file.filename;
        const p   = readProfile(sess.userId) || emptyProfile(sess.userId);
        p.photoUrl = url;
        writeProfile(sess.userId, p);
        res.json({ ok: true, url });
    });
});

/* ── Subir foto de producción ── */
app.post('/api/upload-prod-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploaderFor(sess.userId).single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url = '/uploads/' + sess.userId + '/' + req.file.filename;
        res.json({ ok: true, url });
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
    if (!p || !p.videos || isNaN(idx) || idx < 0 || idx >= p.videos.length) {
        return res.status(400).json({ ok: false, message: 'Índice inválido' });
    }
    p.videos.splice(idx, 1);
    writeProfile(sess.userId, p);
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   GESTIÓN DE USUARIOS (solo admin)
   ══════════════════════════════════════════ */
app.get('/api/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = readUsers().map(u => ({
        userId: u.userId, username: u.username,
        role: u.role, active: u.active, createdAt: u.createdAt
    }));
    res.json(users);
});

app.post('/api/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { username, password, displayName } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
    }
    if (username.trim().length < 3 || username.trim().length > 40) {
        return res.status(400).json({ ok: false, message: 'Usuario debe tener entre 3 y 40 caracteres' });
    }
    if (password.length < 6) {
        return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const users = readUsers();
    if (users.find(u => u.username === username.trim())) {
        return res.status(409).json({ ok: false, message: 'Ese nombre de usuario ya existe' });
    }
    const userId = 'alu_' + Date.now();
    users.push({
        userId, username,
        passwordHash: hashPassword(password),
        role: 'alumno',
        active: true,
        createdAt: new Date().toISOString()
    });
    writeUsers(users);
    writeProfile(userId, {
        ...emptyProfile(userId),
        displayName: displayName || username
    });
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
    const uploadDir = path.join(UPLOADS_DIR, userId);
    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
        fs.rmdirSync(uploadDir);
    }
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   AGENDA / EVENTOS
   ══════════════════════════════════════════ */
app.get('/api/events', (req, res) => {
    const events = readEvents().sort((a, b) => a.date.localeCompare(b.date));
    res.json(events);
});

const VALID_CATEGORIES = new Set(['obra', 'taller', 'audicion', 'otro']);
app.post('/api/events', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { title, date, time, location, description, category } = req.body;
    if (!title || !date || typeof title !== 'string' || typeof date !== 'string') {
        return res.status(400).json({ ok: false, message: 'Título y fecha son requeridos' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
        return res.status(400).json({ ok: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
    }
    const events = readEvents();
    const event  = {
        id: 'evt_' + Date.now(),
        title:       title.trim().slice(0, 200),
        date:        date.trim(),
        time:        (time        || '').slice(0, 10),
        location:    (location    || '').slice(0, 200),
        description: (description || '').slice(0, 1000),
        category:    VALID_CATEGORIES.has(category) ? category : 'otro',
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
    const { title, date, time, location, description, category } = req.body;
    if (title       !== undefined) events[idx].title       = title;
    if (date        !== undefined) events[idx].date        = date;
    if (time        !== undefined) events[idx].time        = time;
    if (location    !== undefined) events[idx].location    = location;
    if (description !== undefined) events[idx].description = description;
    if (category    !== undefined) events[idx].category    = category;
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
app.get('/api/content', (req, res) => {
    res.json(readContent());
});

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
    uploaderFor('admin').single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url  = '/uploads/admin/' + req.file.filename;
        const data = readContent();
        data.destacada       = data.destacada || {};
        data.destacada.photo = url;
        writeContent(data);
        res.json({ ok: true, url });
    });
});

/* ══════════════════════════════════════════
   RUTA RAÍZ Y CATCH-ALL
   ══════════════════════════════════════════ */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/')) {
        res.redirect('/');
    } else {
        res.status(404).json({ ok: false, message: 'No encontrado' });
    }
});

/* ══════════════════════════════════════════
   Iniciar servidor
   ══════════════════════════════════════════ */
initAdmin();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  EXPRESART Server corriendo en puerto ${PORT}\n`);
});
