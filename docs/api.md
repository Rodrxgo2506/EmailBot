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
| POST | `/api/email-accounts/oauth/:provider/start` (`gmail`/`microsoft`) | `email-accounts:manage` → `{ authorizationUrl }` |
| GET | `/api/oauth/:provider/callback` | público (state firmado) → redirige a `WEB_APP_URL/accounts?oauth=…` |
| POST | `/api/email-accounts/imap` | `email-accounts:manage` |
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
- Acciones: `MARK_IMPORTANT`, `MARK_READ`, `ARCHIVE`, `NOTIFY`, `EXTRACT` (`preset`: `verification_code`, `url`, `amount`, `email`; o `pattern`).
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

## Webhooks

- `POST /webhooks/gmail?token=…`: Pub/Sub push (requiere `GMAIL_PUBSUB_VERIFICATION_TOKEN`).
- `POST /webhooks/microsoft`: validación (`validationToken`) y notificaciones con `clientState`.

## Tiempo real (Socket.IO)

- Ruta: `path: "/realtime"` en `API_PUBLIC_URL`.
- Handshake: `auth: { token, organizationId }`. El servidor valida el token y la membresía y une el socket a la sala `org:<id>`.
- Eventos:
  - `email.processed`: `{ organizationId, emailId, emailAccountId, categoryId, matchedRuleId, subject, important }`
  - `notification`: `{ organizationId, emailId, title, body }`
  - `email-account.status`: `{ organizationId, emailAccountId, status }`
