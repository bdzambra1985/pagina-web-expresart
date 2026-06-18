# EXPRESART — Cómo desplegarlo en producción

> Guía técnica: optimizaciones aplicadas, observaciones de seguridad,
> migración a PostgreSQL y configuración de hosting seguro.

---

## 1. Optimizaciones ya aplicadas en este commit

### Rendimiento

- **Compresión gzip (`compression`)** — Todo el HTML, CSS y JSON viaja comprimido.
  `style.css` bajó de 55 KB → 12 KB (78% menos). Los usuarios en conexiones
  lentas (móvil) lo notarán inmediatamente.

- **Cache de activos estáticos** — CSS, JS e imágenes tienen
  `Cache-Control: public, max-age=604800` (7 días). El navegador no los vuelve
  a descargar en visitas repetidas.

- **HTML con `no-cache`** — Las páginas `.html` siempre se revalidan para que
  los cambios lleguen al usuario sin quedar pegados en una versión vieja.

### Seguridad

- **`helmet`** — Agrega automáticamente más de 10 cabeceras de seguridad
  estándar OWASP: `X-Frame-Options`, `X-Content-Type-Options`,
  `Strict-Transport-Security`, `X-DNS-Prefetch-Control`, `Permissions-Policy`
  y otras. Reemplaza los 4 headers manuales que existían antes.

- **`express-rate-limit`** — Rate limiting real con limpieza automática:
  - Login: máximo 10 intentos por IP en 15 minutos.
  - API general: máximo 120 peticiones por IP por minuto.

- **`X-Powered-By: Express` eliminado** — Helmet lo quita automáticamente para
  no revelar el stack tecnológico a posibles atacantes.

---

## 2. Observaciones y recomendaciones

### Crítico — resolver lo antes posible

| Problema | Riesgo | Solución |
|---|---|---|
| **Node.js 12 (EOL desde 2022)** | Sin parches de seguridad desde hace 3 años. CVEs sin corregir en OpenSSL y V8. | Migrar a Node 20 LTS. Instrucciones en la sección 4. |
| **Salt de contraseñas hardcodeado** | Si alguien lee el código en GitHub, puede precalcular hashes. | Mover a variable de entorno `EXP_SALT` con valor aleatorio. Instrucciones en la sección 5. |
| **Contraseña admin por defecto** (`expresart2025`) | Cualquiera que lea el repositorio conoce las credenciales. | Definir `EXP_ADMIN_PW` en Railway con una contraseña fuerte. |
| **Sesiones en memoria (RAM)** | Se pierden en cada deploy o reinicio del servidor. Los usuarios quedan deslogueados. | Migrar a JWT firmado o Redis. |
| **Almacenamiento en JSON plano** | Sin transacciones — si el servidor cae mientras escribe, el archivo queda corrupto. | Migrar a PostgreSQL (guía en sección 3). |

### Recomendable a mediano plazo

- **Imágenes sin optimizar**: `logo.png` (159 KB) y `gemelos.png` (181 KB)
  podrían convertirse a WebP y bajar ~70%. Herramienta gratuita: https://squoosh.app

- **Uploads sin validación de contenido real**: Se valida la extensión del
  archivo pero no su contenido real. Un atacante podría renombrar un archivo
  malicioso a `.jpg`. Solución: usar la librería `file-type` para verificar
  los bytes reales del archivo.

- **Logs sin persistencia**: Los errores del servidor desaparecen al reiniciar.
  Railway guarda logs temporalmente. Para retenerlos usar `railway logs` o
  conectar Papertrail (gratis hasta 50 MB/mes).

---

## 3. Migración a PostgreSQL

### Por qué migrar

Los archivos JSON actuales (`users.json`, `events.json`, `content.json`) no son
una base de datos real. No tienen transacciones, no escalan y pueden corromperse.
PostgreSQL es gratuito en Railway hasta 1 GB y resuelve todos esos problemas.

### Paso 1 — Instalar el cliente de PostgreSQL

```bash
npm install pg
```

### Paso 2 — Esquema SQL

Guardar como `schema.sql` en la raíz del proyecto y ejecutarlo una vez en la
base de datos de producción.

```sql
-- Usuarios del sistema
CREATE TABLE users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'alumno',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Perfiles de alumnos
CREATE TABLE profiles (
    user_id        TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    display_name   TEXT,
    bio            TEXT,
    bio_short      TEXT,
    photo_url      TEXT,
    especialidades JSONB DEFAULT '[]',
    producciones   JSONB DEFAULT '[]',
    videos         JSONB DEFAULT '[]'
);

-- Eventos de la agenda
CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    date        DATE NOT NULL,
    time        TEXT,
    location    TEXT,
    description TEXT,
    category    TEXT DEFAULT 'otro',
    audience    TEXT DEFAULT 'publico',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Contenido editable del sitio
CREATE TABLE content (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- Índice para búsquedas por fecha en la agenda
CREATE INDEX idx_events_date ON events(date);
```

### Paso 3 — Reemplazar las funciones de lectura/escritura en server.js

Reemplazar las funciones `readJSON`/`writeJSON` por consultas con `pg`.
Ejemplo para eventos (el mismo patrón aplica a usuarios y perfiles):

```js
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Leer todos los eventos
async function readEvents() {
    const { rows } = await pool.query('SELECT * FROM events ORDER BY date ASC');
    return rows;
}

// Crear un evento
async function createEvent(event) {
    await pool.query(
        `INSERT INTO events (id, title, date, time, location, description, category, audience)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [event.id, event.title, event.date, event.time,
         event.location, event.description, event.category, event.audience]
    );
}

// Actualizar un evento
async function updateEvent(id, fields) {
    await pool.query(
        `UPDATE events SET title=$1, date=$2, time=$3, location=$4,
         description=$5, category=$6, audience=$7 WHERE id=$8`,
        [fields.title, fields.date, fields.time, fields.location,
         fields.description, fields.category, fields.audience, id]
    );
}

// Eliminar un evento
async function deleteEvent(id) {
    await pool.query('DELETE FROM events WHERE id=$1', [id]);
}
```

> **IMPORTANTE**: Siempre usar parámetros (`$1`, `$2`...) — nunca concatenar
> strings en las consultas SQL. Es la protección principal contra SQL Injection.

Todas las rutas del servidor deben volverse `async/await` ya que las consultas
a la base de datos son asíncronas. Es un refactor de aproximadamente 2-3 horas.

### Paso 4 — Crear la base de datos en Railway

1. Abrir el proyecto en https://railway.app
2. Clic en **+ New** → **Database** → **PostgreSQL**
3. Railway agrega automáticamente la variable `DATABASE_URL` al servicio.
4. Para ejecutar el esquema desde tu máquina local:
   ```bash
   # Copiar DATABASE_URL desde Railway → Variables
   psql "postgresql://usuario:contraseña@host:puerto/nombre_db" -f schema.sql
   ```

### Paso 5 — Migrar los datos existentes

Antes de hacer el deploy con PostgreSQL, migrar los datos de los JSON actuales:

```js
// Script de migración — ejecutar una sola vez: node migrate.js
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
    const users  = JSON.parse(fs.readFileSync('data/users.json', 'utf8'));
    const events = JSON.parse(fs.readFileSync('data/events.json', 'utf8'));

    for (const u of users) {
        await pool.query(
            'INSERT INTO users (user_id, username, password_hash, role, active, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [u.userId, u.username, u.passwordHash, u.role, u.active, u.createdAt]
        );
    }

    for (const ev of events) {
        await pool.query(
            'INSERT INTO events (id, title, date, time, location, description, category, audience) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
            [ev.id, ev.title, ev.date, ev.time || '', ev.location || '', ev.description || '', ev.category || 'otro', ev.audience || 'publico']
        );
    }

    console.log('Migración completada.');
    await pool.end();
}

migrate().catch(console.error);
```

---

## 4. Actualizar Node.js a la versión 20 LTS

### Por qué es urgente

Node 12 llegó al fin de vida en abril de 2022. No recibe parches de seguridad.
Node 20 tiene soporte hasta abril de 2026.

### Cómo hacerlo

**En `package.json`** agregar:

```json
"engines": {
    "node": ">=20.0.0"
}
```

Railway detecta esto automáticamente en el próximo deploy y usa Node 20.

**En tu máquina local** (para desarrollo):

```bash
# Instalar nvm si no lo tienes
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Instalar y usar Node 20
nvm install 20
nvm use 20

# Verificar
node --version  # debe mostrar v20.x.x

# Reinstalar dependencias con la nueva versión
npm install
```

---

## 5. Variables de entorno en Railway (configuración segura)

### Variables obligatorias

Ir a Railway → tu proyecto → **Variables** y definir:

| Variable | Descripción | Ejemplo |
|---|---|---|
| `EXP_SALT` | Salt para hashing de contraseñas | (ver comando abajo) |
| `EXP_ADMIN_PW` | Contraseña del administrador | Mínimo 20 caracteres, mezclar mayúsculas, números y símbolos |
| `DATABASE_URL` | URL de conexión a PostgreSQL | Railway la agrega automáticamente |
| `NODE_ENV` | Entorno de ejecución | `production` |

### Generar el salt seguro

Ejecutar en la terminal y copiar el resultado a Railway:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Nunca hacer esto

- No subir un archivo `.env` al repositorio.
- No dejar las contraseñas por defecto en producción.
- No hardcodear credenciales en el código fuente.

### Agregar `.env` al `.gitignore`

```bash
echo ".env" >> .gitignore
```

---

## 6. Protección contra los ataques más comunes

### HTTPS

Railway ya lo maneja automáticamente con certificados Let's Encrypt.
El dominio `*.up.railway.app` siempre es HTTPS. Si conectas un dominio
propio, Railway también genera el certificado sin costo adicional.

### Tabla de protecciones

| Ataque | Estado actual | Notas |
|---|---|---|
| **SQL Injection** | N/A (sin SQL aún) | Al migrar a PostgreSQL: siempre usar parámetros `$1,$2`, nunca concatenar strings |
| **XSS (Cross-Site Scripting)** | Parcial (helmet) | Activar Content Security Policy estricta cuando el sitio esté estable |
| **Brute force en login** | ✅ 10 intentos / 15 min por IP | |
| **Clickjacking** | ✅ X-Frame-Options | |
| **Path traversal en uploads** | ✅ Validación regex en userId | |
| **Exposición del stack** | ✅ X-Powered-By eliminado | |
| **DDoS básico** | ✅ 120 req/min por IP en la API | Para protección avanzada: agregar Cloudflare gratis frente a Railway |
| **Archivos maliciosos en uploads** | Parcial (solo extensión) | Agregar validación de tipo MIME real con `file-type` |

### Cloudflare (opcional pero recomendado)

Si se conecta un dominio propio, pasar el tráfico por Cloudflare (gratis):
- Protege contra DDoS
- Agrega otra capa de WAF (firewall de aplicaciones web)
- CDN global — el sitio carga más rápido desde cualquier país
- Oculta la IP real del servidor Railway

---

## 7. Backups

### Con PostgreSQL en Railway

Railway → PostgreSQL → **Settings** → **Backups** → activar daily backups.
Los backups son automáticos y gratuitos en el plan Hobby.

### Backups manuales de los archivos actuales (JSON)

Mientras no se migre a PostgreSQL, hacer backups manuales periódicos:

```bash
# Comprimir y descargar los datos
tar -czf backup-$(date +%Y%m%d).tar.gz data/ uploads/
```

---

## 8. Checklist de deploy a producción

- [ ] Definir `EXP_SALT` en Railway con valor aleatorio (64 caracteres hex)
- [ ] Definir `EXP_ADMIN_PW` con contraseña fuerte (≥20 caracteres)
- [ ] Definir `NODE_ENV=production` en Railway
- [ ] Actualizar `engines.node` a `>=20.0.0` en package.json
- [ ] Crear base de datos PostgreSQL en Railway
- [ ] Ejecutar `schema.sql` en la base de datos
- [ ] Ejecutar script de migración de JSON a PostgreSQL
- [ ] Verificar que HTTPS funciona en el dominio
- [ ] Verificar que el admin puede iniciar sesión
- [ ] Verificar que los eventos aparecen en la agenda
- [ ] Verificar que los alumnos pueden ver su portafolio
- [ ] Activar backups automáticos en Railway PostgreSQL

---

*Generado el 2026-05-28 — EXPRESART Escuela de Actuación*
