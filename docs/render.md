# Render (beta) — compatibilidad y configuración

Estado: **preparación**. No hay servicios creados en Render. Borrador de Blueprint en
[`deploy/render/render.yaml`](../deploy/render/render.yaml) (fuera de la raíz a propósito: Render solo lee un
Blueprint cuando alguien lo crea en el Dashboard).

| Componente | Render | Notas |
|---|---|---|
| Web | Static Site (`runtime: static`) | build con `NODE_ENV=production` solo en el paso de build |
| API | Web Service (`runtime: docker`) | stage `api` del `Dockerfile` (`EMAILBOT_TARGET=api`) |
| Worker | Background Worker (`runtime: docker`) | stage `worker` del `Dockerfile` (`EMAILBOT_TARGET=worker`) |
| Redis | Key Value (Valkey 8) | `noeviction` + persistencia, solo red privada |
| Base de datos / Auth / Storage | Supabase Production (externo) | Render no lo crea ni lo modifica |

## Docker: selección del stage

El `Dockerfile` es multi-target (`api`, `worker`, `web`) y Render no puede pasar `--target`. Render construye
con BuildKit y convierte cada variable de entorno del servicio en un *build argument*, así que el stage se
elige con la variable `EMAILBOT_TARGET`:

- argumento global `ARG EMAILBOT_TARGET=target-required`;
- stage final `FROM ${EMAILBOT_TARGET} AS selected` (hereda usuario, `CMD`, `HEALTHCHECK` y puertos del stage
  elegido) que además rechaza cualquier valor distinto de `api`, `worker` o `web`;
- sin `--target` ni `EMAILBOT_TARGET`, el build falla con un mensaje explícito (nunca se construye nginx por
  error);
- `docker build --target api|worker|web` sigue funcionando igual.

| Servicio | Variable en Render | Imagen |
|---|---|---|
| API | `EMAILBOT_TARGET=api` | Node, `node apps/api/dist/server.js` |
| Worker | `EMAILBOT_TARGET=worker` | Node, `node apps/worker/dist/index.js` |
| Web (solo si se usara Docker) | `EMAILBOT_TARGET=web` + `VITE_*` | nginx sin root en 8080 |

La web sigue siendo un **Static Site** (decisión de arquitectura): no usa Docker. El stage `web` queda
disponible para un Web Service Docker, que sería otro tipo de servicio (con coste) y requeriría decidirlo.

Las demás variables (también las secretas) llegan al build como argumentos, pero el `Dockerfile` no declara
ningún `ARG` secreto, así que no se usan ni quedan en la imagen (comprobado con valores *canary*).

## Redis / Valkey

### Requisitos

| Ajuste | Valor | Por qué |
|---|---|---|
| Versión | Valkey 8 (instancias nuevas de Render) | BullMQ 5.81.5 detecta Valkey; mínimo Redis 5.0, recomendado 6.2 (Valkey 8 reporta `redis_version 7.2.4`) |
| `maxmemoryPolicy` | **`noeviction`** | el valor por defecto de Render es `allkeys-lru`: podría expulsar claves de colas, locks o schedulers. BullMQ avisa `IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"` (comprobado en local) |
| Persistencia | `journal-snapshot` (por defecto en planes de pago) | trabajos retrasados, reintentos y schedulers solo existen en Redis. **El plan `free` no tiene persistencia: no usarlo** |
| Plan | decisión de coste (por defecto `256mb`) | uso medido en las pruebas: < 2 MB; el volumen real depende de la retención (completados 24 h / 10 000, fallidos 7 días) |
| Acceso | `ipAllowList: []` | solo red privada; misma región que API y worker |
| URL | `fromService` → `connectionString` (`redis://red-…:6379`) | sin TLS dentro de la red privada; aceptada por la validación de producción (test añadido) |

### Verificación tras crear la instancia

Desde el *shell* de la API o del worker (red privada), sin imprimir la URL:

```bash
node -e "const R=require('ioredis');const r=new R(process.env.REDIS_URL);Promise.all([r.info('server'),r.info('memory'),r.info('persistence')]).then(a=>{console.log(a.join('\n').split('\n').filter(l=>/^(valkey_version|redis_version|maxmemory_policy|aof_enabled|rdb_last_bgsave_status)/.test(l)).join('\n'));r.disconnect()})"
```

Esperado: `maxmemory_policy:noeviction`. Además, en los logs del worker **no** debe aparecer
`Eviction policy is … It should be "noeviction"`. Pendiente de comprobar en Render (no verificable en local):
que `CLIENT SETNAME` e `INFO` estén permitidos (BullMQ los usa; si `INFO` falla, BullMQ no puede comprobar la
versión).

### Uso de Redis por EmailBot

| Componente | Comandos | Fichero |
|---|---|---|
| Nonces OAuth | `SET key 1 EX ttl NX` | `apps/api/src/infrastructure/nonces.ts` |
| Rate limit | `EVAL` (Lua: `INCR`, `PTTL`, `PEXPIRE`) | `apps/api/src/infrastructure/rate-limit-store.ts` |
| Realtime | `PUBLISH` (worker) / `SUBSCRIBE` (API), canal `emailbot:realtime` | `supabase-stores.ts`, `realtime.ts` |
| Readiness | `PING` | `server.ts`, worker `index.ts` |
| BullMQ 5.81.5 | `EVALSHA`/`EVAL` (scripts Lua: listas, sets, zsets, hashes, streams `XADD`/`XTRIM`), `BZPOPMIN`, `XREAD`, `CLIENT SETNAME`/`LIST`, `INFO`, `SCAN`, `MULTI` | interno |

Todos están disponibles en Valkey 8 (compatible con Redis 7.2). Prueba real contra Valkey 8.1 local:
ver el informe de compatibilidad de esta fase.

### Comportamiento sin Redis (comprobado)

- API: `/health` 200 (health check de Render), `/health/ready` 503; encolar falla al instante (los webhooks
  responden 503 y el proveedor reintenta); nonces OAuth fallan cerrados; rate limit pasa a contadores por
  instancia.
- Worker: `/readyz` 503, proceso vivo; reconecta solo al volver Redis; trabajos retrasados, schedulers y
  trabajos en curso se conservan (con persistencia).
- Ruido de logs: cada reintento de conexión registra un error (~100 líneas en 20 s) y las colas BullMQ sin
  *listener* de `error` escriben trazas en `console.error`.

## Health checks

| Servicio | Ruta en Render | Motivo |
|---|---|---|
| API | `/health` | liveness. **No** usar `/health/ready`: una caída de Redis haría que Render quitara tráfico (15 s) y reiniciara la API (60 s) sin arreglar nada |
| Worker | — | Render no hace health checks a Background Workers; reinicia el proceso si termina. No definir `WORKER_HEALTH_PORT` |
| Web | — | sitio estático |

## Proxy e IP del cliente (WARNING)

Todo el tráfico pasa por Cloudflare y los balanceadores de Render, que **añaden** (no filtran)
`X-Forwarded-For`. `TRUST_PROXY` debe ser un número de saltos, nunca `true` (con `true` la IP sale del valor
que envía el cliente y el rate limit se puede eludir). El número exacto no está documentado: verificarlo tras
crear la API comparando la IP registrada en los logs con la IP real.

## Variables de entorno

Leyenda: **SECRET** = nunca en logs, repositorio ni bundle; se introduce con `sync: false`.

### Web (solo build; todo acaba en el bundle público)

| Variable | Clase | Notas |
|---|---|---|
| `VITE_SUPABASE_URL` | PUBLIC · WEB BUILD ONLY | https |
| `VITE_SUPABASE_ANON_KEY` | PUBLIC · WEB BUILD ONLY | el build rechaza una service key |
| `VITE_API_URL` | PUBLIC · WEB BUILD ONLY | https; define `connect-src` de la CSP |
| `NODE_VERSION` | PUBLIC · WEB BUILD ONLY | `22` (Render usa Node 24 por defecto) |

### Compartidas API + worker

| Variable | Clase | Notas |
|---|---|---|
| `NODE_ENV` | PUBLIC · SHARED | `production` |
| `SUPABASE_URL` | PUBLIC · SHARED | https |
| `SUPABASE_SERVICE_ROLE_KEY` | SECRET · SHARED | |
| `REDIS_URL` | SECRET · SHARED | `fromService` (`connectionString`) |
| `TOKEN_ENCRYPTION_KEY` | SECRET · SHARED | **idéntica** en ambos (comparar `tokenEncryptionKeyFingerprint` en los logs). Guardar copia fuera de Render. No usar `generateValue`: se generaría una distinta por servicio |
| `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` | PUBLIC · SHARED | en **ambos** servicios: la API conecta la cuenta y el worker refresca los tokens |
| `GOOGLE_CLIENT_SECRET` / `MICROSOFT_CLIENT_SECRET` | SECRET · SHARED | ídem |
| `GOOGLE_REDIRECT_URI` / `MICROSOFT_REDIRECT_URI` | PUBLIC · SHARED | mismo origen que `API_PUBLIC_URL` |
| `MICROSOFT_TENANT` | PUBLIC · SHARED | `common` |
| `ATTACHMENTS_BUCKET` | PUBLIC · SHARED | `email-attachments` |
| `SUPABASE_HTTP_TIMEOUT_MS`, `PROVIDER_HTTP_TIMEOUT_MS` | PUBLIC · SHARED | opcionales |
| `SENTRY_DSN` | SECRET · SHARED (un DSN por servicio, opcional) | |
| `LOG_LEVEL` | PUBLIC · SHARED | opcional |

### Solo API

| Variable | Clase | Notas |
|---|---|---|
| `PORT` | PUBLIC · API ONLY | lo inyecta Render (10000); no definir |
| `API_HOST` | PUBLIC · API ONLY | `0.0.0.0` por defecto |
| `API_PUBLIC_URL`, `WEB_APP_URL`, `CORS_ORIGINS` | PUBLIC · API ONLY | https, obligatorias en producción |
| `TRUST_PROXY` | PUBLIC · API ONLY | número de saltos (ver arriba) |
| `RATE_LIMIT_MAX` | PUBLIC · API ONLY | 300 por defecto |
| `SUPABASE_ANON_KEY` | PUBLIC · API ONLY | |
| `OAUTH_STATE_SECRET` | SECRET · API ONLY | ≥ 32 caracteres aleatorios |
| `GMAIL_PUBSUB_OIDC_AUDIENCE` | PUBLIC · API ONLY | push de Gmail (V2): `https://api.emailbot.app/webhooks/gmail`, idéntica a la audiencia de la suscripción |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | PUBLIC · API ONLY | push de Gmail (V2): cuenta de servicio OIDC de la suscripción; junto con la anterior |
| `GMAIL_PUBSUB_VERIFICATION_TOKEN` | SECRET · API ONLY | heredada, no recomendada: si existe, todo push sin `?token=` recibe 401 |
| `MICROSOFT_WEBHOOK_CLIENT_STATE` | SECRET · API ONLY | más adelante |

### Solo worker

| Variable | Clase | Notas |
|---|---|---|
| `WORKER_EVENTS_CONCURRENCY`, `WORKER_PROCESSING_CONCURRENCY` | PUBLIC · WORKER ONLY | 5 / 10 |
| `WORKER_POLL_INTERVAL_MINUTES` | PUBLIC · WORKER ONLY | 5 (recuperación; no poner 0) |
| `GMAIL_PUBSUB_TOPIC` | PUBLIC · WORKER ONLY | push de Gmail (V2): `projects/<proyecto>/topics/<topic>`; sin ella, solo polling |
| `WORKER_WATCH_RENEW_INTERVAL_MINUTES` | PUBLIC · WORKER ONLY | 60 por defecto; no definir |
| `WORKER_MAX_ATTACHMENT_BYTES` | PUBLIC · WORKER ONLY | 25 MiB |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST` | PUBLIC · WORKER ONLY | no definir en Render |

## Web: cabeceras

El sitio estático no ejecuta nginx: las cabeceras de `deploy/web/security-headers.conf.template` se declaran en
el Blueprint (`headers`). La CSP completa va en el `<meta>` de `index.html`; la cabecera solo añade
`frame-ancestors 'none'` (las dos políticas se aplican a la vez). `csp-policy.txt` se publica junto al sitio
(contenido público). Pendiente de verificar en Render: la cabecera `Cache-Control` por defecto de `index.html`
(nginx usaba `no-cache`; Render invalida su CDN en cada deploy).

## Pendiente de verificar al crear la infraestructura

No verificable sin servicios reales:

- `maxmemory_policy:noeviction` en la instancia real (comando de la sección Redis).
- Persistencia real de Key Value (`journal-snapshot`).
- Permisos de `CLIENT SETNAME` e `INFO` en Render.
- Número real de saltos para `TRUST_PROXY`.
- Versión de pnpm que usa Render en el build del Static Site (`packageManager: pnpm@12.8.1`).
- `Cache-Control` real de `index.html` en el Static Site.
