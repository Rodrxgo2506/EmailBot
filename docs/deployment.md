# Despliegue

Base portable: un `Dockerfile` con tres targets (`api`, `worker`, `web`) y una configuración nginx genérica
para la web. Plataforma elegida para el beta: Render (ver [render.md](render.md)).

## Servicios

| Servicio | Imagen / build | Start | Puerto | Health |
|---|---|---|---|---|
| API | `docker build --target api .` | `node apps/api/dist/server.js` | `PORT` (plataforma) o `API_PORT`; 3000 por defecto | `GET /health` (vivo), `GET /health/ready` (Redis) |
| Worker | `docker build --target worker .` | `node apps/worker/dist/index.js` | ninguno de negocio; health opcional en `WORKER_HEALTH_PORT` o `PORT` | `GET /livez`, `GET /readyz` |
| Web | `docker build --target web --build-arg VITE_…` | nginx sin root | 8080 | `GET /healthz` |

Sin Docker (cualquier plataforma Node 22 + pnpm):

```bash
pnpm install --frozen-lockfile --filter "@emailbot/api..." --filter "@emailbot/worker..."
pnpm --filter "@emailbot/api..." --filter "@emailbot/worker..." run build
node apps/api/dist/server.js      # o apps/worker/dist/index.js
```

Web (salida estática en `apps/web/dist`, servir con fallback SPA a `index.html`):

```bash
NODE_ENV=production VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… VITE_API_URL=… \
  pnpm --filter "@emailbot/web..." run build
```

En plataformas que no admiten `--target` (Render), el stage se elige con el build arg `EMAILBOT_TARGET`
(`api`, `worker` o `web`): `docker build --build-arg EMAILBOT_TARGET=api .`. Sin target ni argumento, el build
falla con un error explícito. Ver [render.md](render.md).

Las instalaciones filtradas no instalan la raíz del monorepo (ni el binario del CLI de Supabase). En builds
con Turborepo, usar `--force`: `NODE_ENV` es *pass-through* y no forma parte del hash de caché.

## Puertos

- **API**: `PORT` (estándar de las plataformas) tiene prioridad; si no existe, `API_PORT`; si tampoco, 3000.
  Socket.IO usa el mismo puerto en la ruta `/realtime` (solo WebSocket: el proxy debe permitir *upgrade*;
  no hacen falta *sticky sessions*).
- **Worker**: no expone negocio. El endpoint de salud se activa si hay `WORKER_HEALTH_PORT` o `PORT`
  (`WORKER_HEALTH_HOST`, `0.0.0.0` por defecto); sin ninguno, queda desactivado (desarrollo local).

## Health checks

| Endpoint | Significado |
|---|---|
| API `GET /health` | proceso vivo (200 siempre) |
| API `GET /health/ready` | Redis responde (200) o no (503) |
| Worker `GET /livez` | proceso vivo |
| Worker `GET /readyz` | 200 si colas, schedulers y workers BullMQ están inicializados **y** Redis responde a PING (≤ 1 s); 503 con `{ checks: { initialized, redis } }` si no |
| Web `GET /healthz` | nginx sirve |

Si la inicialización del worker falla (por ejemplo Redis rechaza comandos), el proceso termina con código 1
para que la plataforma lo reinicie. SIGTERM/SIGINT cierran workers, colas, Redis y el endpoint de salud.

## Variables

Ver `.env.example` y la tabla completa del informe de preproducción. Resumen de secretos:

- Compartidos API + worker (idénticos): `TOKEN_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`,
  `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`.
- Solo API: `OAUTH_STATE_SECRET`.
- Web: solo valores públicos (`VITE_*`); el build rechaza una service key.

### TOKEN_ENCRYPTION_KEY

Base64 estándar de 32 bytes aleatorios (44 caracteres terminados en `=`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

API y worker usan el mismo validador (`encryptionKeyProblem` en `@emailbot/shared`) y no arrancan con una clave
ausente, mal formada o claramente no aleatoria; los mensajes nunca incluyen la clave. Ambos registran al
arrancar `tokenEncryptionKeyFingerprint` (HMAC truncado, no un fragmento de la clave): deben coincidir. Si el
worker no puede descifrar credenciales, marca la cuenta con `CREDENTIALS_UNREADABLE` y no reintenta. No hay
rotación de claves todavía (formato `v1`).

## Web: CSP y cabeceras

La CSP se calcula en el build a partir de `VITE_API_URL` y `VITE_SUPABASE_URL` (`apps/web/src/lib/csp.ts`):

- se inyecta como `<meta http-equiv="Content-Security-Policy">` en `index.html` (funciona en cualquier
  hosting estático);
- se emite en `csp-policy.txt`; la imagen `web` la envía además como cabecera junto con `frame-ancestors 'none'`
  (que no funciona en `<meta>`) y elimina el fichero.

Política (producción):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; font-src 'self' data:;
connect-src 'self' https://<api> wss://<api> https://<supabase>;
object-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'; worker-src 'none';
upgrade-insecure-requests
```

Excepciones justificadas:

- `style-src 'unsafe-inline'`: sonner (toasts) y react-remove-scroll (diálogos Radix) insertan `<style>` en
  tiempo de ejecución; un hosting estático no puede emitir *nonces* por respuesta. Los scripts siguen
  limitados a `'self'` (sin inline ni `eval`).
- `img-src https: data: blob:` y `font-src data:`: el HTML de los correos se muestra en un iframe `srcdoc`
  con `sandbox`, que hereda esta política; su propia CSP (más estricta) solo carga imágenes remotas cuando el
  usuario lo pide.

Cabeceras de la imagen `web` (`deploy/web/security-headers.conf.template`): CSP, `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` y HSTS. En
otro hosting estático hay que configurar las mismas cabeceras (la CSP ya viaja en el `<meta>`).

## Orden

1. Base de datos: migraciones 1–9 ya aplicadas en producción.
2. API → comprobar `/health/ready` = 200 y anotar `tokenEncryptionKeyFingerprint`.
3. Worker → `/readyz` = 200, log `EmailBot worker started` con la misma huella.
4. Web (build con `NODE_ENV=production`).
