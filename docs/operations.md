# Operación e incidentes

Guía de operación de producción (F8-B). Servicios: `emailbot-api` (`https://api.emailbot.app`), `emailbot-web`
(`https://emailbot.app`), `emailbot-worker` y Redis (Key Value) en Render; base de datos, Auth y Storage en
Supabase (proyecto de producción, plan Pro). Despliegues manuales desde `main`. Detalle de Render:
[`render.md`](render.md); variables y despliegue: [`deployment.md`](deployment.md); API: [`api.md`](api.md).

## 1. Endpoints de salud

| Endpoint | Público | Qué comprueba | Respuesta |
|---|---|---|---|
| API `GET /health` | sí | el proceso responde (liveness). Es el health check de Render | 200 `{status:"ok", service, timestamp}` |
| API `GET /health/ready` | sí | Redis responde a PING | 200 `ready` / 503 `not_ready` con `checks.redis` |
| API `GET /health/sync` | sí | sincronización de correo: Redis, *scheduler* del worker, buzones y correos (sección 2) | `{status, sync}`; 200 o 503 |
| Worker `GET /livez`, `/readyz` | no (sin puerto en Render) | proceso vivo / inicializado + Redis | solo si se define `WORKER_HEALTH_PORT` (no en Render) |
| Web `https://emailbot.app` | sí | el sitio estático se sirve | 200 con el HTML de la app |

Ninguno devuelve datos personales, ids, cifras ni mensajes de error internos. Todos responden con
`cache-control: no-store`. `/health/sync` se cachea 30 s dentro de la API.

En el Static Site cualquier ruta (también `/healthz`) devuelve el `index.html` con 200, así que el monitor de la
web debe comprobar el contenido (palabra clave), no solo el código HTTP.

## 2. Estados de `/health/sync`

Se evalúan en este orden; el primero que se cumple es la respuesta.

| HTTP | `status` / `sync` | Significado | Sección |
|---|---|---|---|
| 503 | `down` / `unavailable` | Redis o la base de datos no responden: nada puede sincronizar | [7](#7-redis-unavailable) |
| 503 | `down` / `stalled` | el *scheduler* `poll-active-accounts` lleva más de dos intervalos sin ejecutarse: el worker está parado, colgado o no da abasto | [5](#5-worker-stalled) |
| 200 | `ok` / `idle` | no hay buzones sincronizables (Gmail/Microsoft de organizaciones `ACTIVE`, en `ACTIVE` o `ERROR`) | — |
| 503 | `down` / `error` | **todos** los buzones sincronizables están en `ERROR` (autorización perdida) | [6](#6-cuenta-gmail-o-microsoft-en-error) |
| 503 | `down` / `stale` | más de la mitad de los buzones `ACTIVE` sin sincronizar en `SYNC_HEALTH_STALE_MINUTES` (20 min) | [4](#4-sync-stale) |
| 200 | `degraded` / `degraded` | algún buzón en `ERROR`, atrasado o con error reciente; un *watch* de Gmail a < 12 h de caducar; una cuenta Microsoft sin suscripción de Graph o con ella a < 12 h de caducar (push activado); correos en `RECEIVED`/`PROCESSING` hace más de 30 min; o correos `FAILED` en las últimas 24 h | 4, 6, [6b](#6b-microsoft-graph-notificaciones-de-cambio-f9), [10](#10-bullmq) |
| 200 | `ok` / `healthy` | todo en orden | — |

`degraded` nunca es 503: un único buzón roto (entre dos o más) o unos pocos correos fallidos no tumban el
endpoint. Para saber cuál de las causas de `degraded` es, ver el log de la API: cada evaluación no sana
escribe un `warn` "mail synchronization is not healthy" con los conteos (`counts`), sin datos personales.

## Monitorización externa

Decisión F8-B: Better Stack (plan gratuito), alertas solo por email. Se configura a mano en Better Stack (no
desde el repositorio). Monitores propuestos:

| Monitor | URL | Condición de alerta | Severidad |
|---|---|---|---|
| M1 API viva | `https://api.emailbot.app/health` | HTTP ≠ 200 o falta la palabra `"status":"ok"` | crítica |
| M2 API lista | `https://api.emailbot.app/health/ready` | HTTP ≠ 200 | crítica |
| M3 Sincronización | `https://api.emailbot.app/health/sync` | HTTP ≠ 200 (`stalled`, `error`, `stale`, `unavailable`) | crítica |
| M4 Sincronización degradada | `https://api.emailbot.app/health/sync` | falta la palabra `"status":"ok"` durante ≥ 30 min | aviso |
| M5 Web | `https://emailbot.app` | HTTP ≠ 200 o falta la palabra `EmailBot` | crítica |

Crear los monitores después del despliegue de la API con F8-B (antes, `/health/sync` no conoce `stalled` ni los
correos atascados). Verificar cada uno con la notificación de prueba del propio servicio.

## 3. API caída

Síntomas: M1 o M5 en rojo; la web muestra errores de red.

1. `curl -sS -o /dev/null -w "%{http_code}\n" https://api.emailbot.app/health`.
2. Render → `emailbot-api` → *Events*: ¿despliegue fallido, reinicios, health check fallando?
3. Render → `emailbot-api` → *Logs*: errores de arranque. La API termina al arrancar si la configuración es
   inválida (mensaje de validación de variables) — corregir la variable en Render y redesplegar.
4. Si empezó tras un despliegue: *Rollback* al despliegue anterior (sección 13).
5. Si `/health` responde pero M2 falla: ver sección 7 (Redis).

## 4. Sync stale

`down/stale` (503) o `degraded` por buzones atrasados.

1. ¿Hay `stalled` antes? Si el worker no consume, todos los buzones se atrasan: ir a la sección 5.
2. Render → `emailbot-worker` → *Logs*: buscar `"job failed"`, `"account synchronized"` (sincronizaciones
   correctas) y errores de Gmail / Supabase.
3. Errores de proveedor (`GMAIL_HTTP_5xx`, *timeouts*): suelen ser transitorios; el sondeo reintenta cada
   `WORKER_POLL_INTERVAL_MINUTES` (5).
4. Panel de Super Admin → organización → cuentas de correo: estado, última sincronización y último error de
   cada buzón.
5. Un buzón concreto se puede sincronizar a mano desde la web (*Sincronizar* en Cuentas de correo), lo que
   encola un `SYNC_ACCOUNT` para el worker.

## 5. Worker stalled

`down/stalled` (503): el *scheduler* de sondeo lleva más de 10 min (2 × 5) sin ejecutarse.

1. Render → `emailbot-worker`: ¿el servicio está *Live*? ¿reinicios en bucle en *Events*?
2. *Logs* del worker: al arrancar escribe `"EmailBot worker started"` con colas y concurrencia; si la
   inicialización falla escribe `"worker initialization failed"` y termina (Render lo reinicia).
3. Redis: si el worker no puede hablar con Redis, `/health/sync` sería `unavailable` en lugar de `stalled`
   (la API sí lo alcanza). `stalled` con Redis sano apunta a un worker caído, colgado o saturado.
4. Reiniciar el worker desde el Dashboard de Render (reinicio del servicio, o *Manual Deploy* del último
   commit). Los trabajos pendientes y los *schedulers* viven en Redis y se conservan.
5. Tras unos minutos, `/health/sync` debe volver a `ok` (la caché dura 30 s).

`WORKER_POLL_INTERVAL_MINUTES=0` elimina el *scheduler*: no se detecta `stalled` (no poner 0).

## 6. Cuenta Gmail (o Microsoft) en ERROR

El buzón perdió la autorización (token revocado o caducado, contraseña de Google cambiada…): el worker lo marca
`ERROR` y deja de sincronizarlo. `degraded` si hay otros buzones sanos; `down/error` (503) si todos están en
`ERROR`.

1. La organización ve el buzón en Cuentas de correo con el estado de error.
2. Un OWNER/ADMIN de la organización pulsa **Reconectar** (OAuth de Google de nuevo). Al reconectar, el buzón
   vuelve a `ACTIVE` y el sondeo lo retoma.
3. Si no es posible reconectar, **Desconectar** el buzón: deja de contar para `/health/sync`.
4. Log del worker: `"account credentials invalid"` con el código del error (sin direcciones).

## 7. Redis unavailable

`down/unavailable` (503) en `/health/sync`, `not_ready` en `/health/ready` (M2 y M3 en rojo).

1. Render → Key Value: estado de la instancia, memoria y eventos.
2. Comportamiento sin Redis (comprobado, ver `render.md`): la API sigue respondiendo `/health`; encolar
   falla al instante (los webhooks responden 503 y Google reintenta); el worker queda `not_ready`, vivo, y se
   reconecta solo al volver Redis. Los trabajos y *schedulers* se conservan si la instancia tiene persistencia.
3. Si la memoria está llena (`noeviction`), las escrituras fallan aunque PING responda: revisar el uso de
   memoria en Render y el tamaño de las colas (sección 10).

## 8. Qué revisar en Render

- *Events* de cada servicio: despliegues (éxito/fallo), reinicios, health check de la API.
- *Logs*: API (`"request failed"`, `"unhandled error"` con `requestId`), worker (`"job failed"`,
  `"email processing abandoned"`, `"redis error"`), sin cabeceras ni tokens (redactados).
- *Metrics*: CPU y memoria de API y worker; memoria de Key Value.
- Notificaciones del *workspace* por email (despliegue fallido, caída de servicio): activarlas una vez.
- `RENDER_GIT_COMMIT`: commit desplegado (también es el `release` en Sentry).

## 9. Qué revisar en Supabase

- Dashboard → *Project status* / *Reports*: estado de Database, Auth, Storage, REST.
- *Logs* (Postgres, PostgREST, Auth): errores de las consultas del API / worker.
- *Database → Backups*: copias diarias (plan Pro, retención de 7 días); PITR no está activado.
- Correos atascados o fallidos (sección 10): consulta de solo lectura en el *SQL Editor*, por ejemplo
  `select processing_status, count(*) from public.emails where updated_at > now() - interval '24 hours' group by 1;`.

## 6b. Microsoft Graph: notificaciones de cambio (F9)

Equivalente del push de Gmail para buzones de Microsoft 365 / Outlook. **Desactivado** mientras no se configure
(`MICROSOFT_GRAPH_PUSH_ENABLED` en la API y `MICROSOFT_GRAPH_NOTIFICATION_URL` en el worker); sin ellas los buzones
Microsoft se sincronizan solo por sondeo cada 5 minutos.

```
Microsoft 365 → Graph change notification → POST /webhooks/microsoft → MICROSOFT_NOTIFICATION
  → enqueueSync (GRAPH, coalescido) → syncAccount (lock) → delta de la Inbox → processEmail
Red de seguridad: POLL_ACCOUNTS cada 5 min (siempre activo)
```

- **Suscripción**: una por cuenta Microsoft `ACTIVE` con credenciales, recurso `me/mailFolders('inbox')/messages`,
  `changeType: created`, creada por el worker (`WATCH_ACCOUNT`) con el token delegado de la cuenta (OAuth
  *authorization code* + refresh token; sin *client credentials*). Se pide al conectar la cuenta y en cada pasada
  de `RENEW_WATCHES`. Al crearla, Graph llama a la URL con `validationToken`: la API debe estar desplegada y
  accesible por https antes.
- **Duración y renovación**: se pide 70 h (Graph devuelve la caducidad real, guardada en `watch_expires_at`).
  `RENEW_WATCHES` (cada hora) renueva con `PATCH` las que caducan en menos de 24 h; el `clientState` no cambia.
  Si Graph responde 404 (ya no existe), se olvida y se crea otra con un `clientState` nuevo.
- **Estado guardado** (sin migración): `provider_metadata.subscriptionId` y `subscriptionClientStateHash`
  (SHA-256 del `clientState`), `watch_expires_at`, `watch_renewed_at`, `watch_error_code` / `watch_error_at`.
  Visible en el panel de Super Admin (cuentas de correo de la organización: caducidad y último error).
- **Ciclo de vida** (`/webhooks/microsoft/lifecycle`):
  - `reauthorizationRequired` → la suscripción se marca como vencida y el job `WATCH_ACCOUNT` la renueva (renovar
    la reautoriza);
  - `subscriptionRemoved` → se olvida, se crea una nueva y se sincroniza la cuenta (por lo que llegara entretanto);
  - `missed` → solo se sincroniza la cuenta: el delta recupera los cambios (nunca se reconstruyen mensajes desde la
    notificación).
- **Desconexión**: la API borra la suscripción en Graph (`DELETE`, con el token de la cuenta) **antes** de borrar los
  tokens, y la olvida localmente. Un 404 o un fallo no impiden desconectar: la suscripción caduca sola (≤ 70 h) y
  sus notificaciones se rechazan (suscripción desconocida).
- **Logs** (`emailbot-worker`): `microsoft.subscription.created`, `renewed`, `missing`, `failed`,
  `microsoft.lifecycle.*`; (`emailbot-api`): `microsoft.graph.received`, `microsoft.graph.rejected`,
  `microsoft.lifecycle.received`, `microsoft.subscription.removed`. Con id de cuenta y hash corto de la suscripción;
  nunca el `clientState` ni tokens.
- **`/health/sync`**: con `MICROSOFT_GRAPH_PUSH_ENABLED`, una cuenta Microsoft `ACTIVE` sin suscripción o con la
  suscripción a < 12 h de caducar da `degraded` (200). El sondeo sigue sincronizando mientras tanto.

**Suscripción perdida o fallando** (`degraded`, `watch_error_code` en el panel de Super Admin):

1. Logs del worker: `microsoft.subscription.failed` con `errorCode` (`HTTP_400`: Graph no pudo validar la URL —
   comprobar que `MICROSOFT_GRAPH_NOTIFICATION_URL` apunta a la API desplegada y responde al handshake—;
   `HTTP_403`: permisos / consentimiento).
2. Comprobar el handshake: `curl -s -X POST "https://api.emailbot.app/webhooks/microsoft?validationToken=prueba"`
   debe devolver `prueba` (con el push activado en la API).
3. Se reintenta solo en la siguiente pasada de `RENEW_WATCHES` (cada hora); reconectar la cuenta también encola
   `WATCH_ACCOUNT`. El correo sigue entrando por sondeo mientras tanto.
4. Credenciales revocadas: la cuenta pasa a `ERROR` (sección 6) y la suscripción deja de renovarse.

**Ids de mensaje**: se usan los ids normales de Graph (cambian si el mensaje se mueve de carpeta). Pasar a
`Prefer: IdType="ImmutableId"` cambiaría el `provider_message_id` de lo ya guardado y rompería la deduplicación con
esos correos: decisión pendiente, no aplicada.

## 10. BullMQ

Colas: `email-events` (sincronizaciones, *watches*, sondeo, recuperación), `email-processing` (correos
reanudados) y `notifications`. Trabajos: 5 intentos con espera exponencial; completados se conservan 24 h,
fallidos 7 días; los de sincronización (`sync-<id>`) se borran al terminar.

Recuperación automática: `RECOVER_INCOMPLETE` (cada 10 min) reanuda correos en `RECEIVED`/`PROCESSING`;
tras agotar los intentos el correo pasa a `FAILED` (log `"email processing abandoned"`). Por eso `/health/sync`
marca `degraded` con correos pendientes de más de 30 min o `FAILED` en 24 h.

No hay panel de colas. Conteo de solo lectura desde el *Shell* del worker en Render (red privada, sin imprimir
la URL de Redis). `bullmq` e `ioredis` solo están en `apps/worker/node_modules`, de ahí el `cd`; comando no
probado todavía en el *Shell* de Render:

```bash
cd apps/worker && node -e "const {Queue}=require('bullmq');const R=require('ioredis');const c=new R(process.env.REDIS_URL,{maxRetriesPerRequest:null});Promise.all(['email-events','email-processing','notifications'].map(n=>new Queue(n,{connection:c}).getJobCounts('wait','active','delayed','failed').then(r=>[n,r]))).then(a=>{console.log(JSON.stringify(a));c.disconnect()})"
```

## 11. Sentry

Activo solo si `SENTRY_DSN` está definido en la API y/o el worker (un proyecto por servicio). Cada evento lleva
`environment` (`NODE_ENV`) y `release` (`RENDER_GIT_COMMIT`). Sin cabeceras, cookies, cuerpos, *query strings*,
datos de usuario ni *breadcrumbs* de red; direcciones de correo, tokens y rutas de URL enmascarados.

- API: errores 5xx (`requestId` y `code` como *tags*: buscar el `requestId` en los logs de Render para el
  contexto completo).
- Worker: un evento por trabajo que falla en su **último** intento (los reintentos que acaban bien no se
  notifican), con *tags* `queue` y `jobType`; y el fallo de inicialización del worker.
- No se notifican: errores 4xx, `SyncBusyError` (sincronización ya en curso) ni credenciales inválidas (se
  ven como cuenta en `ERROR`).

## 12. Procedimiento básico de incidente

1. **Detectar**: alerta del monitor (email) o aviso de un usuario.
2. **Confirmar**: `curl` de `/health`, `/health/ready`, `/health/sync`; anotar la hora (UTC).
3. **Acotar**: ¿qué cambió? (último despliegue en Render *Events*, `RENDER_GIT_COMMIT`); ¿qué servicio?
   (secciones 3–7).
4. **Mitigar**: *rollback* del último despliegue, reinicio del worker o reconexión del buzón según el caso.
   No borrar datos ni colas para "arreglar" un incidente.
5. **Verificar**: los tres endpoints en verde y, para sincronización, un buzón con `last_synced_at` reciente.
6. **Registrar**: qué pasó, impacto (desde/hasta), causa, acción y seguimiento.

## 13. Recuperación y rollback

- **Código**: Render → servicio → *Events* → despliegue anterior → *Rollback* (API, worker y web por
  separado). Volver al commit anterior en `main` requiere un PR (protección de `main`).
- **Orden**: si un cambio afecta a varios servicios, revertir la web antes que la API cuando la web nueva
  dependa de endpoints nuevos, y la API antes que la web en el caso contrario.
- **Migraciones**: no se revierten automáticamente. Un *rollback* de código con una migración ya aplicada
  necesita evaluar la compatibilidad (las migraciones de V2 se diseñaron aditivas).
- **Colas**: tras reiniciar el worker, los trabajos pendientes continúan; los correos a medias los retoma
  `RECOVER_INCOMPLETE`.

## 14. Restauración de backup (referencia)

Solo como último recurso y con autorización explícita: restaurar **sobrescribe** la base de datos del
proyecto (los cambios posteriores a la copia se pierden) y deja el proyecto sin servicio mientras dura.

- Supabase → *Database* → *Backups*: elegir una copia diaria (últimos 7 días, plan Pro) → *Restore*.
- PITR (restauración a un instante concreto) no está contratado.
- Después: verificar `/health/sync`, que los buzones sincronicen (los cursores de sincronización vuelven al
  estado de la copia y el worker continúa desde ahí) y que los usuarios puedan iniciar sesión.
