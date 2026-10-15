# Render — compatibilidad y configuración

Estado: **en producción**. Servicios: `emailbot-api` (Web Service, Docker), `emailbot-web` (Static Site,
`https://emailbot.app`), `emailbot-worker` (Background Worker, Docker) y Redis (Key Value). Los despliegues son
manuales desde `main` (`autoDeployTrigger: off`). La API responde en `https://api.emailbot.app`. Referencia de
Blueprint en [`deploy/render/render.yaml`](../deploy/render/render.yaml) (fuera de la raíz a propósito: Render
solo lee un Blueprint cuando alguien lo crea en el Dashboard). Operación e incidentes:
[`docs/operations.md`](operations.md).

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
| Versión | Valkey 8 (instancias nuevas de Render); **observado 8.1.10** el 2026-10-15 | BullMQ 5.81.5 detecta Valkey; mínimo Redis 5.0, recomendado 6.2 (Valkey 8 reporta `redis_version 7.2.4`) |
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

Esperado: `maxmemory_policy:noeviction`. Este comando no muestra `maxmemory`, la topología (`cluster_enabled`) ni la
salud de AOF / RDB; la versión ampliada (solo lectura) está en
[`docs/imap-production-readiness.md`](imap-production-readiness.md), sección 1. **Consulta real del 2026-10-15**
(ejecutada por el usuario con esa versión ampliada desde el *shell* de `emailbot-api`): Valkey 8.1.10
(`redis_version 7.2.4`), `maxmemory` 256 MiB, `maxmemory_policy:noeviction`, AOF activo con últimos estados `ok`,
último RDB `ok`, `cluster_enabled:0` (detalle, interpretación y límites en ese documento). Además, en los logs del
worker **no** debe aparecer
`Eviction policy is … It should be "noeviction"`. Pendiente de comprobar en Render (no verificable en local):
que `CLIENT SETNAME` e `INFO` estén permitidos (BullMQ los usa; si `INFO` falla, BullMQ no puede comprobar la
versión).

### Uso de Redis por EmailBot

| Componente | Comandos | Fichero |
|---|---|---|
| Nonces OAuth | `SET key 1 EX ttl NX` | `apps/api/src/infrastructure/nonces.ts` |
| Rate limit | `EVAL` (Lua: `INCR`, `PTTL`, `PEXPIRE`) | `apps/api/src/infrastructure/rate-limit-store.ts` |
| Bloqueo de login (portal; IMAP) | `EVAL` (Lua: `INCR`, `PEXPIRE`, `SET … PX`, `DEL`, `PTTL`; un script usa 2 claves: instancia única, no Cluster) | `apps/api/src/infrastructure/login-throttle.ts` |
| Límites IMAP (desactivado) | `EVAL` (Lua: `INCR`, `DECR`, `GET`, `PTTL`, `PEXPIRE`) | `apps/api/src/modules/email-accounts/imap-connection.ts`; ver `docs/imap-production-readiness.md` |
| Realtime | `PUBLISH` (worker) / `SUBSCRIBE` (API), canal `emailbot:realtime` | `supabase-stores.ts`, `realtime.ts` |
| Lock de sincronización (worker) | `SET … PX NX`, `EVAL` (compara y borra) | worker `sync-lock.ts` |
| Readiness | `PING` | `server.ts`, worker `index.ts` |
| BullMQ 5.81.5 | `EVALSHA`/`EVAL` (scripts Lua: listas, sets, zsets, hashes, streams `XADD`/`XTRIM`), `BZPOPMIN`, `XREAD`, `CLIENT SETNAME`/`LIST`, `INFO`, `SCAN`, `MULTI` | interno |

Todos están disponibles en Valkey 8 (compatible con Redis 7.2). Prueba real contra Valkey 8.1 local:
ver el informe de compatibilidad de esta fase.

### Redis de aplicación del worker (F5.2)

El worker abre tres clientes ioredis (6 conexiones: BullMQ añade una bloqueante por worker):

| Cliente | Usos | Opciones | Si Redis no responde |
|---|---|---|---|
| BullMQ | los 3 workers y las colas (productores y *schedulers*) | `maxRetriesPerRequest: null`, cola *offline*, sin `commandTimeout` (sin cambios: los workers lo exigen y una cola BullMQ que falla al inicializarse queda inservible) | espera a Redis. Cada llamada de productor se acota a `WORKER_REDIS_COMMAND_TIMEOUT_MS`; los *schedulers* del arranque esperan |
| Aplicación | lock de sincronización, `PING` de `/readyz` | `commandTimeout` = `WORKER_REDIS_COMMAND_TIMEOUT_MS`, `enableOfflineQueue: false`, `autoResendUnfulfilledCommands: false`, `maxRetriesPerRequest: 0` | el comando falla dentro del límite |
| Publicador realtime | `PUBLISH` | las mismas | igual; la fase de cancelación del apagado lo desconecta |

`apps/worker/src/infrastructure/app-redis.ts`. Un fallo nunca cuenta como éxito: el trabajo falla y BullMQ lo
reintenta. El resultado se clasifica:

- **No enviado**: la conexión no estaba lista (se espera como mucho el límite) o se rechaza al instante. Sin cola
  *offline* ni reenvío, un comando no enviado no se ejecuta nunca más tarde.
- **Rechazado**: Redis respondió con un error.
- **Desconocido**: el comando se escribió y no hubo respuesta en el límite (o la conexión cayó). Redis puede
  ejecutarlo más tarde. Solo se reintentan operaciones idempotentes:
  - lock: si la adquisición queda en desconocido se libera en el acto nuestro token (compara y borra); en la misma
    conexión se ejecuta después del `SET`, así que un `SET` tardío no deja un lease huérfano (sin esa liberación
    bloquearía la cuenta hasta su TTL de 15 min). Solo borra si el valor es nuestro token, nunca el lease de otro
    proceso. Si la conexión se pierde entre el `SET` y la liberación, esta se envía por la conexión nueva; si Redis
    sigue inalcanzable durante el límite, no se envía y el lease tardío dura su TTL (probado);
  - `PUBLISH`: el evento puede llegar dos veces (al menos una vez); el correo no pasa a `PROCESSED` hasta que se
    publica sin error. Solo la API lo consume y lo reenvía por Socket.IO sin guardarlo: el panel ignora un
    `email.processed` o `notification` repetido (por id, en cada pestaña) y el portal solo vuelve a cargar la
    bandeja;
  - productores: los `jobId` son deterministas (procesamiento, notificación, *watch*) y la sincronización se
    agrupa por cuenta, así que el reintento no duplica trabajos. Un `SYNC_ACCOUNT` puede encolarse o eliminarse
    tarde; el reintento del trabajo y el sondeo cada 5 min lo cubren, y el cursor (CAS) impide perder correo.

Limitaciones: ioredis conserva los comandos ya rechazados por tiempo hasta que llega su respuesta o se cierra la
conexión (memoria pequeña, sin promesas pendientes). Una conexión abierta pero muda hace fallar cada comando en su
límite hasta que se cierra (sin *keepalive* TCP configurado). La conexión de BullMQ sigue sin límite por diseño.
La API no cambia en F5.2.

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
| Worker | — | Render no hace health checks a Background Workers; reinicia el proceso si termina. No definir `WORKER_HEALTH_PORT`. Un worker vivo pero sin consumir se detecta desde fuera con `GET /health/sync` de la API (`stalled` / `stale`) |
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
| `SENTRY_DSN` | SECRET · SHARED (un DSN por servicio, opcional) | sin ella Sentry queda desactivado. Los eventos salen sin cabeceras, cookies, cuerpos, *query strings*, datos de usuario ni *breadcrumbs* de red, y con direcciones y tokens enmascarados (`packages/shared/src/sentry.ts`) |
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
| `RESEND_API_KEY` | SECRET · API ONLY | correos del Libro de Reclamaciones (copia de la hoja al consumidor y respuestas) por la API HTTP de Resend. Clave con acceso de envío (*sending access*), idealmente limitada al dominio `emailbot.app`; se crea en Resend → API Keys. Junto con la siguiente; sin ellas las hojas se registran igual y sus correos quedan pendientes |
| `TRANSACTIONAL_EMAIL_FROM` | PUBLIC · API ONLY | remitente en un dominio verificado en Resend, p. ej. `EmailBot <no-reply@emailbot.app>` (no `@resend.dev` en producción). Las respuestas del consumidor van a `soporte@emailbot.app` (*reply-to*) |
| `MICROSOFT_GRAPH_PUSH_ENABLED` | PUBLIC · API ONLY | push de Microsoft (F9): `true` activa `POST /webhooks/microsoft` (+ `/lifecycle`) y la vigilancia de suscripciones en `/health/sync`. Requiere `MICROSOFT_CLIENT_*`. Por defecto `false` (rutas en 404). Sin secreto compartido: cada suscripción tiene su propio `clientState` |

### Solo worker

| Variable | Clase | Notas |
|---|---|---|
| `WORKER_EVENTS_CONCURRENCY`, `WORKER_PROCESSING_CONCURRENCY` | PUBLIC · WORKER ONLY | 5 / 10 |
| `WORKER_IMAP_SYNC_CONCURRENCY` | PUBLIC · WORKER ONLY | 2 (sincronizaciones IMAP a la vez por proceso, dentro de `WORKER_EVENTS_CONCURRENCY`: se usan `max(1, min(valor, WORKER_EVENTS_CONCURRENCY − 1))`. Solo con `WORKER_EVENTS_CONCURRENCY` ≥ 2 queda al menos un hueco que IMAP no puede ocupar: con IMAP activado, un valor menor que 2 impide arrancar el worker (error de configuración); con IMAP desactivado, 1 sigue siendo válido. Solo se usa con IMAP activado; no limita la cola `email-processing`) |
| `WORKER_IMAP_PROCESSING_CONCURRENCY` | PUBLIC · WORKER ONLY | 2 (A2.1: trabajos IMAP de la cola `email-processing`, la recuperación de correos incompletos, a la vez por proceso, dentro de `WORKER_PROCESSING_CONCURRENCY`: se usan `max(1, min(valor, WORKER_PROCESSING_CONCURRENCY − 1))`. Solo con `WORKER_PROCESSING_CONCURRENCY` ≥ 2 queda al menos un hueco que IMAP no puede ocupar: con IMAP activado, un valor menor que 2 impide arrancar el worker (error de configuración); con IMAP desactivado, 1 sigue siendo válido. Solo se usa con IMAP activado) |
| `WORKER_POLL_INTERVAL_MINUTES` | PUBLIC · WORKER ONLY | 5 (recuperación; no poner 0: con 0 no hay *scheduler* de sondeo y `/health/sync` no puede detectar un worker parado) |
| `GMAIL_PUBSUB_TOPIC` | PUBLIC · WORKER ONLY | push de Gmail (V2): `projects/<proyecto>/topics/<topic>`; sin ella, solo polling |
| `MICROSOFT_GRAPH_NOTIFICATION_URL` | PUBLIC · WORKER ONLY | push de Microsoft (F9): URL https pública de `POST /webhooks/microsoft` de la API (`<API_PUBLIC_URL>/webhooks/microsoft`); el ciclo de vida usa `<URL>/lifecycle`. Requiere `MICROSOFT_CLIENT_*`. Sin ella, solo polling. Activarla a la vez que `MICROSOFT_GRAPH_PUSH_ENABLED=true` en la API (la API primero) |
| `WORKER_WATCH_RENEW_INTERVAL_MINUTES` | PUBLIC · WORKER ONLY | 60 por defecto; renueva watches de Gmail y suscripciones de Microsoft; no definir |
| `WORKER_MAX_ATTACHMENT_BYTES` | PUBLIC · WORKER ONLY | 25 MiB |
| `WORKER_ATTACHMENT_TRANSFER_CONCURRENCY` | PUBLIC · WORKER ONLY | 1 (F5.6, k: transferencias de adjuntos a la vez en cada proceso del worker, no entre instancias; 1 a 16; un valor inválido impide arrancar). Subirlo sube también el valor por defecto de `WORKER_ATTACHMENT_CONTENT_CONCURRENCY` y puede elevar mucho la memoria: cada transferencia tiene su propio pico de copias temporales. Ver *Adjuntos del worker* |
| `WORKER_ATTACHMENT_CONTENT_CONCURRENCY` | PUBLIC · WORKER ONLY | sin definir = k + 1 (2 con el valor por defecto de k). F5.6, m: contenidos de adjuntos decodificados que el pipeline retiene a la vez en cada proceso, esperas entre reintentos incluidas; 1 a 32 y nunca menor que `WORKER_ATTACHMENT_TRANSFER_CONCURRENCY`; un valor inválido impide arrancar. No limita la memoria residente del proceso (ver *Adjuntos del worker*) |
| `WORKER_ATTACHMENT_TIMEOUT_MS` | PUBLIC · WORKER ONLY | 120000 (F5.5: límite total de una descarga de adjunto o de su subida a Storage mientras avanza; 10000 a 600000, nunca menor que `PROVIDER_HTTP_TIMEOUT_MS`). Ver *Adjuntos del worker* |
| `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST` | PUBLIC · WORKER ONLY | no definir en Render |
| `WORKER_REDIS_COMMAND_TIMEOUT_MS` | PUBLIC · WORKER ONLY | 5000 (F5.2: límite de cada comando Redis de aplicación y de cada llamada de productor de colas; 500 a 30000). Ver *Redis de aplicación del worker* |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | PUBLIC · WORKER ONLY | 25000 (F5.1: presupuesto total del apagado, de la señal a la salida del proceso; mínimo 15000, máximo 600000). Debe quedar por debajo del plazo de apagado de Render: el Blueprint declara `maxShutdownDelaySeconds: 120`; el valor aplicado al servicio está sin verificar. Ver *Apagado del worker* |

## Lecturas de PostgREST del worker (F5.3)

`apps/worker/src/infrastructure/supabase-client.ts`. `@supabase/postgrest-js` 2.117.2 reintenta por su cuenta las
peticiones GET / HEAD hasta 3 veces (esperas de 1, 2 y 4 s) cuando el *fetch* falla, también por el plazo de
`SUPABASE_HTTP_TIMEOUT_MS` (no es un `AbortError`), o el servidor responde 503 / 520. Una lectura colgada duraba
así 4 × el plazo + 7 s (unos 247 s con 60 s) y la misma sentencia lenta llegaba a ejecutarse varias veces a la vez
en PostgreSQL (la que vence en el cliente sigue en el servidor).

El cliente del worker se crea con `db: { retry: false }`:

- una lectura se envía una vez y falla como mucho en `SUPABASE_HTTP_TIMEOUT_MS`; el error llega al trabajo
  (los *stores* lanzan en todo error, ninguno lo convierte en "no encontrado") y BullMQ lo reintenta con sus
  intentos y esperas, la única capa de reintento;
- un 503 pasajero (PostgREST recargando su esquema tras una migración) hace fallar ese intento del trabajo en vez
  de esperarse dentro de él;
- las escrituras y las RPC (POST / PATCH / DELETE) no cambian: el cliente nunca las reintentaba;
- no afecta a Storage ni a Auth, ni a la API (crea sus propios clientes).

Comprobado contra un PostgREST real desechable: una sentencia de 3 s con plazo de 1 s falla en ~1 s con una sola
sentencia en PostgreSQL; con la configuración anterior tardaba ~11 s y llegaba a 2 sentencias simultáneas. Sin
cambiar: el plazo de 60 s de las lecturas (un plazo propio más corto depende de verificar el `statement_timeout`
de producción; en local `authenticator` tiene 8 s y `service_role` ninguno).

## Peticiones HTTP a proveedores del worker (F5.4)

| Petición | Proveedor | Límite | Cancelación por el apagado |
|---|---|---|---|
| Listado, mensajes, `users.watch` | Gmail API | `PROVIDER_HTTP_TIMEOUT_MS` (20 s; 1000 a 120000) | sí |
| *Delta*, mensajes, suscripciones (crear, renovar, borrar) | Microsoft Graph | igual | sí |
| Refresco de tokens | Google / Microsoft OAuth | igual | sí |
| Descarga de adjuntos (F5.5) | Gmail API / Microsoft Graph | 20 s sin recibir datos; `WORKER_ATTACHMENT_TIMEOUT_MS` en total (120 s) | sí |
| Subida de adjuntos (F5.5) | Supabase Storage | `WORKER_ATTACHMENT_TIMEOUT_MS` (120 s) | sí |
| PostgREST, comprobación de objetos en Storage | Supabase | `SUPABASE_HTTP_TIMEOUT_MS` (60 s) | no (F5.3) |
| Envío de eventos | Sentry (SDK) | su propio *flush* de 2 s en el apagado | no |

El límite (`fetchWithTimeout`, compartido con la API, sin cambios) cubre la petición entera, cuerpo incluido, y se
aplica con un `AbortSignal` que llega a undici: el socket se cierra. F5.4 añade en el worker una señal de
cancelación (`apps/worker/src/infrastructure/http-cancellation.ts`) que la fase de cancelación del apagado activa:
corta las peticiones en curso y rechaza las nuevas al momento. Los fallos se distinguen: plazo vencido
(`HttpTimeoutError` → `ProviderTransientError` "Timed out"), cancelación por el apagado (`ProviderCancelledError`,
también transitorio, registrado como `worker.shutdown.request_cancelled` y no como error) y errores de red o HTTP
(sin cambios). En todos los casos el trabajo falla y BullMQ lo reintenta; nunca es un error de la cuenta.

Cancelar solo detiene la petición local: el proveedor puede haberla recibido y seguir procesándola (un token
emitido que no llega a guardarse, una suscripción de Graph o un *watch* de Gmail creados sin registrar). Son los
mismos casos que un plazo vencido, ya existentes: el reintento vuelve a pedir el token o a crear la suscripción, un
*watch* nuevo de Gmail sustituye al anterior y una suscripción de Graph sin registrar no está asociada a ninguna
cuenta y caduca sola. Los adjuntos tienen sus propios límites (ver *Adjuntos del worker*).

## Adjuntos del worker (F5.5)

Ciclo (`apps/worker/src/pipeline/process-email.ts`): filas de metadatos (`ON CONFLICT DO NOTHING` y relectura) →
por cada adjunto no guardado y no mayor que `WORKER_MAX_ATTACHMENT_BYTES`: ¿existe ya el objeto en Storage? → si
no, descarga del proveedor y subida a una ruta determinista con *upsert* → la fila se marca guardada. Un contenido
que falla queda pendiente: el correo sigue `PROCESSING` / `ATTACHMENTS_PENDING`, el trabajo falla y se reanuda
más tarde sin repetir lo ya hecho.

Antes, la descarga tenía un único límite de 20 s para toda la respuesta: un adjunto de 25 MiB son unos 33 MiB de
JSON en base64, así que con menos de ~1,7 MiB/s fallaba en todos los intentos; la subida tenía 60 s (25 MiB
necesitaban ~0,42 MiB/s) y se repetía 3 veces dentro del trabajo aunque el fallo fuera un plazo vencido. Ahora
(`apps/worker/src/infrastructure/attachment-transfer.ts`):

- descarga leída por partes: falla si pasan `PROVIDER_HTTP_TIMEOUT_MS` sin recibir datos (un servidor colgado
  falla igual de rápido que antes) o al cumplirse `WORKER_ATTACHMENT_TIMEOUT_MS`; con 120 s un adjunto de 25 MiB
  necesita ~0,28 MiB/s de media;
- tamaño: la lectura se corta en cuanto el cuerpo supera el tamaño codificado de `WORKER_MAX_ATTACHMENT_BYTES`
  (más 64 KiB), aunque el proveedor declare un tamaño menor; ese contenido no se guarda, como uno demasiado grande.
  Lo descargado nunca supera ese límite (las copias al leer y decodificar lo multiplican por unas pocas veces, como
  antes, pero ya no dependen del tamaño real de la respuesta);
- subida con un cliente de Storage propio (`createWorkerUploadClient`): límite `WORKER_ATTACHMENT_TIMEOUT_MS` y
  sin repetirla dentro del trabajo tras un plazo vencido; otros errores se reintentan como antes. Si Storage guardó
  el objeto pero la respuesta no llegó, el siguiente intento lo encuentra y no lo descarga ni lo sube otra vez;
- el apagado (fase de cancelación, F5.4) cancela descargas y subidas en curso y no deja empezar otras: el trabajo
  se detiene al momento como cancelado y se reintenta. Una descarga cancelada cierra su conexión al instante. Una
  subida no: undici (Node 24) sigue enviando todo lo que ya había entregado al socket (con un adjunto en memoria,
  normalmente el cuerpo entero), y al salir el proceso el sistema operativo entrega lo que tenga en sus búferes y
  cierra la conexión. **Una subida cancelada puede completarse en Storage** (comprobado en local: 3 subidas de 4 MiB
  canceladas y completadas después de la salida). Es seguro: la ruta es determinista y con *upsert*, la fila no se
  marca en ese intento, y el siguiente encuentra el objeto y lo marca sin volver a descargarlo ni subirlo. Mientras
  tanto esas transferencias ocupan conexiones y ancho de banda: como mucho una por tarea de adjuntos en curso (25
  con la concurrencia por defecto: 10 trabajos de procesamiento más 5 de eventos con hasta 3 mensajes cada uno),
  hasta la salida del proceso más lo que tarde el sistema en vaciar sus búferes;

Sin cambios: `WORKER_MAX_ATTACHMENT_BYTES`, `PROVIDER_HTTP_TIMEOUT_MS` y `SUPABASE_HTTP_TIMEOUT_MS` para el resto de
peticiones, PostgREST (F5.3) y la API. Un trabajo con varios adjuntos lentos puede durar varias veces
`WORKER_ATTACHMENT_TIMEOUT_MS`; el apagado lo corta en su fase de cancelación.

Memoria (medida en local en un proceso hijo con la cadena real; pico de memoria residente del proceso, con mucha
variación entre ejecuciones): un adjunto de 25 MiB lo eleva entre ~280 y ~470 MiB (cadena anterior a F5.5: ~450-500
MiB) y tres a la vez entre ~500 y ~615 MiB (anterior: ~500-515 MiB), por las copias del cuerpo JSON, sus cadenas, la
decodificación base64 y la subida. No es nuevo de F5.5 (F5.5 añade una copia transitoria del cuerpo al unir sus
partes), pero con 15 trabajos a la vez y adjuntos grandes el pico puede superar la memoria de la instancia: pendiente
de decidir (menos copias o un límite de transferencias de adjuntos simultáneas por proceso).

Límite de transferencias (F5.6, fase 1; `apps/worker/src/infrastructure/attachment-transfers.ts`): cada proceso
del worker hace como mucho `WORKER_ATTACHMENT_TRANSFER_CONCURRENCY` transferencias a la vez (1 por defecto; cada
instancia tiene el suyo). Una transferencia es la descarga de un adjunto (con su decodificación) y su subida; la
comprobación de existencia, la actualización de la fila y las esperas entre reintentos de subida van sin permiso.
Los demás trabajan en orden de llegada (FIFO); un trabajo sin adjuntos que guardar no espera nunca. Los límites de
F5.5 (tamaño, inactividad, total) solo cuentan desde que la transferencia empieza. La fase de cancelación del apagado
rechaza al momento a quienes esperan (cancelados, se reintentan) y no concede más permisos; quien ya transfiere
mantiene la cancelación de F5.4 / F5.5. Con 1, solo un adjunto a la vez pasa por la parte costosa (descarga,
decodificación y subida). Los trabajos con adjuntos tardan más cuando coinciden.

Contenidos retenidos (`WORKER_ATTACHMENT_CONTENT_CONCURRENCY`, m; transferencias: k): un adjunto toma un permiso de
contenido antes de descargarse y lo conserva hasta guardarse o darse por pendiente, esperas entre reintentos incluidas
(el permiso de transferencia se devuelve en esas esperas). Orden fijo (contenido y después transferencia; nunca se
espera contenido con un permiso de transferencia): sin interbloqueos. La fase de cancelación del apagado rechaza
también a quienes esperan contenido. Sin definir, m = k + 1 (2 con k = 1): el valor mínimo con el que una
transferencia sigue avanzando mientras otro contenido espera su reintento (con m = k un permiso de transferencia
devuelto no serviría a nadie). Subir k sube también ese valor por defecto de m y puede elevar mucho la memoria: cada
una de las k transferencias simultáneas tiene su propio pico de copias temporales.

Qué limita m: el número de contenidos decodificados que **gestiona el pipeline** a la vez en cada proceso (cada uno de
hasta `WORKER_MAX_ATTACHMENT_BYTES`), de los que como mucho k están en plena transferencia. Sin este límite podían
ser hasta 25 tareas de adjuntos a la vez (unos 625 MiB solo de contenidos con adjuntos de 25 MiB).

Qué no limita m: **la memoria residente real del proceso**, que además incluye:

- la base del proceso (código, dependencias, clientes, colas);
- las copias temporales de cada transferencia en curso: el cuerpo JSON, sus cadenas, la decodificación base64 y las
  copias internas de undici al subir;
- los mensajes completos que procesa cada trabajo y el resto de su memoria, que no pasan por estos permisos;
- los cuerpos de subidas abortadas (vencidas o canceladas por el apagado): undici rechaza la petición al momento pero
  conserva lo que ya había entregado al socket hasta terminar de enviarlo o cerrar la conexión, después de que se
  hayan liberado los dos permisos. Ante un Storage lento, varios de esos cuerpos pueden convivir fuera de cualquier
  límite (comprobado para la cancelación; para el plazo vencido es el mismo mecanismo de `AbortSignal`, no probado
  por separado).

Estimación orientativa por proceso con los valores por defecto (mediciones locales en Windows con Node 24, no de
Render ni de producción): la base del proceso, un pico de transferencia (+281 a +470 MiB de memoria residente con un
adjunto de 25 MiB) y otro contenido retenido (25 MiB), más lo que haya de la lista anterior. Memoria real de la
instancia en Render: sin verificar.

Riesgos aparte, fuera de los permisos de adjuntos:

- Gmail: una parte con su contenido en línea (`body.data` sin `attachmentId`) no se guarda como adjunto, pero ese
  contenido viaja dentro del JSON del mensaje que descarga `fetchMessage` y ocupa memoria mientras se procesa.
- IMAP (desactivado): la copia del mensaje que se conserva durante el trabajo (`providers/imap/message-scope.ts`, hasta
  10 MiB) no pasa por estos permisos; revisarlo antes de activar IMAP.

## Apagado del worker

F5.1 (`apps/worker/src/infrastructure/shutdown.ts`). Con `SIGTERM` o `SIGINT` el worker se apaga por fases dentro
de un presupuesto total, `WORKER_SHUTDOWN_TIMEOUT_MS` (25 s por defecto). Cada fase está limitada por su propio
límite y además por lo que el presupuesto deja a las fases siguientes, así que la secuencia termina sola al menos
100 ms antes del total aunque todos los pasos se cuelguen. Al cumplirse el total hay además una salida de
emergencia (código 1) como último recurso, p. ej. si el *event loop* queda bloqueado. Render envía `SIGKILL` al
cumplirse `maxShutdownDelaySeconds` (120 s en el Blueprint, valor aplicado al servicio sin verificar): el
presupuesto debe quedar por debajo.

| Fase | Límite (por defecto) | Qué hace |
|---|---|---|
| 1. Parar | 3 s (workers en paralelo) | `/readyz` pasa a *stopping*; se cancelan las operaciones IMAP en curso (sockets cerrados, no se abren nuevas) y `pause(true)` en cada worker BullMQ: no se toma ningún trabajo nuevo |
| 2. Gracia | hasta total − 13,1 s (11,9 s) | espera a que terminen los trabajos en curso |
| 3. Cancelación | 3 s | solo si queda alguno: se desconecta el cliente Redis del publicador *realtime* y se cancelan las peticiones HTTP a proveedores y las subidas de adjuntos en curso (F5.4, F5.5); un trabajo esperando en ellas falla y BullMQ lo reintenta |
| 4. Cierre | 3 s (workers en paralelo) | `close()`; forzado solo si aún queda un trabajo en curso |
| 5. Liberación | 5 s cada uno, en paralelo | pool IMAP, colas, servidor de health; después se desconectan las conexiones Redis |
| 6. Sentry | 2 s | `flush` |
| Salida | antes del total | 0 si todo terminó solo; 1 si hubo que interrumpir o forzar algo, o un paso (también el `flush`) agotó su límite |

- Una segunda señal salta el resto de la gracia y acorta la cancelación a 1 s (también si llega durante ella); una
  tercera sale al instante con código 1. Señales simultáneas no inician dos secuencias.
- Ningún trabajo se marca como completado sin haber terminado y no se borra ninguno de Redis. Un trabajo que
  sigue en curso al cerrar forzado queda *active*; cuando su bloqueo expira (`lockDuration`, 30 s) el control de
  trabajos atascados de otra instancia o del worker reiniciado lo devuelve a la cola y se vuelve a ejecutar
  (observado en local: unos 60 s tras el reinicio). El procesamiento es idempotente: el reintento no duplica
  correos, adjuntos ni notificaciones (probado).
- Esperar con límite solo deja de esperar, y ni el código 1 ni la salida de emergencia significan que algo se
  cancelara: una escritura HTTP o SQL ya enviada (Supabase, proveedores) puede haberse confirmado igualmente en
  el servidor.
- ioredis: `disconnect()` cierra el socket y, si el servidor no responde, lo destruye tras `disconnectTimeout`
  (2 s por defecto); solo entonces se rechazan los comandos pendientes. Por eso la fase de cancelación dura 3 s.
- Límites que dependen de fases posteriores:
  - F5.2: los comandos Redis de aplicación (lock, `PING`, `PUBLISH`) y las llamadas de productor fallan dentro de
    `WORKER_REDIS_COMMAND_TIMEOUT_MS` (5 s, por debajo de la gracia), así que un trabajo que espera en ellos
    termina solo (ver *Redis de aplicación del worker*). La conexión de BullMQ (`maxRetriesPerRequest: null`, cola
    *offline*) puede seguir dejando comandos esperando sin límite; no se interrumpe antes de la fase 5 porque la
    usan todos los workers y las colas. Si deja de responder, el cierre agota sus límites y el proceso sale con
    código 1 dentro del presupuesto (probado en un subproceso con Redis pausado).
  - F5.3: el cliente del worker ya no reintenta las lecturas de PostgREST (ver *Lecturas de PostgREST del
    worker*), pero una lectura colgada sigue esperando hasta `SUPABASE_HTTP_TIMEOUT_MS` (60 s, más que la gracia):
    un trabajo en ese punto no se cancela, agota la gracia y se cierra forzado.
  - F5.4: las peticiones HTTP a proveedores (Gmail, Microsoft Graph, OAuth) se cancelan en la fase 3 (ver
    *Peticiones HTTP a proveedores del worker*); las de Supabase no: siguen limitadas por `SUPABASE_HTTP_TIMEOUT_MS`.

## Web: cabeceras

El sitio estático no ejecuta nginx: las cabeceras de `deploy/web/security-headers.conf.template` se declaran en
el Blueprint (`headers`). La CSP completa va en el `<meta>` de `index.html`; la cabecera solo añade
`frame-ancestors 'none'` (las dos políticas se aplican a la vez). `csp-policy.txt` se publica junto al sitio
(contenido público). Pendiente de verificar en Render: la cabecera `Cache-Control` por defecto de `index.html`
(nginx usaba `no-cache`; Render invalida su CDN en cada deploy).

## Variables que pone Render

| Variable | Uso |
|---|---|
| `RENDER_GIT_COMMIT` | commit desplegado; API y worker lo envían como `release` a Sentry (si no existe o no parece un hash, se omite). No definirla a mano |

## Monitorización y alertas (F8-B)

Render no consulta `/health/ready` ni `/health/sync` (ver *Health checks*): la caída de Redis, un worker parado o
la sincronización atrasada se detectan con un monitor externo sobre los endpoints públicos (decisión F8-B:
Better Stack, plan gratuito, alertas por email). Configuración manual y monitores propuestos en
[`docs/operations.md`](operations.md#monitorización-externa). En Render conviene activar las notificaciones por
email del *workspace* para despliegues fallidos y caídas de servicio (Dashboard → Settings → Notifications).

## Pendiente de verificar en producción

Sin comprobar todavía en los servicios reales (no hay acceso a Render desde el repositorio):

- Observado el 2026-10-15 (consulta de solo lectura; repetir antes de activar IMAP): Valkey 8.1.10, `maxmemory`
  256 MiB, `noeviction`, AOF activo y `ok`, último RDB `ok`, `cluster_enabled:0`, `INFO` permitido. Sigue sin
  comprobarse: durabilidad tras un reinicio, réplicas / *failover* gestionado (los scripts de bloqueo usan dos claves
  y fallarían con `CROSSSLOT` si algún día hubiera Redis Cluster) y el campo `redis_mode` (no apareció).
- Permisos de `CLIENT SETNAME` y de los comandos de los scripts Lua (`EVAL`) comprobados directamente en Render.
- Número real de saltos para `TRUST_PROXY`.
- Versión de pnpm que usa Render en el build del Static Site (`packageManager: pnpm@12.8.1`).
- `Cache-Control` real de `index.html` en el Static Site.
- Plazo real entre `SIGTERM` y `SIGKILL` del Background Worker (el Blueprint declara `maxShutdownDelaySeconds:
  120`): `WORKER_SHUTDOWN_TIMEOUT_MS` debe quedar por debajo.
