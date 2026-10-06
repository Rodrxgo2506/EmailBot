# API REST

Base: `API_PUBLIC_URL` (por defecto `http://localhost:3000`). Todas las rutas `/api/*` requieren
`Authorization: Bearer <access token de Supabase>`. Las rutas de una organización usan la cabecera
`X-Organization-Id` (si el usuario pertenece a una sola, se usa esa).

Errores: `{ "error": { "code", "message", "requestId", "details?" } }`. Cada respuesta incluye `x-request-id`.

Rate limiting por IP: `429` con `code: "RATE_LIMITED"` (global `RATE_LIMIT_MAX`/min; límites más estrictos en
prueba de reglas, alta de miembros, creación de organizaciones, OAuth, IMAP, sincronización y webhooks).

## Salud

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/ready` | Dependencias (Redis) |
| GET | `/health/sync` | Sincronización de correo, para un monitor externo (ver abajo) |

`/health/sync` es público y no devuelve datos personales ni cifras: solo `{ status, sync }`. Mira los buzones
sincronizables (Gmail/Microsoft de organizaciones `ACTIVE`, en estado `ACTIVE` —los que sondea el worker— o
`ERROR` —autorización perdida—), el *scheduler* de sondeo del worker y los correos pendientes o fallidos.
Se evalúa en este orden:

| HTTP | `status` / `sync` | Significado |
|---|---|---|
| 503 | `down` / `unavailable` | Redis o la base de datos no responden |
| 503 | `down` / `stalled` | el *scheduler* `poll-active-accounts` lleva más de dos intervalos sin ejecutarse: ningún worker consume la cola `email-events` (si el sondeo está desactivado y el *scheduler* no existe, no se evalúa) |
| 200 | `ok` / `idle` | no hay buzones sincronizables |
| 503 | `down` / `error` | todos los buzones sincronizables están en `ERROR`: no se sincroniza nada |
| 503 | `down` / `stale` | más de la mitad de los buzones `ACTIVE` atrasados (con uno solo, basta ese): la sincronización está parada |
| 200 | `degraded` / `degraded` | algún buzón en `ERROR`, atrasado, con error reciente, (con push de Gmail configurado) con el *watch* a < 12 h de caducar o (con push de Microsoft activado) sin suscripción de Graph o con ella a < 12 h de caducar; o correos en `RECEIVED`/`PROCESSING` hace más de 30 min (buzones `ACTIVE`); o correos `FAILED` en las últimas 24 h |
| 200 | `ok` / `healthy` | todo lo anterior en orden |

"Atrasado" = sin sincronización correcta en `SYNC_HEALTH_STALE_MINUTES` (20 por defecto). Un buzón roto entre
otros sanos (dos o más) no deja el endpoint en 503 de forma permanente (queda `degraded`, que un monitor puede
vigilar por palabra clave); los correos atascados o fallidos nunca pasan de `degraded`. El worker renueva los
*watches* cuando les quedan < 24 h, así que solo se avisa a partir de 12 h. Supone el sondeo activo
(`WORKER_POLL_INTERVAL_MINUTES` > 0 y menor que el umbral). La lectura del *scheduler* es de solo lectura
(no crea ni modifica nada en Redis). El resultado se cachea 30 s en el proceso, porque `/health/*` no tiene
rate limiting. No usarlo como health check de Render (igual que `/health/ready`). Operación: `docs/operations.md`.

## Usuario y organizaciones

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/me` | autenticado — usuario, membresías e `isPlatformAdmin` |
| POST | `/api/me/login-event` | miembro — registra `LOGIN` en auditoría |
| POST | `/api/organizations` | autenticado — el creador queda como OWNER |
| GET | `/api/organizations/current` | miembro — organización, rol y configuración |
| PATCH | `/api/organizations/current` | `organization:update` |
| GET / PATCH | `/api/organizations/current/settings` | miembro / `settings:update` |
| POST | `/api/organizations/current/transfer-ownership` | `organization:transfer-ownership` |
| GET | `/api/organizations/current/members` | `members:read` |
| POST | `/api/organizations/current/members` | `members:manage` (`{ email, role }`) |
| PATCH / DELETE | `/api/organizations/current/members/:id` | `members:manage` |

## Cuentas de correo

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/email-accounts`, `/api/email-accounts/:id` | `email-accounts:read` |
| GET | `/api/email-accounts/providers` | `email-accounts:read` → `{ providers: { GMAIL, MICROSOFT, IMAP } }` (booleanos: proveedor configurado en el servidor) |
| POST | `/api/email-accounts/oauth/:provider/start` (`gmail`/`microsoft`) | `email-accounts:manage` → `{ authorizationUrl }` |
| GET | `/api/oauth/:provider/callback` | público (state firmado) → redirige a `WEB_APP_URL/accounts?oauth=…` |
| POST | `/api/email-accounts/imap` | `email-accounts:manage` — **deshabilitado**: 503 `IMAP_NOT_AVAILABLE` (no se guardan credenciales) |
| PATCH | `/api/email-accounts/:id` (`status: ACTIVE/PAUSED`, `displayName`) | `email-accounts:manage` |
| POST | `/api/email-accounts/:id/disconnect` | `email-accounts:manage` |
| POST | `/api/email-accounts/:id/sync` | `email-accounts:sync` |
| DELETE | `/api/email-accounts/:id` (solo desconectadas) | `email-accounts:manage` |

## Categorías y reglas

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/categories`, `/api/categories/:id` | `categories:read` |
| POST / PATCH / DELETE | `/api/categories[/:id]` | `categories:manage` |
| GET | `/api/rules`, `/api/rules/:id` | `rules:read` |
| POST / PATCH / DELETE | `/api/rules[/:id]` | `rules:manage` |
| POST | `/api/rules/:id/test` (`{ email }`) | `rules:read` |
| POST | `/api/rules/test` (`{ rule, email }`, regla sin guardar) | `rules:read` |

Las pruebas de reglas devuelven `regexTimedOut: true` si alguna regex superó su límite de tiempo (se evalúa como "no coincide").

Formato de una regla:

```json
{
  "name": "Códigos",
  "enabled": true,
  "priority": 10,
  "stopProcessing": true,
  "matchMode": "AND",
  "categoryId": "uuid | null",
  "conditions": [
    { "field": "sender", "operator": "contains", "value": "example.com" },
    { "field": "subject", "operator": "contains", "value": "código" }
  ],
  "actions": [
    { "type": "MARK_IMPORTANT" },
    { "type": "EXTRACT", "name": "verification_code", "preset": "verification_code", "source": "any" },
    { "type": "NOTIFY", "channel": "in_app" }
  ]
}
```

- Campos: `sender`, `recipient`, `subject`, `body`, `date`, `attachment`.
- Operadores: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `regex`, `exists`, `not_exists` y, solo para fechas, `before`/`after`.
- Acciones: `MARK_IMPORTANT`, `MARK_READ`, `ARCHIVE`, `NOTIFY` (`channel`: solo `in_app`, por defecto), `EXTRACT` (`preset`: `verification_code`, `url`, `amount`, `email`; o `pattern`).
- La categoría vive en la columna `category_id` (FK) y no dentro del JSON.

## Correos y adjuntos

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/emails?page&pageSize&accountId&categoryId(=uuid\|none)&status&isRead&isImportant&isArchived&hasAttachments&search&from&to` | `emails:read` |
| GET | `/api/emails/:id` | `emails:read` |
| PATCH | `/api/emails/:id` (`isRead`, `isImportant`, `isArchived`, `categoryId`) | `emails:update` |
| DELETE | `/api/emails/:id` | `emails:delete` |
| GET | `/api/attachments/:id/download` → `{ url, expiresIn }` (URL firmada, 60 s) | `emails:read` |

El resumen de cada correo incluye `attachmentCount` y `extractedData`.

## Auditoría

`GET /api/audit-logs?page&pageSize&action&entityType` — `audit:read` (solo lectura).

## Administración de plataforma (Super Admin, V2 fase 6)

Solo usuarios con fila en `platform_admins` (`requirePlatformAdmin`, comprobado en cada petición; el resto recibe
`403 PLATFORM_ADMIN_REQUIRED` antes de leer ningún dato). No usan `X-Organization-Id`. Solo metadatos y
estadísticas: nunca cuerpos, HTML, datos extraídos, adjuntos, credenciales, identificadores de clientes, Access IDs
ni sesiones.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/admin/stats` | Totales de la plataforma (organizaciones por estado, miembros, bots, clientes, cuentas, correos, entregas) |
| GET | `/api/admin/organizations` | `search`, `status`, `plan`, `sort` (`created_desc`, `created_asc`, `name_asc`, `name_desc`), `page`, `pageSize` (≤ 100) |
| POST | `/api/admin/organizations` | `{ name, ownerEmail, plan?, slug? }`: el OWNER debe ser un usuario existente con correo confirmado (`422 OWNER_NOT_FOUND`) |
| GET | `/api/admin/organizations/:id` | Resumen, owner y contadores |
| PATCH | `/api/admin/organizations/:id` | `{ plan?, status? }` (suspender / reactivar / cancelar) |
| GET | `/api/admin/organizations/:id/members` | Nombre, correo, rol, fecha de alta |
| GET | `/api/admin/organizations/:id/bots` | Estado, reglas, clientes asignados, entregas |
| GET | `/api/admin/organizations/:id/customers` | Nombre, estado, bots, entregas (paginado) |
| GET | `/api/admin/organizations/:id/email-accounts` | Proveedor, dirección, estado, sincronización y push |
| GET | `/api/admin/activity` | Eventos de las organizaciones (`organizationId?`, `page`, `pageSize`; `hasMore`) |
| GET | `/api/admin/audit` | Auditoría de plataforma (`platform_audit_logs`; mismo paginado) |

- Autorización: `authenticate` + `requirePlatformAdmin`, que consulta `admin.is_platform_admin` (tabla
  `platform_admins`) en cada petición: la revocación es inmediata. Los roles de organización (`OWNER`, `ADMIN`, …)
  no dan acceso a estas rutas, y ser administrador de plataforma no da acceso a los endpoints de una organización.
- Cada ruta llama a una función `admin.*` con el usuario del JWT como actor, y la función lo vuelve a comprobar
  (`platform_stats`, `list_organizations`, `get_organization`, `create_organization`, `update_organization`,
  `list_members`, `list_bots`, `list_customers`, `list_email_accounts`, `list_activity`, `list_audit`).
- Paginado de `organizations` y `customers`: `{ items, page, pageSize, total }`; `total` es el total real del
  filtro también en una página fuera de rango. `activity` y `audit`: `{ items, page, pageSize, hasMore }`.
- `PATCH` con `status`: `ACTIVE`, `SUSPENDED` o `CANCELLED`. CANCELLED hoy tiene los mismos efectos que SUSPENDED
  y es reversible; nada se borra.
- Errores: `400 VALIDATION_ERROR` / `INVALID_SLUG`, `403 PLATFORM_ADMIN_REQUIRED`, `404 NOT_FOUND`,
  `409 ALREADY_EXISTS` (slug duplicado), `422 OWNER_NOT_FOUND`, `429` (escrituras: 60/min).
- Auditoría: cada creación y cada cambio de plan o estado escribe en `platform_audit_logs` en la misma transacción
  (`organization.created`, `organization.plan_changed`, `organization.suspended`, `organization.reactivated`,
  `organization.cancelled`), con el request id. Los registros son inmutables.
- `GET /api/me` incluye `isPlatformAdmin` (solo para mostrar la consola; la protección es la API).

## Webhooks

### `POST /webhooks/gmail` (Gmail push vía Google Cloud Pub/Sub)

Gmail (`users.watch`) publica en un topic de Pub/Sub; una suscripción **push** de ese topic llama a este endpoint.
La ruta solo existe (si no, `404`) cuando hay al menos un método de autenticación configurado en la API:

- **OIDC (recomendado; el que usa producción)**: Pub/Sub envía `Authorization: Bearer <JWT firmado por Google>`.
  La API verifica la firma RS256 con las claves públicas de Google (JWKS en caché), `iss`, la audiencia
  `GMAIL_PUBSUB_OIDC_AUDIENCE` y que el `email` sea la cuenta de servicio de push
  `GMAIL_PUBSUB_SERVICE_ACCOUNT`. Token ausente o inválido → `401`; claves de Google no disponibles → `503`
  (Pub/Sub reintenta; nunca se acepta un push sin verificar).
- **Token compartido (legado)**: `?token=` comparado en tiempo constante con `GMAIL_PUBSUB_VERIFICATION_TOKEN`.
  Si se configuran ambos, se exigen los dos. Con OIDC la URL de la suscripción no lleva `?token=`.

Después de autenticar, la API responde rápido y no llama a Gmail:

1. Valida el sobre de Pub/Sub y decodifica `{ emailAddress, historyId }`. Un mensaje malformado se confirma con
   `204` para que Pub/Sub no lo reintente sin fin.
2. Un buzón que no corresponde a ninguna cuenta Gmail ACTIVE se confirma con `204` y se descarta (sin job).
3. Encola **un** job deduplicado en BullMQ (`jobId` = buzón + `historyId`: los reenvíos son el mismo job) y responde
   `204`. Si la cola no está disponible → `503` y Pub/Sub reintenta.

El worker resuelve la cuenta y la sincroniza (`SYNC_ACCOUNT`, motivo `PUBSUB`) desde **su propio cursor
guardado**, no desde el `historyId` recibido (solo es un disparador): Gmail History API paginada, `messages.get` y
el pipeline normal (reglas, bot, cliente, entregas). El cursor avanza con *compare-and-set* bajo un *lease* por
cuenta en Redis; un *history gap* se recupera con una búsqueda acotada. El polling cada 5 minutos sigue como
recuperación, y `RENEW_WATCHES` renueva los `users.watch` antes de que caduquen. Los jobs solo llevan ids, nunca
tokens ni credenciales; los logs registran el buzón con hash. Rate limit propio de webhooks (1200/min).

### `POST /webhooks/microsoft` y `POST /webhooks/microsoft/lifecycle` (Microsoft Graph, F9)

Notificaciones de cambio de Microsoft Graph para buzones de Microsoft 365 / Outlook. Mismo contrato que el push de
Gmail: autenticar, validar, encolar **un** job y responder rápido; ni la API ni el job procesan el mensaje
notificado: el worker solo sincroniza la cuenta desde su cursor delta. Solo existen (si no, `404`) con
`MICROSOFT_GRAPH_PUSH_ENABLED=true` y el cliente OAuth de Microsoft configurado.

- **Handshake**: Graph valida cada URL al crear la suscripción con `POST …?validationToken=<texto>`. Ambas rutas
  devuelven `200` `text/plain` con el token exacto (decodificado) y no hacen nada más. Un token vacío o de más de
  4096 caracteres → `400` (nunca se trunca).
- **Autenticación**: cada suscripción tiene su propio `clientState` aleatorio (256 bits), generado por el worker al
  crearla; la base de datos solo guarda su SHA-256 (`provider_metadata.subscriptionClientStateHash`). Cada
  notificación se acepta solo si su `subscriptionId` (GUID) corresponde a una cuenta Microsoft y el SHA-256 de su
  `clientState` coincide (comparación en tiempo constante). No hay secreto compartido.
- **Notificaciones** (`/webhooks/microsoft`, `changeType: created` en la Inbox): cuenta y organización `ACTIVE` →
  job `MICROSOFT_NOTIFICATION` con `jobId` = hash(suscripción + id del mensaje) (un reenvío es el mismo job).
  Suscripción desconocida, `clientState` incorrecto o cuenta inactiva → se ignora. Cuerpo malformado → `202` sin
  efecto. Base de datos o cola no disponibles → `503` (Graph reintenta; nunca se acepta sin verificar). Respuesta
  normal: `202`.
- **Ciclo de vida** (`/webhooks/microsoft/lifecycle`): `reauthorizationRequired`, `subscriptionRemoved` y `missed`,
  autenticados igual → job `MICROSOFT_LIFECYCLE`; otros eventos se ignoran.
- **Logs**: nunca el `clientState`, la ruta del recurso ni el id de la suscripción en claro (hash corto).

En el worker, `MICROSOFT_NOTIFICATION` (y `missed`) solo encola la sincronización coalescida de la cuenta (motivo
`GRAPH`): delta query de la Inbox desde el cursor guardado y el pipeline normal, igual que Gmail. El polling cada 5
minutos sigue como red de seguridad. Operación: `docs/operations.md`.

## Tiempo real (Socket.IO)

- Ruta: `path: "/realtime"` en `API_PUBLIC_URL`.
- Handshake: `auth: { token, organizationId }`. El servidor valida el token y la membresía y une el socket a la sala `org:<id>`.
- Eventos:
  - `email.processed`: `{ organizationId, emailId, emailAccountId, categoryId, matchedRuleId, subject, important }`
  - `notification`: `{ organizationId, emailId, title, body }`
  - `email-account.status`: `{ organizationId, emailAccountId, status }`

Portal del cliente (V2 fase 7): namespace `/portal` en la misma ruta `/realtime`.

- Handshake: solo transporte WebSocket; la credencial es la cookie de sesión del portal (la envía el navegador) y el
  `Origin` debe estar en `CORS_ORIGINS`. Rechazos: `forbidden_origin`, `unauthorized`. El servidor une el socket a la
  sala de su propio cliente; el cliente no envía nada.
- Eventos (sin datos): `portal:inbox.changed` (volver a pedir la bandeja) y `portal:revoked` (sesión ya no válida; el
  servidor cierra el socket). Revalidación de la sesión cada minuto.
