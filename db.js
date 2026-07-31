'use strict';
const path = require('path');
const fs   = require('fs');

/* ══════════════════════════════════════════
   Dual-mode: PostgreSQL si DATABASE_URL está
   definida, JSON files en caso contrario.
   ══════════════════════════════════════════ */
const USE_DB = !!process.env.DATABASE_URL;
let pool;
/* ── Configuración TLS de PostgreSQL ──
   Por defecto (producción) se mantiene el comportamiento previo para no
   romper conexiones a proveedores con certificados internos autofirmados.
   Para validar el certificado del servidor de BD (recomendado contra MITM):
     • DATABASE_CA_CERT = contenido PEM del CA  → valida contra ese CA
     • DATABASE_SSL_STRICT = "true"             → exige cadena de confianza del sistema
*/
function pgSslConfig() {
    if (process.env.NODE_ENV !== 'production') return false;
    if (process.env.DATABASE_CA_CERT)
        return { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true };
    if (process.env.DATABASE_SSL_STRICT === 'true')
        return { rejectUnauthorized: true };
    return { rejectUnauthorized: false };
}

if (USE_DB) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: pgSslConfig(),
        max: 10,
        idleTimeoutMillis: 30000
    });
    pool.on('error', (err) => console.error('[pg] pool error:', err.message));
}

/* ── JSON file paths (modo fallback) ── */
const DATA_DIR            = path.join(__dirname, 'data');
const USERS_FILE          = path.join(DATA_DIR, 'users.json');
const PROFILES_DIR        = path.join(DATA_DIR, 'profiles');
const CONTENT_FILE        = path.join(DATA_DIR, 'content.json');
const EVENTS_FILE         = path.join(DATA_DIR, 'events.json');
const SHARE_LINKS_FILE    = path.join(DATA_DIR, 'share-links.json');
const RESET_REQUESTS_FILE = path.join(DATA_DIR, 'reset-requests.json');
const ORDERS_FILE         = path.join(DATA_DIR, 'orders.json');
const BANKINFO_FILE       = path.join(DATA_DIR, 'bank-info.json');
const PRIVACY_MSGS_FILE   = path.join(DATA_DIR, 'privacy-messages.json');

/* ── JSON helpers ── */
function jRead(file, fb) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}
function jWrite(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/* ══════════════════════════════════════════
   INIT — crea tablas en PostgreSQL
   ══════════════════════════════════════════ */
async function initDB() {
    if (!USE_DB) {
        [DATA_DIR, PROFILES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
        return;
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id        TEXT PRIMARY KEY,
            username       TEXT UNIQUE NOT NULL,
            password_hash  TEXT NOT NULL,
            display_name   TEXT,
            role           TEXT NOT NULL DEFAULT 'alumno',
            active         BOOLEAN NOT NULL DEFAULT TRUE,
            must_change_pw BOOLEAN NOT NULL DEFAULT FALSE,
            consent_accepted_at TIMESTAMPTZ,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS profiles (
            user_id          TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
            display_name     TEXT,
            bio              TEXT,
            bio_short        TEXT,
            photo_url        TEXT,
            especialidades   JSONB NOT NULL DEFAULT '[]',
            producciones     JSONB NOT NULL DEFAULT '[]',
            videos           JSONB NOT NULL DEFAULT '[]',
            certificados     JSONB NOT NULL DEFAULT '[]',
            portfolio_active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS events (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            date        TEXT NOT NULL,
            time        TEXT,
            location    TEXT,
            description TEXT,
            category    TEXT NOT NULL DEFAULT 'otro',
            audience    TEXT NOT NULL DEFAULT 'publico',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS content (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS orders (
            id               TEXT PRIMARY KEY,
            token            TEXT,
            status           TEXT NOT NULL DEFAULT 'pendiente',
            user_id          TEXT,
            customer_name    TEXT NOT NULL,
            customer_doc     TEXT NOT NULL,
            customer_email   TEXT NOT NULL,
            concept          TEXT NOT NULL,
            amount           NUMERIC(10,2) NOT NULL,
            subtotal         NUMERIC(10,2),
            iva              NUMERIC(10,2),
            iva_rate         NUMERIC(5,2) NOT NULL DEFAULT 15,
            receipt_url      TEXT,
            notes            TEXT,
            payment_month    TEXT,
            invoice_number   TEXT,
            rejection_reason TEXT,
            sri              JSONB,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at     TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
        CREATE TABLE IF NOT EXISTS bank_info (
            id             INTEGER PRIMARY KEY DEFAULT 1,
            bank_name      TEXT,
            account_number TEXT,
            account_type   TEXT,
            account_holder TEXT,
            ruc            TEXT,
            address        TEXT,
            email          TEXT,
            phone          TEXT,
            services       JSONB NOT NULL DEFAULT '[]',
            CONSTRAINT bank_info_one_row CHECK (id = 1)
        );
        CREATE TABLE IF NOT EXISTS share_links (
            share_id      TEXT PRIMARY KEY,
            user_id       TEXT REFERENCES users(user_id) ON DELETE CASCADE,
            password_hash TEXT NOT NULL,
            label         TEXT,
            active        BOOLEAN NOT NULL DEFAULT TRUE,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS reset_requests (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            username     TEXT NOT NULL,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status       TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS privacy_messages (
            id           TEXT PRIMARY KEY,
            from_email   TEXT NOT NULL,
            subject      TEXT,
            body         TEXT,
            received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_read      BOOLEAN NOT NULL DEFAULT FALSE
        );
        -- Sesiones y bloqueos de login: sobreviven a los reinicios.
        -- Se guarda el hash del token, nunca el token en sí: quien lea
        -- la tabla no puede suplantar a nadie con su contenido.
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash   TEXT PRIMARY KEY,
            data         JSONB NOT NULL,
            created_at   BIGINT NOT NULL,
            last_seen    BIGINT NOT NULL,
            expires_at   BIGINT
        );
        CREATE TABLE IF NOT EXISTS login_attempts (
            lock_key     TEXT PRIMARY KEY,
            count        INTEGER NOT NULL DEFAULT 0,
            locked_until BIGINT NOT NULL DEFAULT 0,
            ts           BIGINT NOT NULL
        );
    `);
    // Migraciones para columnas añadidas después de la creación inicial
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS certificados JSONB NOT NULL DEFAULT '[]'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ`);
    // Segundo factor (TOTP). totp_secret guarda el secreto en base32; queda
    // pendiente hasta que totp_enabled pasa a true al confirmar el primer código.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery JSONB NOT NULL DEFAULT '[]'`);
    console.log('  [db] PostgreSQL tables ready.');
}

/* ══════════════════════════════════════════
   USERS
   ══════════════════════════════════════════ */
function toUser(r) {
    return {
        userId:             r.user_id,
        username:           r.username,
        passwordHash:       r.password_hash,
        displayName:        r.display_name || '',
        role:               r.role,
        active:             !!r.active,
        mustChangePassword: !!r.must_change_pw,
        consentAcceptedAt:  r.consent_accepted_at ? (r.consent_accepted_at instanceof Date ? r.consent_accepted_at.toISOString() : r.consent_accepted_at) : null,
        totpSecret:         r.totp_secret || null,
        totpEnabled:        !!r.totp_enabled,
        totpRecovery:       r.totp_recovery || [],
        createdAt:          r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || new Date().toISOString())
    };
}

async function getUsers() {
    if (!USE_DB) return jRead(USERS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at');
    return rows.map(toUser);
}
async function getUserByUsername(username) {
    if (!USE_DB) return jRead(USERS_FILE, []).find(u => u.username === username) || null;
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] ? toUser(rows[0]) : null;
}
async function getUserById(userId) {
    if (!USE_DB) return jRead(USERS_FILE, []).find(u => u.userId === userId) || null;
    const { rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return rows[0] ? toUser(rows[0]) : null;
}
async function createUser(u) {
    if (!USE_DB) { const a = jRead(USERS_FILE, []); a.push(u); jWrite(USERS_FILE, a); return; }
    await pool.query(
        `INSERT INTO users (user_id, username, password_hash, display_name, role, active, must_change_pw, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.userId, u.username, u.passwordHash, u.displayName || null,
         u.role || 'alumno', u.active !== false, !!u.mustChangePassword,
         u.createdAt || new Date().toISOString()]
    );
}
async function updateUser(userId, fields) {
    if (!USE_DB) {
        const a = jRead(USERS_FILE, []);
        const i = a.findIndex(u => u.userId === userId);
        if (i === -1) return false;
        Object.assign(a[i], fields);
        jWrite(USERS_FILE, a);
        return true;
    }
    const colMap = { passwordHash:'password_hash', active:'active', mustChangePassword:'must_change_pw', displayName:'display_name', consentAcceptedAt:'consent_accepted_at',
                     totpSecret:'totp_secret', totpEnabled:'totp_enabled', totpRecovery:'totp_recovery' };
    const sets = [], vals = [];
    Object.entries(fields).forEach(([k, v]) => {
        const col = colMap[k]; if (!col) return;
        sets.push(`${col} = $${sets.length+1}`); vals.push(v);
    });
    if (!sets.length) return true;
    vals.push(userId);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE user_id = $${vals.length}`, vals);
    return true;
}
async function deleteUser(userId) {
    if (!USE_DB) {
        const a = jRead(USERS_FILE, []);
        const i = a.findIndex(u => u.userId === userId);
        if (i === -1) return false;
        a.splice(i, 1); jWrite(USERS_FILE, a); return true;
    }
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    return true;
}

/* ══════════════════════════════════════════
   PROFILES
   ══════════════════════════════════════════ */
function toProfile(r) {
    return {
        userId:          r.user_id,
        displayName:     r.display_name || '',
        bio:             r.bio || '',
        bio_short:       r.bio_short || '',
        photoUrl:        r.photo_url || '',
        especialidades:  r.especialidades || [],
        producciones:    r.producciones || [],
        videos:          r.videos || [],
        certificados:    r.certificados || [],
        portfolioActive: r.portfolio_active !== false
    };
}
async function getProfile(userId) {
    if (!/^[\w-]+$/.test(userId)) return null;
    if (!USE_DB) {
        const f = path.join(PROFILES_DIR, userId + '.json');
        return fs.existsSync(f) ? jRead(f, null) : null;
    }
    const { rows } = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
    return rows[0] ? toProfile(rows[0]) : null;
}
async function upsertProfile(userId, p) {
    if (!/^[\w-]+$/.test(userId)) return;
    if (!USE_DB) { jWrite(path.join(PROFILES_DIR, userId + '.json'), p); return; }
    await pool.query(
        `INSERT INTO profiles (user_id, display_name, bio, bio_short, photo_url,
                               especialidades, producciones, videos, certificados, portfolio_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
            display_name=$2, bio=$3, bio_short=$4, photo_url=$5,
            especialidades=$6, producciones=$7, videos=$8, certificados=$9, portfolio_active=$10, updated_at=NOW()`,
        [userId, p.displayName||'', p.bio||'', p.bio_short||'', p.photoUrl||'',
         JSON.stringify(p.especialidades||[]), JSON.stringify(p.producciones||[]),
         JSON.stringify(p.videos||[]), JSON.stringify(p.certificados||[]), p.portfolioActive!==false]
    );
}
async function deleteProfile(userId) {
    if (!USE_DB) {
        const f = path.join(PROFILES_DIR, userId + '.json');
        if (fs.existsSync(f)) fs.unlinkSync(f); return;
    }
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
}

/* ══════════════════════════════════════════
   EVENTS
   ══════════════════════════════════════════ */
function toEvent(r) {
    return {
        id:          r.id,
        title:       r.title,
        date:        r.date,
        time:        r.time || '',
        location:    r.location || '',
        description: r.description || '',
        category:    r.category || 'otro',
        audience:    r.audience || 'publico',
        createdAt:   r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || '')
    };
}
async function getEvents() {
    if (!USE_DB) return jRead(EVENTS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM events ORDER BY date ASC, created_at ASC');
    return rows.map(toEvent);
}
async function createEvent(ev) {
    if (!USE_DB) { const a = jRead(EVENTS_FILE, []); a.push(ev); jWrite(EVENTS_FILE, a); return; }
    await pool.query(
        `INSERT INTO events (id,title,date,time,location,description,category,audience,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ev.id, ev.title, ev.date, ev.time||null, ev.location||null,
         ev.description||null, ev.category||'otro', ev.audience||'publico',
         ev.createdAt||new Date().toISOString()]
    );
}
async function updateEvent(id, fields) {
    if (!USE_DB) {
        const a = jRead(EVENTS_FILE, []);
        const i = a.findIndex(e => e.id === id);
        if (i === -1) return false;
        Object.assign(a[i], fields); jWrite(EVENTS_FILE, a); return true;
    }
    const COLS = ['title','date','time','location','description','category','audience'];
    const sets = [], vals = [];
    COLS.forEach(c => { if (fields[c] !== undefined) { sets.push(`${c}=$${sets.length+1}`); vals.push(fields[c]); }});
    if (!sets.length) return true;
    vals.push(id);
    await pool.query(`UPDATE events SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    return true;
}
async function deleteEvent(id) {
    if (!USE_DB) {
        const a = jRead(EVENTS_FILE, []);
        const i = a.findIndex(e => e.id === id);
        if (i === -1) return false;
        a.splice(i, 1); jWrite(EVENTS_FILE, a); return true;
    }
    await pool.query('DELETE FROM events WHERE id=$1', [id]);
    return true;
}

/* ══════════════════════════════════════════
   CONTENT
   ══════════════════════════════════════════ */
async function getContent() {
    if (!USE_DB) return jRead(CONTENT_FILE, {});
    const { rows } = await pool.query('SELECT key, value FROM content');
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    return obj;
}
async function saveContentSection(section, data) {
    if (!USE_DB) {
        const c = jRead(CONTENT_FILE, {});
        if (section === 'destacada') c.destacada = { ...(c.destacada||{}), ...data };
        else c[section] = data;
        jWrite(CONTENT_FILE, c); return;
    }
    let value = data;
    if (section === 'destacada') {
        const { rows } = await pool.query("SELECT value FROM content WHERE key='destacada'");
        value = { ...(rows[0] ? rows[0].value : {}), ...data };
    }
    await pool.query(
        `INSERT INTO content(key,value) VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        [section, JSON.stringify(value)]
    );
}
async function saveContentPhoto(url) {
    if (!USE_DB) {
        const c = jRead(CONTENT_FILE, {});
        c.destacada = c.destacada || {};
        c.destacada.photo = url;
        jWrite(CONTENT_FILE, c); return;
    }
    const { rows } = await pool.query("SELECT value FROM content WHERE key='destacada'");
    const dest = { ...(rows[0] ? rows[0].value : {}), photo: url };
    await pool.query(
        `INSERT INTO content(key,value) VALUES('destacada',$1)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        [JSON.stringify(dest)]
    );
}

/* ══════════════════════════════════════════
   ORDERS
   ══════════════════════════════════════════ */
function toOrder(r) {
    return {
        id:              r.id,
        token:           r.token || '',
        status:          r.status,
        userId:          r.user_id || null,
        customerName:    r.customer_name,
        customerDoc:     r.customer_doc,
        customerEmail:   r.customer_email,
        concept:         r.concept,
        amount:          parseFloat(r.amount),
        subtotal:        parseFloat(r.subtotal || 0),
        iva:             parseFloat(r.iva || 0),
        ivaRate:         parseFloat(r.iva_rate || 15),
        receiptUrl:      r.receipt_url || '',
        notes:           r.notes || '',
        paymentMonth:    r.payment_month || null,
        invoiceNumber:   r.invoice_number || null,
        rejectionReason: r.rejection_reason || '',
        sri:             r.sri || null,
        createdAt:       r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || ''),
        confirmedAt:     r.confirmed_at ? (r.confirmed_at instanceof Date ? r.confirmed_at.toISOString() : r.confirmed_at) : null
    };
}
async function getOrders() {
    if (!USE_DB) return jRead(ORDERS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    return rows.map(toOrder);
}
async function getOrdersByUser(userId) {
    if (!USE_DB) return jRead(ORDERS_FILE, []).filter(o => o.userId === userId);
    const { rows } = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
    return rows.map(toOrder);
}
async function getOrderById(id) {
    if (!USE_DB) return jRead(ORDERS_FILE, []).find(o => o.id === id) || null;
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
    return rows[0] ? toOrder(rows[0]) : null;
}
async function createOrder(o) {
    if (!USE_DB) { const a = jRead(ORDERS_FILE, []); a.push(o); jWrite(ORDERS_FILE, a); return; }
    await pool.query(
        `INSERT INTO orders (id,token,status,user_id,customer_name,customer_doc,customer_email,
                             concept,amount,subtotal,iva,iva_rate,receipt_url,notes,payment_month,
                             invoice_number,rejection_reason,sri,created_at,confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [o.id, o.token, o.status, o.userId||null,
         o.customerName, o.customerDoc, o.customerEmail, o.concept,
         o.amount, o.subtotal, o.iva, o.ivaRate||15,
         o.receiptUrl||null, o.notes||null, o.paymentMonth||null,
         o.invoiceNumber||null, o.rejectionReason||null,
         o.sri ? JSON.stringify(o.sri) : null,
         o.createdAt||new Date().toISOString(), o.confirmedAt||null]
    );
}
async function updateOrder(id, fields) {
    if (!USE_DB) {
        const a = jRead(ORDERS_FILE, []);
        const i = a.findIndex(o => o.id === id);
        if (i === -1) return false;
        Object.assign(a[i], fields); jWrite(ORDERS_FILE, a); return true;
    }
    const colMap = {
        status:'status', invoiceNumber:'invoice_number',
        confirmedAt:'confirmed_at', rejectionReason:'rejection_reason',
        sri:'sri', userId:'user_id'
    };
    const sets = [], vals = [];
    Object.entries(fields).forEach(([k, v]) => {
        const col = colMap[k]; if (!col) return;
        sets.push(`${col}=$${sets.length+1}`);
        vals.push(k==='sri' && v ? JSON.stringify(v) : v);
    });
    if (!sets.length) return true;
    vals.push(id);
    await pool.query(`UPDATE orders SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    return true;
}
async function deleteAllOrders() {
    if (!USE_DB) { jWrite(ORDERS_FILE, []); return; }
    await pool.query('DELETE FROM orders');
}

async function nextInvoiceNumber() {
    if (!USE_DB) {
        const orders = jRead(ORDERS_FILE, []);
        const maxSeq = orders.reduce((m, o) => {
            if (!o.invoiceNumber) return m;
            return Math.max(m, parseInt(o.invoiceNumber.split('-').pop(), 10) || 0);
        }, 0);
        return '001-001-' + String(maxSeq + 1).padStart(9, '0');
    }
    const { rows } = await pool.query(
        `SELECT invoice_number FROM orders WHERE invoice_number IS NOT NULL ORDER BY created_at DESC`
    );
    const maxSeq = rows.reduce((m, r) => {
        return Math.max(m, parseInt((r.invoice_number || '').split('-').pop(), 10) || 0);
    }, 0);
    return '001-001-' + String(maxSeq + 1).padStart(9, '0');
}

/* ══════════════════════════════════════════
   BANK INFO
   ══════════════════════════════════════════ */
async function getBankInfo() {
    if (!USE_DB) return jRead(BANKINFO_FILE, {});
    const { rows } = await pool.query('SELECT * FROM bank_info WHERE id=1');
    if (!rows[0]) return {};
    const r = rows[0];
    return { bankName:r.bank_name, accountNumber:r.account_number, accountType:r.account_type,
             accountHolder:r.account_holder, ruc:r.ruc, address:r.address, email:r.email,
             phone:r.phone, services:r.services||[] };
}
async function saveBankInfo(info) {
    if (!USE_DB) { jWrite(BANKINFO_FILE, info); return; }
    await pool.query(
        `INSERT INTO bank_info (id,bank_name,account_number,account_type,account_holder,
                                ruc,address,email,phone,services)
         VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
            bank_name=$1,account_number=$2,account_type=$3,account_holder=$4,
            ruc=$5,address=$6,email=$7,phone=$8,services=$9`,
        [info.bankName||null, info.accountNumber||null, info.accountType||null,
         info.accountHolder||null, info.ruc||null, info.address||null,
         info.email||null, info.phone||null, JSON.stringify(info.services||[])]
    );
}

/* ══════════════════════════════════════════
   SHARE LINKS
   ══════════════════════════════════════════ */
function toShareLink(r) {
    return {
        shareId:      r.share_id,
        userId:       r.user_id,
        passwordHash: r.password_hash,
        label:        r.label || '',
        active:       !!r.active,
        createdAt:    r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || '')
    };
}
async function getShareLinks() {
    if (!USE_DB) return jRead(SHARE_LINKS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM share_links ORDER BY created_at DESC');
    return rows.map(toShareLink);
}
async function getShareLink(shareId) {
    if (!USE_DB) return jRead(SHARE_LINKS_FILE, []).find(l => l.shareId === shareId && l.active !== false) || null;
    const { rows } = await pool.query('SELECT * FROM share_links WHERE share_id=$1 AND active=TRUE', [shareId]);
    return rows[0] ? toShareLink(rows[0]) : null;
}
async function createShareLink(l) {
    if (!USE_DB) { const a = jRead(SHARE_LINKS_FILE, []); a.push(l); jWrite(SHARE_LINKS_FILE, a); return; }
    await pool.query(
        `INSERT INTO share_links (share_id,user_id,password_hash,label,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [l.shareId, l.userId, l.passwordHash, l.label||'', l.active!==false, l.createdAt||new Date().toISOString()]
    );
}
async function deleteShareLink(shareId) {
    if (!USE_DB) {
        const a = jRead(SHARE_LINKS_FILE, []);
        const i = a.findIndex(l => l.shareId === shareId);
        if (i === -1) return false;
        a.splice(i, 1); jWrite(SHARE_LINKS_FILE, a); return true;
    }
    await pool.query('DELETE FROM share_links WHERE share_id=$1', [shareId]);
    return true;
}

/* ══════════════════════════════════════════
   RESET REQUESTS
   ══════════════════════════════════════════ */
function toResetReq(r) {
    return {
        id:          r.id,
        userId:      r.user_id,
        username:    r.username,
        requestedAt: r.requested_at instanceof Date ? r.requested_at.toISOString() : (r.requested_at || ''),
        status:      r.status || 'pending'
    };
}
async function getResetRequests() {
    if (!USE_DB) return jRead(RESET_REQUESTS_FILE, []).filter(r => r.status === 'pending');
    const { rows } = await pool.query(`SELECT * FROM reset_requests WHERE status='pending' ORDER BY requested_at`);
    return rows.map(toResetReq);
}
async function createResetRequest(data) {
    if (!USE_DB) {
        const a = jRead(RESET_REQUESTS_FILE, []);
        const ya = a.find(r => r.userId === data.userId && r.status === 'pending');
        if (!ya) { a.push(data); jWrite(RESET_REQUESTS_FILE, a); }
        return;
    }
    const { rows } = await pool.query(
        `SELECT id FROM reset_requests WHERE user_id=$1 AND status='pending'`, [data.userId]);
    if (rows.length > 0) return;
    await pool.query(
        `INSERT INTO reset_requests (id,user_id,username,requested_at,status) VALUES ($1,$2,$3,$4,'pending')`,
        [data.id, data.userId, data.username, data.requestedAt||new Date().toISOString()]
    );
}
async function markResetRequestDone(userId) {
    if (!USE_DB) {
        const a = jRead(RESET_REQUESTS_FILE, []).map(r =>
            r.userId === userId && r.status === 'pending' ? { ...r, status: 'done' } : r
        );
        jWrite(RESET_REQUESTS_FILE, a); return;
    }
    await pool.query(`UPDATE reset_requests SET status='done' WHERE user_id=$1 AND status='pending'`, [userId]);
}
async function dismissResetRequest(id) {
    if (!USE_DB) {
        const a = jRead(RESET_REQUESTS_FILE, []).map(r =>
            r.id === id ? { ...r, status: 'dismissed' } : r
        );
        jWrite(RESET_REQUESTS_FILE, a); return;
    }
    await pool.query(`UPDATE reset_requests SET status='dismissed' WHERE id=$1`, [id]);
}

/* ══════════════════════════════════════════
   PRIVACY MESSAGES (bandeja privacidad@expresart.ec)
   ══════════════════════════════════════════ */
function toPrivacyMsg(r) {
    return {
        id:         r.id,
        fromEmail:  r.from_email,
        subject:    r.subject || '',
        body:       r.body || '',
        receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : (r.received_at || ''),
        isRead:     !!r.is_read
    };
}
async function getPrivacyMessages() {
    if (!USE_DB) return jRead(PRIVACY_MSGS_FILE, []).slice().sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    const { rows } = await pool.query('SELECT * FROM privacy_messages ORDER BY received_at DESC');
    return rows.map(toPrivacyMsg);
}
async function createPrivacyMessage(msg) {
    if (!USE_DB) {
        const a = jRead(PRIVACY_MSGS_FILE, []);
        if (a.find(m => m.id === msg.id)) return; // idempotente ante reintentos del webhook
        a.push(msg); jWrite(PRIVACY_MSGS_FILE, a); return;
    }
    await pool.query(
        `INSERT INTO privacy_messages (id, from_email, subject, body, received_at, is_read)
         VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT (id) DO NOTHING`,
        [msg.id, msg.fromEmail, msg.subject || '', msg.body || '', msg.receivedAt || new Date().toISOString()]
    );
}
async function markPrivacyMessageRead(id) {
    if (!USE_DB) {
        const a = jRead(PRIVACY_MSGS_FILE, []).map(m => m.id === id ? { ...m, isRead: true } : m);
        jWrite(PRIVACY_MSGS_FILE, a); return;
    }
    await pool.query(`UPDATE privacy_messages SET is_read = true WHERE id = $1`, [id]);
}
async function deletePrivacyMessage(id) {
    if (!USE_DB) {
        const a = jRead(PRIVACY_MSGS_FILE, []).filter(m => m.id !== id);
        jWrite(PRIVACY_MSGS_FILE, a); return;
    }
    await pool.query(`DELETE FROM privacy_messages WHERE id = $1`, [id]);
}

/* ══════════════════════════════════════════
   EXPORTS
   ══════════════════════════════════════════ */
/* ══════════════════════════════════════════
   SESIONES Y BLOQUEOS DE LOGIN

   Respaldo persistente del estado que middleware/auth.js mantiene en
   memoria. En modo JSON (sin DATABASE_URL) se guarda en data/, con
   permisos 0600 porque contiene hashes de tokens de sesión activos.
   ══════════════════════════════════════════ */
const SESSIONS_FILE       = path.join(DATA_DIR, 'sessions-store.json');
const LOGIN_ATTEMPTS_FILE = path.join(DATA_DIR, 'login-attempts.json');

function jWriteSecure(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

async function loadSessions() {
    if (!USE_DB) return jRead(SESSIONS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM sessions');
    return rows.map(r => ({
        tokenHash: r.token_hash,
        data:      r.data,
        createdAt: Number(r.created_at),
        lastSeen:  Number(r.last_seen),
        expiresAt: r.expires_at === null ? undefined : Number(r.expires_at)
    }));
}

async function saveSession(tokenHash, sess) {
    const { ts, createdAt, expiresAt, ...data } = sess;
    if (!USE_DB) {
        const all = jRead(SESSIONS_FILE, []).filter(s => s.tokenHash !== tokenHash);
        all.push({ tokenHash, data, createdAt, lastSeen: ts, expiresAt });
        jWriteSecure(SESSIONS_FILE, all);
        return;
    }
    await pool.query(
        `INSERT INTO sessions (token_hash, data, created_at, last_seen, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (token_hash) DO UPDATE
           SET data = $2, last_seen = $4, expires_at = $5`,
        [tokenHash, JSON.stringify(data), createdAt, ts, expiresAt ?? null]
    );
}

async function touchSessions(entries) {
    if (!entries.length) return;
    if (!USE_DB) {
        const byHash = new Map(entries.map(e => [e.tokenHash, e.ts]));
        const all = jRead(SESSIONS_FILE, []);
        for (const s of all) if (byHash.has(s.tokenHash)) s.lastSeen = byHash.get(s.tokenHash);
        jWriteSecure(SESSIONS_FILE, all);
        return;
    }
    await pool.query(
        `UPDATE sessions SET last_seen = v.ts
           FROM (SELECT unnest($1::text[]) AS h, unnest($2::bigint[]) AS ts) v
          WHERE sessions.token_hash = v.h`,
        [entries.map(e => e.tokenHash), entries.map(e => e.ts)]
    );
}

async function deleteSessions(tokenHashes) {
    if (!tokenHashes.length) return;
    if (!USE_DB) {
        const keep = jRead(SESSIONS_FILE, []).filter(s => !tokenHashes.includes(s.tokenHash));
        jWriteSecure(SESSIONS_FILE, keep);
        return;
    }
    await pool.query('DELETE FROM sessions WHERE token_hash = ANY($1)', [tokenHashes]);
}

async function loadLoginAttempts() {
    if (!USE_DB) return jRead(LOGIN_ATTEMPTS_FILE, []);
    const { rows } = await pool.query('SELECT * FROM login_attempts');
    return rows.map(r => ({
        lockKey:     r.lock_key,
        count:       r.count,
        lockedUntil: Number(r.locked_until),
        ts:          Number(r.ts)
    }));
}

async function saveLoginAttempt(lockKey, att) {
    if (!USE_DB) {
        const all = jRead(LOGIN_ATTEMPTS_FILE, []).filter(a => a.lockKey !== lockKey);
        all.push({ lockKey, count: att.count || 0, lockedUntil: att.lockedUntil || 0, ts: att.ts || Date.now() });
        jWriteSecure(LOGIN_ATTEMPTS_FILE, all);
        return;
    }
    await pool.query(
        `INSERT INTO login_attempts (lock_key, count, locked_until, ts)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lock_key) DO UPDATE
           SET count = $2, locked_until = $3, ts = $4`,
        [lockKey, att.count || 0, att.lockedUntil || 0, att.ts || Date.now()]
    );
}

async function deleteLoginAttempts(lockKeys) {
    if (!lockKeys.length) return;
    if (!USE_DB) {
        const keep = jRead(LOGIN_ATTEMPTS_FILE, []).filter(a => !lockKeys.includes(a.lockKey));
        jWriteSecure(LOGIN_ATTEMPTS_FILE, keep);
        return;
    }
    await pool.query('DELETE FROM login_attempts WHERE lock_key = ANY($1)', [lockKeys]);
}

module.exports = {
    USE_DB,
    initDB,
    /* sessions & login attempts */
    loadSessions, saveSession, touchSessions, deleteSessions,
    loadLoginAttempts, saveLoginAttempt, deleteLoginAttempts,
    /* users */
    getUsers, getUserByUsername, getUserById,
    createUser, updateUser, deleteUser,
    /* profiles */
    getProfile, upsertProfile, deleteProfile,
    /* events */
    getEvents, createEvent, updateEvent, deleteEvent,
    /* content */
    getContent, saveContentSection, saveContentPhoto,
    /* orders */
    getOrders, getOrdersByUser, getOrderById,
    createOrder, updateOrder, deleteAllOrders, nextInvoiceNumber,
    /* bank info */
    getBankInfo, saveBankInfo,
    /* share links */
    getShareLinks, getShareLink, createShareLink, deleteShareLink,
    /* reset requests */
    getResetRequests, createResetRequest, markResetRequestDone, dismissResetRequest,
    /* privacy messages */
    getPrivacyMessages, createPrivacyMessage, markPrivacyMessageRead, deletePrivacyMessage,
    /* data dirs (needed by server.js for cleanup of files) */
    DATA_DIR, PROFILES_DIR
};
