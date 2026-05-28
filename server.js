require('dotenv').config();
const express     = require('express');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { pool, initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 9090;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ── Contraseñas ── */
const PW_SALT = process.env.EXP_SALT || 'expresart_salt_2025';
function hashPassword(pw) {
    return crypto.pbkdf2Sync(pw, PW_SALT, 100000, 64, 'sha256').toString('hex');
}
function verifyPassword(pw, hash) {
    return crypto.timingSafeEqual(Buffer.from(hashPassword(pw), 'hex'), Buffer.from(hash, 'hex'));
}

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
            filename:    (req, file, cb) => {
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

/* ── Helpers de perfil vacío ── */
const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: []
});

/* ── Middleware ── */
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(apiLimiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const ONE_WEEK = 7 * 24 * 60 * 60;
app.use(express.static(__dirname, {
    setHeaders(res, filePath) {
        if (/\.(css|js|png|jpg|jpeg|webp|gif|ico|woff2?)$/.test(filePath)) {
            res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}, stale-while-revalidate=86400`);
        } else if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders(res) { res.setHeader('Cache-Control', `public, max-age=${ONE_WEEK}`); }
}));

/* ══════════════════════════════════════════
   AUTENTICACIÓN
   ══════════════════════════════════════════ */
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos' });
    }
    const { rows } = await pool.query(
        'SELECT user_id, username, password_hash, role, active FROM users WHERE username = $1',
        [username.trim()]
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos' });
    }
    if (!user.active) {
        return res.status(403).json({ ok: false, message: 'Cuenta inactiva — contacta a EXPRESART' });
    }
    const token = newToken();
    sessions.set(token, { ts: Date.now(), userId: user.user_id, role: user.role });
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
app.get('/api/profiles', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT u.user_id AS "userId", u.username,
               COALESCE(p.display_name, u.username) AS "displayName",
               COALESCE(p.bio_short, '')  AS bio_short,
               COALESCE(p.photo_url, '')  AS "photoUrl",
               COALESCE(p.especialidades, '[]') AS especialidades,
               jsonb_array_length(COALESCE(p.producciones, '[]')) AS producciones,
               jsonb_array_length(COALESCE(p.videos, '[]'))       AS videos
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.user_id
        WHERE u.role = 'alumno' AND u.active = true
    `);
    res.json(rows);
});

app.get('/api/profile/:userId', async (req, res) => {
    const { rows: users } = await pool.query(
        "SELECT user_id FROM users WHERE user_id=$1 AND role='alumno' AND active=true",
        [req.params.userId]
    );
    if (!users.length) return res.status(404).json({ ok: false, message: 'Perfil no encontrado' });

    const { rows } = await pool.query(`
        SELECT user_id AS "userId", display_name AS "displayName", bio, bio_short,
               photo_url AS "photoUrl", especialidades, producciones, videos
        FROM profiles WHERE user_id=$1
    `, [req.params.userId]);

    const profile = rows[0] || emptyProfile(req.params.userId);
    res.json({ ok: true, profile });
});

/* ══════════════════════════════════════════
   MI PERFIL (alumno autenticado)
   ══════════════════════════════════════════ */
app.get('/api/my-profile', async (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const { rows } = await pool.query(`
        SELECT user_id AS "userId", display_name AS "displayName", bio, bio_short,
               photo_url AS "photoUrl", especialidades, producciones, videos
        FROM profiles WHERE user_id=$1
    `, [sess.userId]);
    res.json({ ok: true, profile: rows[0] || emptyProfile(sess.userId) });
});

app.post('/api/my-profile', async (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const b = req.body;
    await pool.query(`
        INSERT INTO profiles (user_id, display_name, bio, bio_short, photo_url, especialidades, producciones, videos)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (user_id) DO UPDATE SET
            display_name   = COALESCE($2, profiles.display_name),
            bio            = COALESCE($3, profiles.bio),
            bio_short      = COALESCE($4, profiles.bio_short),
            photo_url      = COALESCE($5, profiles.photo_url),
            especialidades = COALESCE($6, profiles.especialidades),
            producciones   = COALESCE($7, profiles.producciones),
            videos         = COALESCE($8, profiles.videos)
    `, [
        sess.userId,
        b.displayName   ?? null,
        b.bio           ?? null,
        b.bio_short     ?? null,
        b.photoUrl      ?? null,
        b.especialidades !== undefined ? JSON.stringify(b.especialidades) : null,
        b.producciones   !== undefined ? JSON.stringify(b.producciones)   : null,
        b.videos         !== undefined ? JSON.stringify(b.videos)         : null
    ]);
    res.json({ ok: true });
});

/* ── Subir foto de perfil ── */
app.post('/api/upload-photo', (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    uploaderFor(sess.userId).single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url = '/uploads/' + sess.userId + '/' + req.file.filename;
        await pool.query(`
            INSERT INTO profiles (user_id, photo_url) VALUES ($1,$2)
            ON CONFLICT (user_id) DO UPDATE SET photo_url=$2
        `, [sess.userId, url]);
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
        res.json({ ok: true, url: '/uploads/' + sess.userId + '/' + req.file.filename });
    });
});

/* ── Agregar video ── */
app.post('/api/add-video', async (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ ok: false, message: 'URL requerida' });
    await pool.query(`
        INSERT INTO profiles (user_id, videos) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE
        SET videos = profiles.videos || $2::jsonb
    `, [sess.userId, JSON.stringify([{ url, title: title || '' }])]);
    res.json({ ok: true });
});

/* ── Eliminar video ── */
app.delete('/api/video/:idx', async (req, res) => {
    const sess = requireAuth(req, res);
    if (!sess) return;
    const idx = parseInt(req.params.idx);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ ok: false, message: 'Índice inválido' });
    const { rows } = await pool.query('SELECT videos FROM profiles WHERE user_id=$1', [sess.userId]);
    if (!rows.length) return res.status(400).json({ ok: false, message: 'Perfil no encontrado' });
    const videos = rows[0].videos || [];
    if (idx >= videos.length) return res.status(400).json({ ok: false, message: 'Índice inválido' });
    videos.splice(idx, 1);
    await pool.query('UPDATE profiles SET videos=$1 WHERE user_id=$2', [JSON.stringify(videos), sess.userId]);
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   GESTIÓN DE USUARIOS (solo admin)
   ══════════════════════════════════════════ */
app.get('/api/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query(
        "SELECT user_id AS \"userId\", username, role, active, created_at AS \"createdAt\" FROM users ORDER BY created_at"
    );
    res.json(rows);
});

app.post('/api/users', async (req, res) => {
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
    const userId = 'alu_' + Date.now();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            "INSERT INTO users (user_id, username, password_hash, role, active) VALUES ($1,$2,$3,'alumno',true)",
            [userId, username.trim(), hashPassword(password)]
        );
        await client.query(
            'INSERT INTO profiles (user_id, display_name) VALUES ($1,$2)',
            [userId, displayName || username.trim()]
        );
        await client.query('COMMIT');
        res.json({ ok: true, userId });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ ok: false, message: 'Ese nombre de usuario ya existe' });
        throw err;
    } finally {
        client.release();
    }
});

app.put('/api/users/:userId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query("SELECT role FROM users WHERE user_id=$1", [req.params.userId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    if (rows[0].role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede modificar el admin' });
    if (req.body.active !== undefined) {
        await pool.query('UPDATE users SET active=$1 WHERE user_id=$2', [Boolean(req.body.active), req.params.userId]);
    }
    if (req.body.password) {
        await pool.query('UPDATE users SET password_hash=$1 WHERE user_id=$2', [hashPassword(req.body.password), req.params.userId]);
    }
    res.json({ ok: true });
});

app.delete('/api/users/:userId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query("SELECT role FROM users WHERE user_id=$1", [req.params.userId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    if (rows[0].role === 'admin') return res.status(403).json({ ok: false, message: 'No se puede eliminar el admin' });
    await pool.query('DELETE FROM users WHERE user_id=$1', [req.params.userId]);
    const uploadDir = path.join(UPLOADS_DIR, req.params.userId);
    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
        fs.rmdirSync(uploadDir);
    }
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   AGENDA / EVENTOS
   ══════════════════════════════════════════ */
app.get('/api/events', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT id, title,
               event_date::text AS date,
               event_time       AS time,
               location, description, category, audience,
               created_at AS "createdAt"
        FROM events
        ORDER BY event_date ASC
    `);
    res.json(rows);
});

const VALID_CATEGORIES = new Set(['obra', 'taller', 'audicion', 'otro']);
const VALID_AUDIENCES  = new Set(['publico', 'alumnos']);

app.post('/api/events', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { title, date, time, location, description, category, audience } = req.body;
    if (!title || !date || typeof title !== 'string' || typeof date !== 'string') {
        return res.status(400).json({ ok: false, message: 'Título y fecha son requeridos' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
        return res.status(400).json({ ok: false, message: 'Formato de fecha inválido (YYYY-MM-DD)' });
    }
    const id = 'evt_' + Date.now();
    const { rows } = await pool.query(`
        INSERT INTO events (id, title, event_date, event_time, location, description, category, audience)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id, title, event_date::text AS date, event_time AS time, location, description, category, audience
    `, [
        id,
        title.trim().slice(0, 200),
        date.trim(),
        (time        || '').slice(0, 10),
        (location    || '').slice(0, 200),
        (description || '').slice(0, 1000),
        VALID_CATEGORIES.has(category) ? category : 'otro',
        VALID_AUDIENCES.has(audience)  ? audience  : 'publico'
    ]);
    res.json({ ok: true, event: rows[0] });
});

app.put('/api/events/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows } = await pool.query('SELECT id FROM events WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
    const { title, date, time, location, description, category, audience } = req.body;
    await pool.query(`
        UPDATE events SET
            title       = COALESCE($1, title),
            event_date  = COALESCE($2::date, event_date),
            event_time  = COALESCE($3, event_time),
            location    = COALESCE($4, location),
            description = COALESCE($5, description),
            category    = COALESCE($6, category),
            audience    = COALESCE($7, audience)
        WHERE id=$8
    `, [
        title       ?? null,
        date        ?? null,
        time        ?? null,
        location    ?? null,
        description ?? null,
        category !== undefined ? (VALID_CATEGORIES.has(category) ? category : 'otro') : null,
        audience !== undefined ? (VALID_AUDIENCES.has(audience)  ? audience  : 'publico') : null,
        req.params.id
    ]);
    res.json({ ok: true });
});

app.delete('/api/events/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rowCount } = await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, message: 'Evento no encontrado' });
    res.json({ ok: true });
});

/* ══════════════════════════════════════════
   CONTENIDO GLOBAL (admin)
   ══════════════════════════════════════════ */
app.get('/api/content', async (req, res) => {
    const { rows } = await pool.query("SELECT value FROM site_content WHERE key='global'");
    res.json(rows[0]?.value || {});
});

app.post('/api/content', async (req, res) => {
    const { rows } = await pool.query("SELECT value FROM site_content WHERE key='global'");
    const data = rows[0]?.value || {};
    const body = req.body;
    if (body.section === 'profile')        data.profile        = body.data;
    if (body.section === 'destacada')      data.destacada      = { ...data.destacada, ...body.data };
    if (body.section === 'producciones')   data.producciones   = body.data;
    if (body.section === 'formacion')      data.formacion      = body.data;
    if (body.section === 'especialidades') data.especialidades = body.data;
    await pool.query(
        "INSERT INTO site_content (key,value) VALUES ('global',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
        [JSON.stringify(data)]
    );
    res.json({ ok: true });
});

app.post('/api/upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    uploaderFor('admin').single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió imagen' });
        const url = '/uploads/admin/' + req.file.filename;
        const { rows } = await pool.query("SELECT value FROM site_content WHERE key='global'");
        const data = rows[0]?.value || {};
        data.destacada       = data.destacada || {};
        data.destacada.photo = url;
        await pool.query(
            "INSERT INTO site_content (key,value) VALUES ('global',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
            [JSON.stringify(data)]
        );
        res.json({ ok: true, url });
    });
});

/* ══════════════════════════════════════════
   CATCH-ALL
   ══════════════════════════════════════════ */
app.use((req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/')) {
        res.redirect('/');
    } else {
        res.status(404).json({ ok: false, message: 'No encontrado' });
    }
});

/* ── Error handler global (Express 5 captura errores async automáticamente) ── */
app.use((err, req, res, _next) => {
    console.error('Error:', err.message);
    res.status(500).json({ ok: false, message: 'Error interno del servidor' });
});

/* ══════════════════════════════════════════
   Iniciar servidor
   ══════════════════════════════════════════ */
async function start() {
    if (!process.env.DATABASE_URL) {
        console.error('\n  ERROR: DATABASE_URL no está definida.');
        console.error('  Crea un archivo .env basado en .env.example y define DATABASE_URL.\n');
        process.exit(1);
    }
    await initDB();
    const { rows } = await pool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    if (!rows.length) {
        await pool.query(
            "INSERT INTO users (user_id,username,password_hash,role,active) VALUES ('admin','admin',$1,'admin',true)",
            [hashPassword(process.env.EXP_ADMIN_PW || 'expresart2025')]
        );
        await pool.query("INSERT INTO profiles (user_id, display_name) VALUES ('admin','Administrador')");
        console.log('  Usuario admin creado: admin / expresart2025');
    }
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  EXPRESART Server corriendo en puerto ${PORT}\n`);
    });
}

start().catch(err => {
    console.error('Error al iniciar:', err.message);
    process.exit(1);
});
