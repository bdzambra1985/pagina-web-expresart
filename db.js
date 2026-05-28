require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id       TEXT PRIMARY KEY,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'alumno',
            active        BOOLEAN NOT NULL DEFAULT TRUE,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS profiles (
            user_id        TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
            display_name   TEXT    DEFAULT '',
            bio            TEXT    DEFAULT '',
            bio_short      TEXT    DEFAULT '',
            photo_url      TEXT    DEFAULT '',
            especialidades JSONB   DEFAULT '[]',
            producciones   JSONB   DEFAULT '[]',
            videos         JSONB   DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS events (
            id           TEXT PRIMARY KEY,
            title        TEXT NOT NULL,
            event_date   DATE NOT NULL,
            event_time   TEXT DEFAULT '',
            location     TEXT DEFAULT '',
            description  TEXT DEFAULT '',
            category     TEXT DEFAULT 'otro',
            audience     TEXT DEFAULT 'publico',
            created_at   TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS site_content (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    `);
}

module.exports = { pool, initDB };
