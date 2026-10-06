# Arquitectura

## Flujo de procesamiento

```
Provider event (Gmail Pub/Sub, Graph notification, polling, "sincronizar")
        │
        ▼
API /webhooks/*  → valida token/clientState → encola (responde rápido, no procesa)
        │
        ▼  BullMQ "email-events"
Worker: resuelve cuenta(s) → lista IDs nuevos (historyId / deltaLink) → avanza cursor
        │
        ▼  BullMQ "email-processing" (jobId determinista por cuenta+mensaje)
Worker: cuenta activa? → ¿ya existe? → reglas habilitadas → fetch → NormalizedEmail
        → rules-engine → (sin coincidencia: se descarta) → INSERT … ON CONFLICT DO NOTHING
        → adjuntos (metadatos + Storage privado opcional) → Redis pub/sub → notificaciones
        │
        ▼
API (Socket.IO, sala por organización) → navegador invalida queries de TanStack Query
```

### Idempotencia

Tres capas: job id determinista en BullMQ, verificación previa en la tabla y el índice único
`emails(email_account_id, provider_message_id)` (migración 5) con `ON CONFLICT DO NOTHING`.

### Procesamiento reanudable (migración 9)

El estado vive en la base de datos: el worker inserta el correo `RECEIVED`, lo pasa a `PROCESSING` y solo
lo marca `PROCESSED` (con `processed_at`) cuando filas de adjuntos, contenidos en Storage, evento realtime
y notificaciones terminaron. Quien encuentre un correo `RECEIVED`/`PROCESSING` lo reanuda (reintento de
BullMQ, job *stalled*, nueva entrega del mensaje, otro worker concurrente o el barrido de recuperación),
incrementando `processing_attempts`. Cada paso es idempotente:

- correo: índice único `(email_account_id, provider_message_id)` + `ON CONFLICT DO NOTHING`;
- filas de adjuntos: índice único `(email_id, provider_attachment_id)` + `ON CONFLICT DO NOTHING`
  (los `NULL` nunca chocan; para adjuntos sin id el worker deduplica por nombre);
- contenidos: clave de Storage determinista, reutilizada si ya existe; la fila se marca después de subir;
- realtime: el navegador deduplica por `emailId`; notificaciones: job id determinista
  (`notify-<email>-<regla>-<canal>`), y no se reenvían si la reanudación ocurre pasadas 23 h.

Barrido de recuperación (`RECOVER_INCOMPLETE`, cada 10 min): correos de cuentas activas que siguen
incompletos 15 min después de empezar se reencolan con job id `resume-<email>-<processing_attempts>`;
con 25 intentos se marcan `FAILED` (`RECOVERY_EXHAUSTED`) conservando sus datos. Storage no forma parte de
ninguna transacción SQL: la garantía es reanudación idempotente, no atomicidad.

El estado de procesamiento lo escribe solo el worker: `service_role` puede actualizar únicamente
`processing_status`, `processed_at`, `processing_error_code`, `processing_error_message` y
`processing_attempts` (sin DELETE), y `authenticated` ya no puede escribirlas.

### Storage de adjuntos

Clave determinista `<org>/<email>/<adjunto>/<nombre ASCII>`; antes de descargar se comprueba si el
objeto ya existe (lo reutiliza si un intento anterior lo subió pero no pudo marcar la fila); subida y
marcado se reintentan dentro del job y, si siguen fallando, el job falla como reintentable
(`AttachmentsPendingError`). La fila solo se marca `storage_uploaded` tras subir con éxito. Al borrar un
correo o una cuenta, la API elimina sus objetos (solo rutas con el formato esperado de esa
organización) después de borrar las filas; un fallo se registra y no deshace el borrado.

## Multi-tenant

```
User → Organization → Members → Email Accounts → Rules → Emails → Attachments → Audit Logs
```

- RLS en todas las tablas (`private.is_organization_member`, `private.has_organization_role`).
- La API crea un cliente Supabase **por petición** con el JWT del usuario: PostgREST aplica RLS.
- Además, cada consulta filtra por la organización activa (un usuario puede pertenecer a varias).
- Triggers impiden referencias cruzadas entre organizaciones (email ↔ cuenta/categoría/regla, adjunto ↔ email).
- La service role solo se usa en `apps/api/src/repositories/supabase/privileged.ts` y en el worker,
  después de verificar autenticación, membresía y rol.

### Roles

| Permiso | OWNER | ADMIN | OPERATOR | VIEWER |
|---|:-:|:-:|:-:|:-:|
| Leer correos, reglas, categorías, cuentas, miembros | ✓ | ✓ | ✓ | ✓ |
| Actualizar correos (leído, importante, categoría, archivar) | ✓ | ✓ | ✓ | |
| Sincronizar cuentas | ✓ | ✓ | ✓ | |
| Gestionar cuentas, reglas, categorías, miembros, configuración | ✓ | ✓ | | |
| Eliminar correos, leer auditoría | ✓ | ✓ | | |
| Transferir propiedad | ✓ | | | |

La matriz vive en `packages/types/src/permissions.ts` y replica las políticas RLS. Reglas extra:
nadie cambia su propio rol, el OWNER solo cambia por transferencia y una organización nunca queda sin OWNER
(trigger diferido en la base de datos).

## Base de datos

Migraciones en `supabase/migrations` (las 4 primeras son históricas y no se modifican):

1. `initial_schema`: perfiles, organizaciones, miembros, RBAC, RPCs `create_organization` / `transfer_organization_ownership`.
2. `email_accounts_categories_rules`: cuentas (tokens cifrados), categorías y reglas JSONB.
3. `emails_and_attachments`: correos, adjuntos, búsqueda full-text, triggers anti cross-tenant, tokens no legibles por `authenticated`.
4. `organization_settings_and_audit_logs`: configuración y auditoría inmutable.
5. `email_dedup_storage_and_audit_integrity`: índice único de deduplicación, bucket privado `email-attachments`
   y corrección de auditoría para permitir el borrado en cascada de organizaciones y la anonimización al borrar usuarios.
6. `security_hardening`: `storage_*` de adjuntos solo escribible por la service role, categoría de regla del
   mismo tenant y `REVOKE EXECUTE` condicional de `public.rls_auto_enable()` (objeto del proyecto remoto).
7. `service_role_minimal_grants`: privilegios explícitos y mínimos de `service_role` (idénticos en local y producción).
8. `bounded_email_search_vector`: el `search_vector` indexa solo los primeros 50.000 caracteres de
   asunto + remitente + snippet + cuerpo (límite de 1 MB de `tsvector`; peor caso medido ≈ 375 KB).
   `text_body` se guarda completo.
9. `processing_completion`: `UPDATE` de `service_role` limitado a las columnas de estado de procesamiento,
   índice único `email_attachments(email_id, provider_attachment_id)` y estado de procesamiento no
   escribible por `authenticated`.

Adjuntos en Storage: `<org>/<email>/<adjunto>/<nombre físico>`. El nombre físico usa solo `[A-Za-z0-9._-]`
(`storageObjectName`: transliteración + hash del nombre original cuando cambia), porque Storage rechaza
claves no ASCII. El nombre original se conserva en `email_attachments.filename` y es el de la descarga.

## Seguridad

- **Credenciales**: AES-256-GCM (`TOKEN_ENCRYPTION_KEY`), columnas no legibles por `authenticated`.
- **OAuth**: `state` firmado con HMAC y con expiración; el callback vuelve a verificar el rol con la service role.
- **Logs**: pino con redacción de `authorization`, cookies, tokens y secretos; las URLs se sanean (`code`, `state`, `token`).
- **Sentry**: opcional; `dataCollection` restringido (sin headers, cuerpos ni variables locales).
- **Regex de usuario**: validación estática (longitud, cuantificadores anidados, alternativas repetidas,
  backreferences) y ejecución con `RegexGuard` (`node:vm`, 50 ms por regex y 250 ms por correo).
  Las regex internas sobre contenido del correo son lineales.
- **Rate limiting**: `@fastify/rate-limit` por IP (Redis compartido), con límites estrictos en rutas sensibles.
  Si Redis falla, cada petición se cuenta en memoria de la instancia (nunca queda ilimitada; con N
  instancias el máximo efectivo es N × límite mientras dure la caída).
- **Realtime**: el navegador envía su token renovado (`auth:refresh`); el servidor lo verifica (mismo
  usuario y membresía) y lo usa en la revalidación periódica (cada 5 minutos). Si la sesión ya no es
  válida, el servidor avisa (`realtime:revoked` `token`) y cierra; el navegador renueva la sesión y
  reconecta. Si se perdió la membresía (`membership` / `forbidden`) no reconecta. Una conexión por
  usuario y organización; se cierra al cambiar de organización o cerrar sesión. Con una sola instancia
  de API no hace falta adapter; con varias, cada instancia recibe el pub/sub de Redis y emite a sus
  propios sockets (no se necesita `@socket.io/redis-adapter` mientras los clientes no emitan a salas).
- **Timeouts HTTP**: toda llamada saliente (Google, Microsoft, Supabase) usa `fetchWithTimeout`
  (`PROVIDER_HTTP_TIMEOUT_MS`, 20 s; `SUPABASE_HTTP_TIMEOUT_MS`, 60 s), que cubre también el cuerpo
  de la respuesta. En el worker un timeout es un error transitorio (BullMQ reintenta con backoff);
  los errores de credenciales siguen sin reintentarse. Comandos Redis del productor: 5 s.
- **Configuración de producción**: con `NODE_ENV=production` la API y el worker no arrancan si faltan
  `API_PUBLIC_URL`, `WEB_APP_URL`, `REDIS_URL` o si estas, `SUPABASE_URL`, `CORS_ORIGINS` o las
  redirect URIs apuntan a localhost/loopback; las URLs públicas deben ser HTTPS. `REDIS_URL` admite
  `redis://` (red privada) o `rediss://` (recomendado para Redis gestionado). Las credenciales OAuth
  deben venir completas (id + secret + redirect URI). El build web de despliegue
  (`NODE_ENV=production pnpm build`) falla si `VITE_API_URL`/`VITE_SUPABASE_URL` faltan, no son HTTPS o
  son locales, y nunca acepta una service role key en `VITE_SUPABASE_ANON_KEY`.
- **OAuth**: `state` firmado, con expiración y de un solo uso (nonce en Redis).
- Auditoría completa y estado de producción: [`security-audit.md`](security-audit.md).
- **Frontend**: solo anon key; el HTML de correos se muestra en iframe `sandbox` sin scripts y con CSP.

Despliegue (puertos, health checks, CSP, Docker): [`deployment.md`](deployment.md).

## Pendientes

- Registro y renovación de suscripciones push: Gmail `users.watch` y Graph `subscriptions`. Mientras tanto se usa polling (`WORKER_POLL_INTERVAL_MINUTES`).
- Sincronización IMAP (adapter scaffold; las cuentas se crean en pausa).
- Notificaciones por email: no implementadas; el canal `email` se retiró del contrato de reglas en V2 F7 (solo in-app).
- Invitaciones por correo a personas sin cuenta (hoy solo se agregan usuarios registrados).
- Tipos generados de la base de datos (`supabase gen types`) en lugar de filas sin tipar en los repositorios.
- Endpoint de estadísticas dedicado (el dashboard usa los `total` de `GET /api/emails`).
- Invitaciones con aceptación, retención (`email_retention_days`) y revocación de tokens al desconectar
  (ver [`security-audit.md`](security-audit.md)).
