# Auditoría de seguridad — EXPRESART

## Segunda ronda — 2026-07-31

Revisión a partir de *Cyber Security Essentials* (Graham, Howard & Olson, 2011),
cruzando los capítulos 1 (fundamentos: autenticación, criptografía,
confidencialidad), 3 (explotación) y 5 (defensa y análisis) contra el código.

> **Nota:** este archivo ya no se sirve por HTTP. Antes era accesible en
> `/SECURITY-AUDIT.md` — es decir, la lista de debilidades conocidas del sitio
> estaba publicada. Ver hallazgo #2.

### Hallazgos y correcciones

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| 1 | **Alta** | `backups/` era descargable sin autenticación: `express.static(__dirname)` servía toda la raíz y la lista negra no lo incluía. El snapshot lleva `users` con `passwordHash` y todos los pedidos con datos de clientes. | **Corregido** — ver #2. Además `backups/` añadido a `.gitignore` (no estaba) y los archivos locales se escriben con modo `0600`. |
| 2 | **Alta** | Lista negra en vez de lista blanca para estáticos. Quedaban expuestos `SECURITY-AUDIT.md`, `como_desplegarlo_en_produccion.md`, `start.sh`, `entradas_cortesia/*.js` y los manuales. | **Corregido** — todo lo público vive en `public/`; el servidor solo sirve ese directorio. Los archivos nuevos en la raíz ya no se publican solos. |
| 3 | Media | Respaldos sin cifrar (solo gzip), subidos a R2 con hashes y PII. | **Corregido** — AES-256-GCM (`utils/backup.js`). GCM además detecta manipulación. Los respaldos previos sin cifrar se siguen pudiendo descargar. |
| 4 | Media | PBKDF2-SHA256 con 100 000 iteraciones — barato de atacar con GPU (cap. 3.1.10). | **Corregido** — scrypt (N=65536, r=8, p=1), *memory-hard*. Migración transparente en el login. Se usa la variante **asíncrona**: la síncrona bloqueaba el event loop ~300 ms por intento, lo que convertía el propio login en un vector de DoS. |
| 5 | Media | Sin segundo factor para el administrador (cap. 1.1.1.1). | **Corregido** — TOTP opcional (`utils/totp.js`, RFC 6238, verificado contra los vectores oficiales), con QR, códigos de recuperación de un solo uso y límite de intentos por desafío. Implementado sobre `crypto` para no añadir una dependencia en la ruta de autenticación. |
| 6 | Media | Sin token CSRF: la protección dependía por completo de `SameSite=strict`. | **Corregido** — double-submit (`middleware/csrf.js`). El frontend envuelve `window.fetch` una vez en `common.js` en lugar de tocar los ~40 puntos de llamada. |
| 7 | Media | `unpkg.com` (boxicons) sin SRI en 8 páginas y permitido en `styleSrc`/`fontSrc`/`connectSrc` (cap. 4, cadena de suministro). | **Corregido** — auto-hospedado en `public/vendor/`; unpkg eliminado del CSP. |
| 8 | Media | PDFs de comprobantes servidos inline desde el propio origen (cap. 3.1.6, PDFs maliciosos). | **Corregido** — `Content-Disposition: attachment` + CSP restrictiva para PDFs bajo `/uploads`. Las imágenes siguen inline (ya validadas por magic-bytes y reencodadas con sharp). |
| 9 | Media | Sesiones y bloqueos de login solo en memoria: cada reinicio deslogueaba a todos **y borraba los bloqueos por fuerza bruta** — bastaba esperar un despliegue para reintentar. | **Corregido** — escritura pasante a Postgres (o a `data/` en modo JSON) y recarga al arrancar. *Limitación conocida: no comparte estado entre varias instancias del proceso; eso exigiría volver `getSession` asíncrono (53 puntos de llamada en 7 archivos).* |
| 10 | Media | Logs de seguridad solo a `stdout`: sin persistencia no hay investigación posible (cap. 5). | **Corregido** — `utils/securityLog.js` escribe JSONL rotado a 90 días, alerta por email en eventos críticos (con antirebote) y se consulta desde el panel admin. |
| 11 | Baja | `PUT /api/users/:userId` hasheaba `password` sin validar nada, mientras que la creación sí exigía 10 caracteres con letras y números. | **Corregido** — `validatePassword()` como única fuente de verdad en los tres endpoints. |
| 12 | Baja | Cookies sin prefijo `__Host-` (permite *cookie tossing* desde un subdominio). | **Corregido** — `utils/cookies.js`; el prefijo se aplica en producción, donde hay HTTPS. |
| 13 | Baja | `orderRoutes` montado también en `/`, duplicando cada endpoint de pedidos fuera de `apiLimiter` (era el #6 pendiente de la ronda anterior). | **Corregido** — en la raíz solo se expone `/factura/`. |
| 14 | Baja | Sin tope de longitud de contraseña: una de varios MB es trabajo de hashing gratis para el atacante. | **Corregido** — 200 caracteres. |
| 15 | Baja | `npm audit`: DoS en `body-parser`. | **Corregido** — `npm audit fix`, 0 vulnerabilidades. |

### Pendiente — requiere acción fuera del código

- **SPF / DKIM / DMARC para `expresart.ec`** (cap. 2.2.1, phishing). Se envían
  correos a los alumnos vía Resend; sin un DMARC en `p=reject` cualquiera puede
  suplantar el dominio para phishearlos. Es configuración DNS.
- **`BACKUP_ENCRYPTION_KEY`**: hoy la clave se deriva de `EXP_SIGN_SECRET`. Conviene
  definir una propia y guardarla fuera del servidor — si se pierde, los respaldos
  cifrados son irrecuperables.
- **Respaldos antiguos en R2**: los anteriores a este cambio están sin cifrar.
  Conviene rotarlos.

### Aceptado

- **CSP `styleSrc 'unsafe-inline'`** — necesario por el uso masivo de estilos
  inline. Los scripts sí están limitados a `'self'`.
- **`GET /api/share-links/:shareId/info` público** — divulga `userId`; impacto bajo.

---

## Primera ronda — 2026-07-11

Alcance: backend (Express/Node) y frontend (JS/HTML) + configuración.

Base sólida: sesiones en cookies `httpOnly` + `SameSite=strict`, CSP con `scriptSrc 'self'`,
SQL siempre parametrizado, escape de HTML/XML, validación de subidas por magic-bytes,
rate limiting y lockout de login. No se encontraron vulnerabilidades críticas de RCE ni
inyección SQL/XSS explotable directamente.

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| 1 | Alta | Contraseña de admin por defecto (`expresart2025`) si `EXP_ADMIN_PW` no está definida (`server.js`). | **Corregido** — el arranque falla en producción si `EXP_ADMIN_PW` no está seteada. |
| 2 | Alta | Hash de contraseñas con salt global único, sin salt por usuario (`utils/crypto.js`). | **Corregido** — PBKDF2 con salt aleatorio por usuario. *(Superado en la 2ª ronda: ahora scrypt.)* |
| 3 | Media | TLS de PostgreSQL con `rejectUnauthorized:false` en producción (`db.js`). | **Corregido** — configurable vía `DATABASE_CA_CERT` / `DATABASE_SSL_STRICT`. |
| 4 | Media | Allowlist de hosts de video sin anclar → bypass `youtube.com.evil.com` (`routes/profiles.js`). | **Corregido** — regex anclado con `(\/\|$)`. |
| 5 | Media | `_getEmbedUrl` inserta la URL cruda en un `<iframe>` si no reconoce el proveedor (`js/portafolio-alumno.js`). | **Corregido** — devuelve `null` y muestra un enlace en su lugar. |
| 8 | Baja | `receiptUrl`/`authReceiptUrl` sin escapar en `innerHTML` del panel admin (`js/admin.js`). | **Corregido** — envueltos con `esc()`. |
| 9 | Baja | Fuga de memoria menor: entradas de `loginAttempts` con solo `count` nunca se limpiaban (`middleware/auth.js`). | **Corregido** — GC limpia entradas obsoletas por timestamp. |

### Buenas prácticas ya presentes

Cookies de sesión seguras; SQL parametrizado con allowlist de columnas en updates;
subidas validadas por magic-bytes (no por extensión); escape XML en facturas SRI;
lockout de login + rate limiting; respuesta uniforme en `reset-request` (anti-enumeración);
verificación de firma del webhook de Resend; comparación de tokens con `timingSafeEqual`;
sin secretos versionados.
