/**
 * migrate.js — Migra datos de JSON files a PostgreSQL.
 * Ejecutar UNA sola vez: node migrate.js
 * Requiere DATABASE_URL en el entorno (o en .env).
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL no definida.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const DATA_DIR     = path.join(__dirname, 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

function jRead(file, fb) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}

async function migrate() {
    console.log('Iniciando migración JSON → PostgreSQL…\n');

    /* ── Usuarios ── */
    const users = jRead(path.join(DATA_DIR, 'users.json'), []);
    let usersOk = 0;
    for (const u of users) {
        try {
            await pool.query(
                `INSERT INTO users (user_id, username, password_hash, display_name, role, active, must_change_pw, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO NOTHING`,
                [u.userId, u.username, u.passwordHash, u.displayName||null,
                 u.role||'alumno', u.active!==false, !!u.mustChangePassword,
                 u.createdAt||new Date().toISOString()]
            );
            usersOk++;
        } catch(e) { console.error(`  user ${u.username}:`, e.message); }
    }
    console.log(`  users: ${usersOk}/${users.length} migrados`);

    /* ── Perfiles ── */
    let profilesOk = 0, profilesTotal = 0;
    if (fs.existsSync(PROFILES_DIR)) {
        const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
        profilesTotal = files.length;
        for (const file of files) {
            const userId = file.replace('.json', '');
            const p = jRead(path.join(PROFILES_DIR, file), null);
            if (!p) continue;
            try {
                await pool.query(
                    `INSERT INTO profiles (user_id, display_name, bio, bio_short, photo_url,
                                          especialidades, producciones, videos, portfolio_active, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT (user_id) DO NOTHING`,
                    [userId, p.displayName||'', p.bio||'', p.bio_short||'', p.photoUrl||'',
                     JSON.stringify(p.especialidades||[]), JSON.stringify(p.producciones||[]),
                     JSON.stringify(p.videos||[]), p.portfolioActive!==false]
                );
                profilesOk++;
            } catch(e) { console.error(`  profile ${userId}:`, e.message); }
        }
    }
    console.log(`  profiles: ${profilesOk}/${profilesTotal} migrados`);

    /* ── Eventos ── */
    const events = jRead(path.join(DATA_DIR, 'events.json'), []);
    let eventsOk = 0;
    for (const ev of events) {
        try {
            await pool.query(
                `INSERT INTO events (id,title,date,time,location,description,category,audience,created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
                [ev.id, ev.title, ev.date, ev.time||null, ev.location||null,
                 ev.description||null, ev.category||'otro', ev.audience||'publico',
                 ev.createdAt||new Date().toISOString()]
            );
            eventsOk++;
        } catch(e) { console.error(`  event ${ev.id}:`, e.message); }
    }
    console.log(`  events: ${eventsOk}/${events.length} migrados`);

    /* ── Contenido ── */
    const content = jRead(path.join(DATA_DIR, 'content.json'), {});
    let contentOk = 0;
    for (const [key, value] of Object.entries(content)) {
        try {
            await pool.query(
                `INSERT INTO content(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,
                [key, JSON.stringify(value)]
            );
            contentOk++;
        } catch(e) { console.error(`  content ${key}:`, e.message); }
    }
    console.log(`  content: ${contentOk}/${Object.keys(content).length} secciones migradas`);

    /* ── Órdenes ── */
    const orders = jRead(path.join(DATA_DIR, 'orders.json'), []);
    let ordersOk = 0;
    for (const o of orders) {
        try {
            await pool.query(
                `INSERT INTO orders (id,token,status,user_id,customer_name,customer_doc,customer_email,
                                    concept,amount,subtotal,iva,iva_rate,receipt_url,notes,payment_month,
                                    invoice_number,rejection_reason,sri,created_at,confirmed_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                 ON CONFLICT (id) DO NOTHING`,
                [o.id, o.token||null, o.status, o.userId||null,
                 o.customerName, o.customerDoc, o.customerEmail, o.concept,
                 o.amount, o.subtotal||0, o.iva||0, o.ivaRate||15,
                 o.receiptUrl||null, o.notes||null, o.paymentMonth||null,
                 o.invoiceNumber||null, o.rejectionReason||null,
                 o.sri ? JSON.stringify(o.sri) : null,
                 o.createdAt||new Date().toISOString(), o.confirmedAt||null]
            );
            ordersOk++;
        } catch(e) { console.error(`  order ${o.id}:`, e.message); }
    }
    console.log(`  orders: ${ordersOk}/${orders.length} migrados`);

    /* ── Bank info ── */
    const info = jRead(path.join(DATA_DIR, 'bank-info.json'), null);
    if (info) {
        try {
            await pool.query(
                `INSERT INTO bank_info (id,bank_name,account_number,account_type,account_holder,
                                        ruc,address,email,phone,services)
                 VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
                [info.bankName||null, info.accountNumber||null, info.accountType||null,
                 info.accountHolder||null, info.ruc||null, info.address||null,
                 info.email||null, info.phone||null, JSON.stringify(info.services||[])]
            );
            console.log('  bank_info: migrado');
        } catch(e) { console.error('  bank_info:', e.message); }
    }

    /* ── Share links ── */
    const links = jRead(path.join(DATA_DIR, 'share-links.json'), []);
    let linksOk = 0;
    for (const l of links) {
        try {
            await pool.query(
                `INSERT INTO share_links (share_id,user_id,password_hash,label,active,created_at)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (share_id) DO NOTHING`,
                [l.shareId, l.userId, l.passwordHash, l.label||'',
                 l.active!==false, l.createdAt||new Date().toISOString()]
            );
            linksOk++;
        } catch(e) { console.error(`  share_link ${l.shareId}:`, e.message); }
    }
    console.log(`  share_links: ${linksOk}/${links.length} migrados`);

    /* ── Reset requests ── */
    const reqs = jRead(path.join(DATA_DIR, 'reset-requests.json'), []);
    let reqsOk = 0;
    for (const r of reqs) {
        try {
            await pool.query(
                `INSERT INTO reset_requests (id,user_id,username,requested_at,status)
                 VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
                [r.id, r.userId, r.username, r.requestedAt||new Date().toISOString(), r.status||'pending']
            );
            reqsOk++;
        } catch(e) { console.error(`  reset_request ${r.id}:`, e.message); }
    }
    console.log(`  reset_requests: ${reqsOk}/${reqs.length} migrados`);

    console.log('\n✅ Migración completada.');
    await pool.end();
}

migrate().catch(e => { console.error('Error fatal:', e); process.exit(1); });
