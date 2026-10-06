# V2 en producción: runbook de despliegue (Gmail casi en tiempo real + portal)

Resultado de la auditoría de preparación (fase 5.7, 2026-10-05). Cada paso necesitó autorización explícita en su
momento; los cambios de base de datos, además, un *dry-run* previo.

> **Estado actual.** Este runbook ya se ejecutó: V2 hasta la fase 5.7 (`main` = `34ce322`) está desplegada en
> producción, con el portal y Gmail push (Pub/Sub + OIDC) funcionando; los logs de producción muestran
> `gmail.sync.started` / `gmail.sync.completed` con `reason: PUBSUB`, y el polling de 5 minutos sigue como
> recuperación. La sección 1 conserva el estado observado **antes** del despliegue (histórico).
>
> **La fase 6 (Super Admin) no forma parte de ese despliegue**: está implementada en la rama
> `feat/emailbot-f6-super-admin`, todavía **no** mergeada en `main` ni desplegada. Su despliegue es la
> [sección 12](#12-fase-6-super-admin-pendiente-de-despliegue).

## 1. Estado observado antes del despliegue de V2 (solo lectura, histórico)

| Elemento | Estado |
|---|---|
| Supabase Production | 9 migraciones (V1, hasta `20261003150000`). 15 migraciones V2 pendientes. Sin schema `portal`. Postgres 17 |
| Datos | 1 organización ACTIVE, 1 cuenta Gmail ACTIVE (dirección en minúsculas, cursor de historial presente, token válido, sin error), 0 correos, 1 regla |
| Worker V1 | Hace polling correctamente: último sync de hace ~1 min, sin errores. Por tanto ya tiene las credenciales de Google y la misma `TOKEN_ENCRYPTION_KEY` que la API (descifra los tokens que guardó la API) |
| API | `https://api.emailbot.app/health` responde 200 |
| Web | `https://emailbot.app` (Static Site con *rewrite* a `index.html`) |

## 2. Google Cloud

Todo en el **mismo proyecto de Google Cloud del OAuth client de Gmail** (recomendado: Gmail valida el topic
contra el proyecto del cliente que llama a `users.watch`). Nombres sugeridos; los valores reales los decide el
operador.

| Recurso | Requerido | Configuración |
|---|---|---|
| Gmail API | sí | Ya habilitada (el polling V1 funciona) |
| Pub/Sub API | sí | `pubsub.googleapis.com` habilitada |
| Topic | sí | `projects/<PROJECT_ID>/topics/emailbot-gmail-push` |
| Permiso de Gmail | sí | `roles/pubsub.publisher` sobre el topic para `gmail-api-push@system.gserviceaccount.com` |
| Cuenta de servicio de push (OIDC) | sí | `emailbot-pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`. No necesita ningún rol propio: solo es la identidad del token |
| Token Creator | sí | `roles/iam.serviceAccountTokenCreator` para el agente de Pub/Sub `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` (sobre esa cuenta de servicio) |
| Quien crea la suscripción | sí | `iam.serviceAccounts.actAs` sobre la cuenta de servicio (`roles/iam.serviceAccountUser`; un Owner ya lo tiene) |
| Suscripción push | sí | Ver abajo |
| Dead letter topic | **no** | La notificación no lleva datos: si se pierde, el polling (5 min) recupera el correo |
| Política de dominio (`iam.allowedPolicyMemberDomains`) | solo si existe una organización de GCP | Debe permitir `gmail-api-push@system.gserviceaccount.com` |

Suscripción push:

| Parámetro | Valor | Motivo |
|---|---|---|
| Endpoint | `https://api.emailbot.app/webhooks/gmail` | Dominio propio, no `*.onrender.com`. Sin `?token=` |
| Autenticación | OIDC con la cuenta de servicio de push | La API verifica firma RS256 (JWKS de Google), `iss`, `aud`, `email`, `email_verified`, `exp` |
| Audiencia | `https://api.emailbot.app/webhooks/gmail` **explícita** | Debe ser idéntica, carácter a carácter, a `GMAIL_PUBSUB_OIDC_AUDIENCE` (comparación exacta) |
| Formato | *wrapped* (por defecto). **No** activar *payload unwrapping* | El webhook espera `{ message: { data } }` |
| Ack deadline | 30 s | El webhook responde en milisegundos; margen para la primera descarga de las claves de Google |
| Retry policy | backoff exponencial, mínimo 10 s, máximo 600 s | Evita reintentos en ráfaga mientras la API devuelve 503 |
| Expiración | **never** | Por defecto una suscripción sin actividad caduca a los 31 días: un buzón sin correo durante un mes perdería el push en silencio |
| Retención de mensajes | 1 día | Una notificación vieja no aporta nada (el worker sincroniza desde su cursor) |

Comandos de referencia (no ejecutados):

```bash
PROJECT_ID=<proyecto del OAuth client>
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
PUSH_SA="emailbot-pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable pubsub.googleapis.com --project="$PROJECT_ID"
gcloud pubsub topics create emailbot-gmail-push --project="$PROJECT_ID"
gcloud pubsub topics add-iam-policy-binding emailbot-gmail-push --project="$PROJECT_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher"
gcloud iam service-accounts create emailbot-pubsub-push --project="$PROJECT_ID" --display-name="EmailBot Pub/Sub push (OIDC)"
gcloud iam service-accounts add-iam-policy-binding "$PUSH_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
# Solo después de configurar la API (paso 7 del orden):
gcloud pubsub subscriptions create emailbot-gmail-push-api --project="$PROJECT_ID" --topic=emailbot-gmail-push \
  --push-endpoint="https://api.emailbot.app/webhooks/gmail" \
  --push-auth-service-account="$PUSH_SA" --push-auth-token-audience="https://api.emailbot.app/webhooks/gmail" \
  --ack-deadline=30 --min-retry-delay=10s --max-retry-delay=600s \
  --expiration-period=never --message-retention-duration=1d
```

OAuth: sin cambios. El scope `gmail.readonly` ya cubre `users.watch`, `history.list`, `messages.list` y
`messages.get`. Redirect: `https://api.emailbot.app/api/oauth/gmail/callback`. **Verificar** (no cambiar) el
estado de publicación de la pantalla de consentimiento: en modo *Testing*, Google caduca los refresh tokens a
los 7 días y la cuenta pasaría a `ERROR` (riesgo previo a V2, ver §11).

## 3. Render

Valores secretos: nunca en este documento. Leyenda: **nueva** = hay que añadirla; **existente** = ya la usa V1.

### API (`emailbot-api`)

| Variable / config | Requerido | Estado | Acción futura |
|---|---|---|---|
| `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET` | sí | existente | ninguna |
| `API_PUBLIC_URL=https://api.emailbot.app`, `WEB_APP_URL=https://emailbot.app` | sí | existente | verificar valores |
| `CORS_ORIGINS` | sí | existente | debe contener exactamente `https://emailbot.app` (el portal envía cookie; solo `/api/portal/*` permite credenciales) |
| `TRUST_PROXY` | sí | existente | ninguna |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | sí | existente | ninguna (el callback encola `WATCH_ACCOUNT`) |
| `GMAIL_PUBSUB_OIDC_AUDIENCE` | sí para push | **nueva** | `https://api.emailbot.app/webhooks/gmail` |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | sí para push | **nueva** | email de la cuenta de servicio de push. La API no arranca si solo está una de las dos |
| `GMAIL_PUBSUB_VERIFICATION_TOKEN` | no | desconocido | **verificar que no exista**: si existe, cada push sin `?token=` recibe 401 |
| Health check `/health`, `PORT` inyectado, `EMAILBOT_TARGET=api` | sí | existente | ninguna |

### Worker (`emailbot-worker`)

| Variable / config | Requerido | Estado | Acción futura |
|---|---|---|---|
| `NODE_ENV`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY` | sí | existente | la huella `tokenEncryptionKeyFingerprint` del log de arranque debe coincidir con la de la API |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | sí (refresh de tokens: watch, history, mensajes, polling) | existente (el polling funciona) | ninguna; el log de arranque muestra `providersConfigured.gmail: true` |
| `GMAIL_PUBSUB_TOPIC` | sí para watch | **nueva** | `projects/<PROJECT_ID>/topics/emailbot-gmail-push` (el worker no arranca con otro formato) |
| `WORKER_WATCH_RENEW_INTERVAL_MINUTES` | no | — | no definir (60 por defecto) |
| `WORKER_POLL_INTERVAL_MINUTES` | no | existente o por defecto (5) | **no poner 0**: es la recuperación |
| `EMAILBOT_TARGET=worker`, `maxShutdownDelaySeconds` | sí | existente | ninguna |

### Web (`emailbot-web`, Static Site)

| Variable / config | Requerido | Estado | Acción futura |
|---|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL=https://api.emailbot.app` | sí | existente | ninguna (el portal no necesita variables nuevas) |
| Rewrite `/*` → `/index.html` | sí (`/portal/*`) | existente | ninguna |
| Auto-deploy desde `main` | — | activo (V1) | desactivarlo temporalmente antes del merge (ver §5) o aceptar el desfase |

### Redis (`emailbot-redis`)

| Config | Requerido | Estado | Acción futura |
|---|---|---|---|
| `maxmemory-policy noeviction` | sí (BullMQ) | sin verificar | verificar (BullMQ avisa en el log si no lo es) |
| Persistencia | recomendada | sin verificar | verificar el plan: sin persistencia, un reinicio de Redis borra los *job schedulers* (polling y renovación de watches) hasta reiniciar el worker |
| Comandos | sí | compatible | `SET NX PX`, `EVAL` (lease) y los de BullMQ 5.81 / ioredis 5.11. Nada nuevo |

## 4. Supabase Production

Migraciones pendientes (15), en este orden; todas **aditivas**:

```
20261004120000_bots                                  tabla nueva
20261004120100_rule_and_email_bot                    bot_id NULL en email_rules / emails, FK compuestas, índices parciales
20261004120200_organization_status_worker_access     grant select (id, status) en organizations al service role
20261004130000_customers                             tabla nueva
20261004130100_customer_identifiers                  tabla nueva
20261004130200_bot_customer_assignments              tabla nueva
20261004140000_email_deliveries                      tabla nueva + unique (organization_id, id, bot_id) en emails
20261004140100_worker_customer_resolution_access     grants al service role
20261004150000_customer_access_credentials           tabla nueva
20261004150100_customer_sessions                     tabla nueva + trigger en customers
20261004150200_customer_access_functions             schema portal + funciones
20261004160000_manual_deliveries                     columnas NULL en email_deliveries (tabla nueva de V2)
20261004160100_portal_data_functions                 funciones
20261004170000_portal_visibility_and_order           recrea portal.list_inbox (creada en la migración anterior)
20261004180000_gmail_watch_and_portal_sync           4 columnas NULL en email_accounts, índice parcial, portal.sync_scope
```

Seguridad de datos (revisado línea a línea):

- Ningún `DROP TABLE`, `TRUNCATE`, `DELETE` ni `UPDATE` de datos existentes. El único `DROP` es
  `portal.list_inbox`, una función que crea la propia V2.
- Columnas nuevas en tablas V1 (`email_rules.bot_id`, `emails.bot_id`, `email_accounts.watch_*`): todas NULL,
  sin *backfill* ni default que reescriba la tabla.
- Restricciones nuevas sobre tablas V1: `unique (organization_id, id, bot_id)` en `emails` (se cumple siempre
  porque `id` ya es único) y FK sobre `bot_id` (todo NULL). Ninguna puede fallar con los datos actuales.
- Índices sin `CONCURRENTLY`: bloqueo breve de escritura en `emails` / `email_rules` / `email_accounts` mientras se
  construyen. Con 0 correos, 1 regla y 1 cuenta es instantáneo.
- Compatibilidad V1: la API y el worker V1 funcionan sobre el schema V2 (lo comprueba
  `packages/database/test/v1-compatibility.test.ts` y la integración V1 150/150 sobre las 24 migraciones).

Schema `portal`:

- **Sí hay que exponerlo**, porque la API llama a `portal.*` por PostgREST con el service role: Dashboard → Project Settings → Data API → *Exposed
  schemas*: añadir `portal` y mantener `public` y `graphql_public`. Es el mismo cambio que `supabase/config.toml`
  (`schemas = ["public", "graphql_public", "portal"]`).
- **Solo después de aplicar las migraciones**: exponer un schema que no existe impide a PostgREST cargar su caché
  de schema (comprobado en local) y dejaría sin Data API también a V1.
- Visibles por PostgREST, ejecutables **solo** por `service_role` (EXECUTE revocado a PUBLIC, `anon` y
  `authenticated`; `usage` del schema solo para `service_role`): `create_session`, `validate_session`,
  `end_session`, `list_inbox`, `get_email`, `get_attachment`, `list_filters`, `sync_scope`.
- No visibles: todo `private.*` (no expuesto) y las tablas (el schema `portal` no tiene tablas).
- RLS: sin cambios de política sobre tablas V1. Storage: el bucket `email-attachments` existente; el portal usa
  URLs firmadas de 60 s generadas por la API.

Comprobaciones tras aplicar (solo lectura): `list_migrations` = 24; *advisors* de seguridad sin hallazgos nuevos;
`select has_function_privilege('anon', 'portal.validate_session(text)', 'execute')` = false (ídem `authenticated`).

## 5. Orden de despliegue

Cada paso se autoriza por separado; no se pasa al siguiente si la verificación falla.

| # | Paso | Verificación | Por qué en este orden |
|---|---|---|---|
| 0 | Comprobaciones previas (solo lectura): ajustes de auto-deploy de los 3 servicios, `GMAIL_PUBSUB_VERIFICATION_TOKEN` ausente, `CORS_ORIGINS`, estado de publicación de OAuth, Redis `noeviction`. Copia de seguridad: `supabase db dump` de esquema y datos a un fichero local fuera del repositorio | — | — |
| 1 | `supabase db push --linked --dry-run` (debe listar exactamente las 15 migraciones de §4) → autorización escrita → `supabase db push --linked` | `list_migrations` = 24; *advisors*; el worker V1 sigue sincronizando (`last_synced_at` avanza) y el panel V1 carga | La API y el worker V2 leen columnas y tablas nuevas; V1 tolera el schema V2 |
| 2 | Exponer `portal` (Dashboard) | `anon` no puede ejecutar `portal.*`; Data API V1 sin errores | Necesita el schema creado en el paso 1 |
| 3 | Desactivar el auto-deploy del Static Site (si está activo) y hacer merge de `feat/emailbot-v2` en `main` (PR) + push | — | Si no, la web V2 se publica minutos antes que la API V2 |
| 4 | Desplegar la **API** (sin variables de push todavía) | `/health` 200, `/health/ready` 200, huella de la clave en el log; `POST /webhooks/gmail` sigue en 404 (sin push configurado) | El portal y el panel V2 necesitan los endpoints nuevos |
| 5 | Desplegar el **worker** (sin `GMAIL_PUBSUB_TOPIC`) | Log `EmailBot worker started` con `gmailPush: false`, `providersConfigured.gmail: true` y la misma huella; `last_synced_at` sigue avanzando | El worker nuevo solo con polling: mismo comportamiento que V1, ya con bots y entregas |
| 6 | Desplegar la **web** (deploy manual) y reactivar el auto-deploy | `/portal/login` carga; panel con Bots / Customers | La web V2 llama a endpoints que solo existen en la API V2 |
| 7 | Configuración de prueba en el panel (bot, regla, customer con identificador, asignación activa, Access ID) | Login del portal | Los smoke tests 4-9 se hacen primero **con polling** (aísla el push) |
| 8 | Google Cloud: Pub/Sub API, topic, permiso de Gmail, cuenta de servicio, Token Creator (§2) | — | Sin watch todavía: nada publica en el topic |
| 9 | API: añadir `GMAIL_PUBSUB_OIDC_AUDIENCE` y `GMAIL_PUBSUB_SERVICE_ACCOUNT` (redeploy) | `POST /webhooks/gmail` sin token → **401** (antes 404) | La ruta debe exigir OIDC antes de recibir pushes |
| 10 | Crear la suscripción push (§2) | Métricas de la suscripción sin errores | — |
| 11 | Worker: añadir `GMAIL_PUBSUB_TOPIC` (redeploy) | `gmailPush: true`; `RENEW_WATCHES` corre al arrancar → `gmail.watch.created`; `watch_expires_at` ≈ ahora + 7 días, `watch_error_code` NULL | El watch es lo que hace publicar a Gmail |
| 12 | Smoke tests con push (§7) y medición de latencia (§8) | §7 | — |
| 13 | Pruebas de fallos (§9), cada una autorizada | §9 | — |

## 6. Rollback

Las migraciones **no se revierten**: son aditivas y el código V1 funciona sobre ellas. Se revierte el código y se
apaga el push.

1. **Solo push** (el resto de V2 sigue): borrar la suscripción (`gcloud pubsub subscriptions delete
   emailbot-gmail-push-api`; los pushes paran al momento) y quitar `GMAIL_PUBSUB_TOPIC` del worker (deja de renovar;
   los watches caducan solos en ≤ 7 días y Gmail publica en un topic sin suscripciones). Opcional: quitar las dos
   variables OIDC de la API (la ruta vuelve a 404). El correo sigue llegando por polling.
2. **Código**: primero el paso 1. Después, Render → *Rollback* al deploy V1 anterior en este orden: web, API,
   worker (la web V2 necesita la API V2; un worker V1 ignora sin fallar los jobs `WATCH_ACCOUNT` /
   `RENEW_WATCHES`). Las tablas V2 y sus datos quedan intactos y sin uso; el cursor de historial tiene el mismo
   formato en V1 y V2.
3. **Schema `portal`**: puede dejarse expuesto (solo `service_role`) o quitarse de *Exposed schemas* sin
   efecto en V1.
4. **Base de datos**: solo como último recurso, restaurar la copia del paso 0 (se pierde lo escrito después).
   No hay migraciones *down*; no se hace `DROP` en producción.

## 7. Smoke tests (después del despliegue)

Preparación: un correo de prueba enviado desde una dirección que coincida con el identificador del customer y con
un asunto que case con la regla del bot (p. ej. `EMAILBOT-SMOKE-<n>`).

| # | Prueba | Evidencia |
|---|---|---|
| 1 | Gmail recibe el correo | Visible en la bandeja de Gmail |
| 2 | Pub/Sub recibe el evento | Cloud Console → suscripción: `push_request_count` con respuesta 204 |
| 3 | La API recibe el webhook | Log `gmail.pubsub.received` (buzón hasheado, `historyId`) |
| 4 | El worker procesa | `gmail.sync.started` / `gmail.sync.completed` con `reason: "PUBSUB"` y `processed ≥ 1` |
| 5 | Correo en la base de datos | `select processing_status, bot_id is not null from emails where subject like 'EMAILBOT-SMOKE-%'` → `PROCESSED`, true |
| 6 | El motor de reglas clasifica | `matched_rule_id` / `category_id` del correo = la regla de prueba |
| 7 | Se crea la entrega | `email_deliveries` con `resolution = 'AUTOMATIC'` para el customer |
| 8 | El portal muestra el correo | Login con el Access ID → bandeja |
| 9 | «Actualizar» | Correo enviado; clic → «Actualizando...» → «Bandeja actualizada»; segundo clic antes de 30 s → «Espera unos segundos...» |
| 10 | Evento duplicado | Ver §9 (duplicado): una sola fila en `emails` y en `email_deliveries` |
| 11 | Recuperación por polling | Con la suscripción en pausa (§9), el correo aparece en ≤ 5 min con `reason: "POLL"` |
| 12 | Adjunto | Correo con un PDF pequeño: `email_attachments` guardado, descarga desde el portal (URL firmada) |

## 8. Medición de latencia

| Marca | Fuente |
|---|---|
| T0 envío | Hora del cliente de correo que envía |
| T1 en Gmail | `emails.received_at` (`internalDate` de Gmail) |
| T2 Pub/Sub | `message.publishTime` (Cloud Console, *View messages* no aplica a push; usar las métricas de la suscripción) ≈ T3 |
| T3 webhook | Hora del log `gmail.pubsub.received` |
| T4 worker | Hora del log `gmail.sync.started` (`reason: "PUBSUB"`) |
| T5 procesado | `emails.processed_at` |
| T6 entrega | `email_deliveries.created_at` |
| T7 portal | Observación en el navegador (refresco o «Actualizar») |

```sql
select e.subject, e.received_at,
       e.created_at - e.received_at   as ingest_delay,
       e.processed_at - e.received_at as processed_delay,
       d.created_at - e.received_at   as delivery_delay
from public.emails e join public.email_deliveries d on d.email_id = e.id
where e.subject like 'EMAILBOT-SMOKE-%' order by e.received_at desc;
```

Medir al menos 5 correos y anotar mediana y máximo de T6 − T1 y T7 − T1. No hay SLA: se registra el resultado real
(el polling acota el peor caso sin push en 5 min más la duración del sync).

## 9. Pruebas de fallos (después del despliegue, una a una y autorizadas)

| Prueba | Cómo | Esperado |
|---|---|---|
| Evento duplicado | *Seek* de la suscripción a un instante anterior (requiere `--retain-acked-messages`), o sync manual + polling sobre el mismo correo | Mismo job (`gmail-<buzón>-<historyId>`) o sync sin correos nuevos; ninguna fila duplicada |
| Reinicio del worker | Render → *Restart* del worker mientras llega un correo | El correo aparece tras el arranque (job reanudado o siguiente push / polling) |
| Renovación del watch | `update email_accounts set watch_expires_at = now() + interval '1 hour' where id = '<id>'` | En ≤ 60 min: `gmail.watch.renewed`, `watch_renewed_at` actualizado |
| Fallo de Pub/Sub | Poner la suscripción en modo *pull* (o borrarla) y enviar un correo | Llega por polling en ≤ 5 min; restaurar después |
| Gmail 429 / 5xx | No inducible con seguridad en producción | Cubierto por tests (cursor intacto, reintento con backoff); vigilar `gmail.sync.failed` con `transient: true` |
| OAuth revocado | Con una cuenta Gmail **de prueba**: revocar el acceso en la cuenta de Google | Cuenta `ERROR` (`last_error_code`), sin reintentos infinitos (`UnrecoverableError`); reconectar → `WATCH_ACCOUNT` |
| History gap | `update email_accounts set sync_cursor = '1' where id = '<id>'` (cursor fuera de la ventana) | `gmail.sync.history_gap` (log + auditoría) → `gmail.sync.recovery` → cursor nuevo, sin duplicados |
| Sync manual | Portal: clic en «Actualizar» con y sin correo nuevo | «Bandeja actualizada» / «No hay correos nuevos» |
| Portal 401 | Revocar las sesiones del customer desde el panel y pulsar «Actualizar» | Vuelta a `/portal/login?expired=1` |
| Portal 429 | Dos clics en < 30 s | «Espera unos segundos antes de volver a actualizar.» |
| Reinicio de Redis | **Solo** si el plan tiene persistencia y en ventana de mantenimiento | Tras el reinicio, `POLL_ACCOUNTS` y `RENEW_WATCHES` siguen ejecutándose (si no, reiniciar el worker) |

## 10. Observabilidad y alertas

Logs estructurados (sin tokens; buzón hasheado en el webhook):

| Evento | Dónde | Además en auditoría |
|---|---|---|
| `gmail.pubsub.received` / `gmail.pubsub.rejected` (`reason`: `invalid_oidc_token`, `invalid_token`, `malformed`, `unknown_mailbox`) | API | no |
| `gmail.sync.started` / `completed` / `failed` (`reason`, contadores, `durationMs`) | worker | no |
| `gmail.sync.history_gap` / `gmail.sync.recovery` (`truncated`) | worker | `history_gap` sí |
| `gmail.watch.created` / `renewed` / `failed` (`errorCode`) | worker | sí |
| `gmail.manual_sync.requested` / `rate_limited` | API | `requested` sí |

No existe `gmail.manual_sync.completed`: el fin de un sync manual es el `gmail.sync.completed` con
`reason: "PORTAL"` y el portal lo detecta con `GET /api/portal/sync`.

Condiciones que deberían alertar (sin plataforma nueva: Sentry existente, búsqueda de logs en Render, métricas de
Pub/Sub en Cloud Monitoring y estas consultas periódicas):

| Condición | Señal |
|---|---|
| Watch no renovado | `select count(*) from email_accounts where provider = 'GMAIL' and status = 'ACTIVE' and (watch_expires_at is null or watch_expires_at < now() + interval '12 hours')` > 0 |
| Fallo de watch | `watch_error_code is not null`; auditoría `gmail.watch.failed` |
| Autenticación de Pub/Sub | `gmail.pubsub.rejected` con `invalid_oidc_token` repetido; respuestas 401 en las métricas de la suscripción |
| Pushes sin entregar | Pub/Sub `subscription/oldest_unacked_message_age` > 10 min |
| Sync atascado / cuenta caída | `status = 'ACTIVE' and last_synced_at < now() - interval '15 minutes'`; `status = 'ERROR'` |
| 429 repetidos de Gmail | `gmail.sync.failed` con `transient: true` en ráfaga |
| History gap | auditoría `gmail.sync.history_gap`; `gmail.sync.recovery` con `truncated: true` (posible pérdida, ver §11) |
| Worker caído | Render (estado del servicio); `last_synced_at` de todas las cuentas sin avanzar |
| Cola atascada | Correos en `RECEIVED` / `PROCESSING` > 30 min (`processing_status`) |

## 11. Riesgos y limitaciones conocidas

| Nivel | Riesgo | Mitigación |
|---|---|---|
| CRITICAL | Desplegar API / worker V2 antes de las migraciones: leen tablas y columnas nuevas y fallan | Orden §5 (paso 1 primero) |
| CRITICAL | Portal sin schema `portal` expuesto: todos los endpoints del portal fallan | Paso 2 |
| HIGH | Exponer `portal` antes de crearlo deja sin Data API también a V1 | Paso 2 después del 1 |
| HIGH | Push a `main` publica la web V2 antes que la API V2 | Paso 3 |
| HIGH | OAuth en modo *Testing*: refresh tokens de 7 días | Verificar el estado de publicación (sin cambiar OAuth en esta fase) |
| MEDIUM | `GMAIL_PUBSUB_VERIFICATION_TOKEN` heredado en la API: todos los pushes con 401 | Verificar en el paso 0 |
| MEDIUM | Redis sin persistencia: un reinicio borra los *schedulers* (polling, renovación) hasta reiniciar el worker | Verificar el plan; reiniciar el worker tras cualquier pérdida de datos de Redis |
| MEDIUM | Sin push (Google Cloud o variables ausentes) | Funciona por polling (5 min): degradación, no caída |
| MEDIUM | Solape del worker V1 y V2 durante el deploy: un correo procesado por V1 en esa ventana no tiene bot ni entregas (no hay re-resolución) | Los bots y customers se configuran después del paso 5 |
| LOW | Recuperación de un *history gap* limitada a 7 días y 300 mensajes (los 300 más recientes de INBOX): un buzón sin sincronizar más de una semana, o con más de 300 correos en la ventana, puede perder los más antiguos | Solo tras una caída larga; alerta `truncated: true`. La ventana parte del último sync correcto menos 1 h, así que con polling cada 5 min el caso normal es de minutos |
| LOW | Un worker matado sin apagado limpio deja el lease hasta 15 min: syncs de esa cuenta aplazados | Apagado limpio en Render (`maxShutdownDelaySeconds: 120`) |
| LOW | El sync de seguimiento (`sync-<id>-next`) que choca con uno en curso reintenta unos 75 s y se descarta si este dura más | El siguiente push o el polling lo cubren (≤ 5 min) |
| LOW | Al desconectar una cuenta no se llama a `users.stop`: Gmail sigue notificando hasta 7 días | La API descarta los pushes de buzones sin cuenta ACTIVE (204, sin job) |
| LOW | Proyectos de GCP con prefijo de dominio (`example.com:proyecto`) no pasan la validación de `GMAIL_PUBSUB_TOPIC` | No aplica a proyectos nuevos |

## 12. Fase 6 (Super Admin): pendiente de despliegue

**No aplicado.** Requiere autorización explícita, igual que el resto del runbook. Detalle funcional en
[`v2-implementation.md`](v2-implementation.md#fase-6-super-admin).

Qué cambia en producción:

- Base de datos: 2 migraciones **aditivas**, `20261005120000_platform_admins` (tablas `platform_admins` y
  `platform_audit_logs`, vacías, con RLS y sin grants) y `20261005120100_admin_functions` (schema `admin` con 12
  funciones `SECURITY DEFINER` solo para `service_role`, e índice `audit_logs_created_idx`). Ningún dato existente
  cambia y ninguna política RLS existente cambia. Producción ya tiene datos reales: no se asume una base vacía.
- Data API: añadir `admin` a *Exposed schemas* (como `portal`).
- API y web: redeploy. El **worker no cambia** y no necesita redeploy.
- Variables de entorno: ninguna nueva.

| # | Paso | Verificación |
|---|---|---|
| 0 | Comprobaciones previas (solo lectura): `supabase migration list --linked` debe mostrar las 24 migraciones de `main`; ajustes de auto-deploy de API y web. Copia de seguridad (`supabase db dump`) fuera del repositorio | — |
| 1 | `supabase db push --linked --dry-run` (debe listar **exactamente** las 2 migraciones de la fase 6) → autorización → `supabase db push --linked` | 26 migraciones; *advisors* sin hallazgos nuevos; `has_function_privilege('anon', 'admin.platform_stats(uuid)', 'execute')` = false (ídem `authenticated`); el worker sigue sincronizando y el panel carga |
| 2 | Exponer `admin` en Data API → *Exposed schemas* (mantener `public`, `graphql_public`, `portal`) | Data API sin errores; `anon` no tiene `USAGE` en `admin` |
| 3 | ~~Merge de la rama de la fase 6 en `main`~~: ya hecho (`main` = `5f0d6f2`). Verificar qué commit tienen desplegado API y web (si la web tiene auto-deploy, ya puede servir la consola: sin `isPlatformAdmin` muestra «Acceso denegado») | — |
| 4 | Desplegar la **API** | `/health` 200; `GET /api/me` incluye `isPlatformAdmin: false`; `GET /api/admin/stats` → 403 `PLATFORM_ADMIN_REQUIRED` para un usuario normal |
| 5 | Desplegar la **web** | `/admin` muestra «Acceso denegado» a un usuario normal; el panel y el portal no cambian |
| 6 | Crear el primer administrador (SQL Editor, propietario de la base): `insert into public.platform_admins (user_id) select id from public.profiles where email = '<correo confirmado>';` | `isPlatformAdmin: true`; `/admin` carga; `/api/admin/stats` 200 |
| 7 | Smoke test de solo lectura en `/admin` (resumen, organizaciones, detalle, auditoría). Cambiar plan o estado de una organización real solo con autorización | Sin errores; ningún contenido de correos visible |

Orden y riesgos:

- Exponer `admin` **antes** de crearlo deja sin Data API a todo el proyecto: el paso 2 va después del 1.
- Si la API se despliega antes del paso 2, `/api/me` responde `isPlatformAdmin: false` (no rompe el panel) y
  `/api/admin/*` falla; el resto de la API no se ve afectado.
- Si la web sale antes que la API, la consola no aparece (sin `isPlatformAdmin`) y `/admin` muestra «Acceso
  denegado»: degradación sin efecto para los usuarios.

Rollback: las migraciones no se revierten (aditivas, el código anterior funciona sobre ellas). Se revierte el
código de API y web; para retirar el acceso al instante basta con borrar las filas de `platform_admins`. Quitar
`admin` de *Exposed schemas* es opcional (sin `USAGE` para `anon` ni `authenticated`, no expone nada).

## 13. Fase 7 (calidad y lanzamiento): pendiente de despliegue

**No aplicado.** Requiere autorización explícita. Detalle en
[`v2-implementation.md`](v2-implementation.md#fase-7-calidad-y-lanzamiento).

Qué cambia en producción:

- Base de datos: 3 migraciones **aditivas**: `20261005130000_legal_acceptances` (tabla `legal_acceptances` vacía,
  con RLS; trigger `AFTER INSERT` en `auth.users` que nunca bloquea un registro), `20261005130100_legal_reacceptance`
  (valor `reacceptance` en `source`; `SELECT` e `INSERT` de columnas para `service_role`) y
  `20261005130200_legal_signup_server_versions` (`private.current_legal_versions()` y el trigger de registro con las
  versiones del servidor). Ningún dato existente cambia. Variables de entorno: **ninguna nueva**.
- **Efecto visible**: con la API nueva, **todos los usuarios existentes** (no tienen fila) reciben 403
  `LEGAL_ACCEPTANCE_REQUIRED` en el panel hasta aceptar, y la web nueva les muestra «Términos y privacidad». Conviene
  avisarles. Los administradores de la plataforma también deben aceptar.
- API: namespace Socket.IO `/portal` en el endpoint `/realtime` existente; las entregas manuales publican una señal
  en Redis; `GET /api/me` incluye `legal` y nuevo `POST /api/me/legal-acceptance`; barrera legal en todas las rutas
  con sesión de usuario y en el Socket.IO del panel; `emailRetentionDays`, `emailNotificationsEnabled` y el canal `email` de
  `NOTIFY` salen del contrato.
- Worker: publica `portal.deliveries` (ids de clientes) tras cada correo entregado; solo notificaciones in-app (un
  trabajo `email` en cola se descarta, como antes).
- Web: política de privacidad y términos 2.0, casilla de aceptación obligatoria en el registro, pantalla de
  re-aceptación (`/legal/accept`), sin «Retención de correos» ni «Notificaciones por correo» en Ajustes, texto del
  dashboard sin «tiempo real», enlaces legales en el login del portal y realtime del portal.

| # | Paso | Verificación |
|---|---|---|
| 0 | Gates en la rama (`pnpm typecheck`, `lint`, `test`, `build`) y el E2E de aislamiento contra el Supabase local | Todo PASS |
| 1 | Revisión legal de `/privacy` y `/terms` por el titular (los textos describen el código, no sustituyen esa revisión) | Aprobados |
| 2 | Requisito: fase 6 aplicada (§12; 26 migraciones). `supabase db push --linked --dry-run` (debe listar **exactamente** `20261005130000_legal_acceptances`, `20261005130100_legal_reacceptance` y `20261005130200_legal_signup_server_versions`) → autorización → `supabase db push --linked` | 29 migraciones; `private.current_legal_versions()` = versiones de `CURRENT_LEGAL_VERSIONS`; *advisors* sin hallazgos nuevos; `has_table_privilege('authenticated', 'public.legal_acceptances', 'select')` = false (ídem `anon`); `service_role` solo `SELECT` + `INSERT` de columnas; un registro de prueba crea su perfil |
| 2b | Merge de `feat/emailbot-f7-quality-launch` en `main` + push, con el auto-deploy de la web desactivado si está activo | — |
| 3 | Desplegar la **API** primero (después del paso 2: sin la migración `/api/me` falla con `permission denied`) y, **sin pausa**, el paso 4: desde aquí un usuario sin aceptación recibe 403 `LEGAL_ACCEPTANCE_REQUIRED` y la web anterior no tiene pantalla para aceptar | `/health` 200; `GET /api/me` incluye `legal`; una ruta del panel sin aceptación → 403 `LEGAL_ACCEPTANCE_REQUIRED`; tras aceptar, el panel en tiempo real funciona; un WebSocket a `/portal` con otro `Origin` es rechazado |
| 4 | Desplegar la **web** inmediatamente después de la API | `/privacy` y `/terms` con «Versión 2.0 · Última actualización: 5 de octubre de 2026», titular y RUC; el registro no avanza sin la casilla; un registro nuevo crea 2 filas en `legal_acceptances`; un usuario existente ve `/legal/accept`, acepta y entra al panel (2 filas `reacceptance`); el login del portal enlaza ambos documentos |
| 5 | Desplegar el **worker** | Log de arranque normal; un correo entregado produce la señal (el portal abierto se refresca sin pulsar «Actualizar») |
| 6 | Google Cloud → pantalla de consentimiento OAuth: URL de la política (`https://emailbot.app/privacy`) y de los términos; si se pide la verificación de `gmail.readonly`, describir el portal (datos de Gmail mostrados a los clientes finales que configura la organización) | Pantalla actualizada |

Por qué la web va justo después de la API: la barrera legal de la API rechaza a los usuarios sin aceptación y solo la
web nueva les permite aceptar. Por qué la API va antes que el worker: una API anterior reenviaría `portal.deliveries` (ids de clientes de la propia
organización) a la sala de la organización, donde el panel lo ignora. No expone datos, pero el orden lo evita.

Rollback: revertir web, worker y API (en ese orden) al deploy anterior; al revertir la API desaparece la barrera legal.
Las migraciones no se revierten (aditivas; el código anterior no envía `legal_accepted`, el trigger no graba nada y
nadie usa los grants nuevos). Sin realtime, el portal sigue funcionando con «Actualizar».

## 14. Checklist de lanzamiento de V2

| Estado | Elemento |
|---|---|
| Hecho | V2 fases 0–5.7 en producción (migraciones, schema `portal`, Gmail push con OIDC; ver «Estado en producción» en `v2-implementation.md`) |
| Pendiente | Fase 6: migraciones `20261005120000` y `20261005120100`, schema `admin`, deploy de API y web, primer administrador (§12) |
| Pendiente | Fase 7: revisión legal, migraciones `20261005130000`, `20261005130100` y `20261005130200`, deploy API → web → worker, pantalla de consentimiento de Google (§13) |
| Pendiente | Datos legales: domicilio fiscal (`SERVICE_FISCAL_ADDRESS`, cuando SUNAT lo muestre) y región de Render en la política de privacidad |
| Decisión | Columna sin uso `organization_settings.email_retention_days` (se conserva; borrarla requiere una migración destructiva) |
| Pendiente | Smoke tests y medición de latencia del push en producción (§7, §8) si no se completaron al desplegar la 5.6 |
| Pendiente | Pruebas de fallos autorizadas (§9) y alertas (§10) |
| Pendiente | Borrar la suscripción *pull* por defecto `emailbot-gmail-sub` del topic, una vez confirmada la suscripción push |
| Decisión | Monetización (planes, límites por plan, pagos): fase posterior |
