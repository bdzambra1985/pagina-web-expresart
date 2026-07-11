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

## Buenas prácticas ya presentes

Cookies de sesión seguras; SQL parametrizado con allowlist de columnas en updates;
subidas validadas por magic-bytes (no por extensión); escape XML en facturas SRI;
lockout de login + rate limiting; respuesta uniforme en `reset-request` (anti-enumeración);
verificación de firma del webhook de Resend; comparación de tokens con `timingSafeEqual`;
sin secretos versionados; `npm audit` con 0 vulnerabilidades.
