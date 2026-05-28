// Migración única: transfiere datos de JSON a PostgreSQL.
// Ejecutar una sola vez: node migrate.js
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool, initDB } = require('./db');

const DATA_DIR = path.join(__dirname, 'data');

function readJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return fallback; }
}

async function migrate() {
    console.log('\n  Inicializando esquema…');
    await initDB();

    /* ── Usuarios ── */
    const users = readJSON(path.join(DATA_DIR, 'users.json'), []);
    console.log(`  Migrando ${users.length} usuario(s)…`);
    for (const u of users) {
        await pool.query(
            `INSERT INTO users (user_id, username, password_hash, role, active, created_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id) DO NOTHING`,
            [u.userId, u.username, u.passwordHash, u.role, u.active, u.createdAt || new Date()]
        );
    }

    /* ── Perfiles ── */
    const profilesDir = path.join(DATA_DIR, 'profiles');
    if (fs.existsSync(profilesDir)) {
        const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
        console.log(`  Migrando ${files.length} perfil(es)…`);
        for (const file of files) {
            const p = readJSON(path.join(profilesDir, file), null);
            if (!p || !p.userId) continue;
            const userExists = await pool.query('SELECT 1 FROM users WHERE user_id=$1', [p.userId]);
            if (!userExists.rows.length) continue;
            await pool.query(
                `INSERT INTO profiles (user_id, display_name, bio, bio_short, photo_url, especialidades, producciones, videos)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (user_id) DO UPDATE SET
                     display_name=$2, bio=$3, bio_short=$4, photo_url=$5,
                     especialidades=$6, producciones=$7, videos=$8`,
                [
                    p.userId,
                    p.displayName   || '',
                    p.bio           || '',
                    p.bio_short     || '',
                    p.photoUrl      || '',
                    JSON.stringify(p.especialidades || []),
                    JSON.stringify(p.producciones   || []),
                    JSON.stringify(p.videos         || [])
                ]
            );
        }
    }

    /* ── Eventos ── */
    const events = readJSON(path.join(DATA_DIR, 'events.json'), []);
    console.log(`  Migrando ${events.length} evento(s)…`);
    for (const ev of events) {
        if (!ev.id || !ev.title || !ev.date) continue;
        await pool.query(
            `INSERT INTO events (id, title, event_date, event_time, location, description, category, audience, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO NOTHING`,
            [
                ev.id, ev.title, ev.date,
                ev.time        || '',
                ev.location    || '',
                ev.description || '',
                ev.category    || 'otro',
                ev.audience    || 'publico',
                ev.createdAt   || new Date()
            ]
        );
    }

    /* ── Contenido del sitio ── */
    const content = readJSON(path.join(DATA_DIR, 'content.json'), {});
    if (Object.keys(content).length > 0) {
        console.log('  Migrando contenido del sitio…');
        await pool.query(
            `INSERT INTO site_content (key, value) VALUES ('global', $1)
             ON CONFLICT (key) DO UPDATE SET value=$1`,
            [JSON.stringify(content)]
        );
    }

    console.log('\n  ✓ Migración completada.\n');
    await pool.end();
}

migrate().catch(err => {
    console.error('\n  Error en migración:', err.message, '\n');
    process.exit(1);
});
