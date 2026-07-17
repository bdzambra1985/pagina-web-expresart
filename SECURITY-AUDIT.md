# Auditoría de seguridad — EXPRESART

Fecha: 2026-07-11 · Alcance: backend (Express/Node) y frontend (JS/HTML) + configuración.

Base sólida: sesiones en cookies `httpOnly` + `SameSite=strict`, CSP con `scriptSrc 'self'`,
SQL siempre parametrizado, escape de HTML/XML, validación de subidas por magic-bytes,
rate limiting y lockout de login. No se encontraron vulnerabilidades críticas de RCE ni
inyección SQL/XSS explotable directamente.

## Hallazgos y correcciones aplicadas

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| 1 | Alta | Contraseña de admin por defecto (`expresart2025`) si `EXP_ADMIN_PW` no está definida (`server.js`). | **Corregido** — el arranque falla en producción si `EXP_ADMIN_PW` no está seteada. |
| 2 | Alta | Hash de contraseñas con salt global único, sin salt por usuario (`utils/crypto.js`). | **Corregido** — PBKDF2 con salt aleatorio por usuario (formato `pbkdf2$iter$salt$hash`). Compatible con hashes legados; migración transparente al iniciar sesión. |
| 3 | Media | TLS de PostgreSQL con `rejectUnauthorized:false` en producción (`db.js`). | **Corregido** — configurable vía `DATABASE_CA_CERT` / `DATABASE_SSL_STRICT`. Default preserva compatibilidad. |
| 4 | Media | Allowlist de hosts de video sin anclar → bypass `youtube.com.evil.com` (`routes/profiles.js`). | **Corregido** — regex anclado con `(\/\|$)`. |
| 5 | Media | `_getEmbedUrl` inserta la URL cruda en un `<iframe>` si no reconoce el proveedor (`js/portafolio-alumno.js`). | **Corregido** — devuelve `null` y muestra un enlace en su lugar. |
| 8 | Baja | `receiptUrl`/`authReceiptUrl` sin escapar en `innerHTML` del panel admin (`js/admin.js`). | **Corregido** — envueltos con `esc()`. |
| 9 | Baja | Fuga de memoria menor: entradas de `loginAttempts` con solo `count` nunca se limpiaban (`middleware/auth.js`). | **Corregido** — GC limpia entradas obsoletas por timestamp. |

## Pendientes / aceptados (no modificados)

- **#6 `orderRoutes` montado también en `/`** (`server.js`) — expone rutas sin prefijo `/api`
  y se saltan `apiLimiter`. Cada ruta sensible tiene su propio guard/limitador, por lo que
  no es explotable; se deja para evitar riesgo de regresión. Recomendado: montar solo
  `/factura` en la raíz.
- **#7 CSP `styleSrc 'unsafe-inline'`** — necesario por el uso masivo de estilos inline;
  los scripts sí están bloqueados a `'self'`.
- **#10 `GET /api/share-links/:shareId/info` público** — divulga `userId`; impacto bajo.

## Segunda pasada — auditoría profunda (SRI, service worker, autorización)

Revisión adicional de firma electrónica SRI, service worker, `migrate.js`, HTML
(sin handlers inline → OK con la CSP) y flujos de autorización.

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| 11 | **Alta** | **Escalada vía enlace compartido (IDOR).** El endpoint `/api/share-links/:id/auth` devuelve un token de sesión con `userId` del alumno y `role:'share'`. Cualquiera con la contraseña del enlace podía usar ese token como cookie `exp_session` y obtener acceso nivel-alumno: leer `/api/my-orders` (historial de pagos con datos personales), modificar el perfil, subir archivos y crear/borrar enlaces. Los enlaces debían ser solo-lectura. | **Corregido** — nuevo guard `requireMember` (admin\|alumno) que excluye sesiones `share`; aplicado a `/my-orders`, `/my-profile` (GET/POST), subidas, videos y todas las rutas de `share-links`. Verificado con test de integración (403). |
| 12 | Media | **Falta de saneamiento server-side del perfil.** `POST /api/my-profile` aceptaba `producciones`/`videos` arbitrarios (sin validar host de video, esquema de URL ni longitudes), permitiendo `javascript:`/`data:` en `href`/`src` y payloads grandes. La CSP mitigaba la ejecución, pero era defensa frágil. | **Corregido** — saneamiento server-side: imágenes solo `https:`/`/uploads/`, videos solo YouTube/Vimeo, y topes de longitud/cantidad. Verificado con test. |
| 13 | Baja | `add-video` sin tope de cantidad/longitud de título. | **Corregido** — máx. 30 videos, título ≤150. |

Revisado y sin problemas: firma XML del SRI (escape correcto, URLs fijas, sin
entrada de usuario en la URL); service worker (excluye `/api/` y `/uploads/` del
caché); mensajes de la bandeja de privacidad (escapados con `esc()` pese a venir
de emails externos); sin secretos ni handlers inline en el HTML.

## Buenas prácticas ya presentes

Cookies de sesión seguras; SQL parametrizado con allowlist de columnas en updates;
subidas validadas por magic-bytes (no por extensión); escape XML en facturas SRI;
lockout de login + rate limiting; respuesta uniforme en `reset-request` (anti-enumeración);
verificación de firma del webhook de Resend; comparación de tokens con `timingSafeEqual`;
sin secretos versionados; `npm audit` con 0 vulnerabilidades.
