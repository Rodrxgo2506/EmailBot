# Comercial V1 — planes, suscripción obligatoria, entitlements y límites

Rama `feat/commercial-plans-v1` (fases 1 y 1.1). **EmailBot es un servicio de pago**: no hay plan gratuito, ni
BÁSICO gratis, ni prueba gratuita, ni registro gratuito. El acceso comercial de una organización depende de una
**suscripción activa**:

```
organización → suscripción (ACTIVE, periodo vigente) → plan_price → plan_catalog → plan_entitlements
```

Fuera de alcance (fase 2 y siguientes): Culqi (SDK, checkout, tokenización, API, webhooks), cobro y renovación
automáticos, prorrateos, créditos, reembolsos, SUNAT / facturación electrónica, cupones, overage.

## Catálogo V1

| | BÁSICO (`BASIC`) | PRO (`PRO`, «Más elegido») | BUSINESS (`BUSINESS`) |
|---|---|---|---|
| Mensual (PEN) | 19.90 | 39.90 | 89.90 |
| Anual (PEN) | 199.00 | 399.00 | 899.00 |
| `EMAIL_ACCOUNTS` | 25 | 125 | 250 |
| `RULES` | 10 | 30 | 100 |
| `BOTS` | 2 | 10 | 50 |
| `MONTHLY_EMAILS` | 2 000 | 15 000 | 75 000 |
| `MEMBERS` | 2 | 5 | 20 |
| `CUSTOMERS` | 500 | 2 500 | 10 000 |
| `STORAGE_BYTES` | 1 GB | 5 GB | 25 GB |
| `RETENTION_DAYS` | 30 | 90 | 365 |
| `GMAIL` | sí | sí | sí |
| `MICROSOFT` | no | sí | sí |
| `ADVANCED_STATS` | no | sí | sí |
| `PORTAL` | no | sí | sí |
| `API` | no | no | sí |
| `PRIORITY_SUPPORT` | no (estándar) | sí | sí |

- **Los precios mostrados al cliente incluyen IGV** (decisión comercial). No hay lógica tributaria ni SUNAT todavía.
- `EMAIL_ACCOUNTS` subió de 2 / 5 / 20 a 25 / 125 / 250 con la migración `20261007120000_email_account_plan_limits`
  (solo esas tres filas de `plan_entitlements`; precios y demás límites sin cambios). Ningún buzón existente se
  toca: el límite solo se comprueba al agregar uno.
- 1 GB = 1024³ bytes. Los valores viven **solo en la base de datos** (sembrados por la migración); el código conoce
  las claves (`packages/types/src/plans.ts`) y lee los valores con `public.organization_entitlements()`.

## Modelo de datos

| Migración | Propósito |
|---|---|
| `20261006120000_organization_plan_basic.sql` | Añade `BASIC` al enum `organization_plan` (archivo propio: un valor nuevo no se puede usar en la transacción que lo crea). |
| `20261006120100_plan_catalog.sql` | `plan_catalog`, `plan_prices` (`numeric(10,2)` + `amount_cents`), `plan_entitlements`; FK `organizations_plan_in_catalog` NOT VALID; `organization_usage()`. |
| `20261006130000_subscriptions.sql` | Suscripción obligatoria: `subscriptions`, `payment_events`, núcleo `private.*`, funciones `admin.*`, `organizations.plan` pasa a ser caché (nullable, sin default, protegido por trigger), `organization_entitlements()` desde la suscripción. |
| `20261006140000_subscription_enforcement.sql` | Cierre (fase 1.2): `public.organization_access()` (única definición de acceso), portal condicionado al acceso, renovación anticipada sin hueco, expiración idempotente y concurrente, `public.expire_due_subscriptions()` para el scheduler del worker. |

- **`subscriptions`**: `organization_id`, `plan_price_id`, `status`, `payment_method`, `origin` (`ADMIN` / `CULQI`),
  `external_subscription_id` (para Culqi), `started_at`, `current_period_start`, `current_period_end`, `canceled_at`,
  `suspended_at`, `expired_at`, `created_by`, `created_at`, `updated_at`.
  - Índice único **parcial**: una sola suscripción abierta (`ACTIVE` / `PAST_DUE` / `SUSPENDED`) por organización;
    `CANCELED` / `EXPIRED` son historial (un `UNIQUE` simple impediría guardarlo).
  - Checks: periodo con fin posterior al inicio y de 2 años como máximo; cada `*_at` se rellena solo en su estado.
- **`payment_events`**: `external_event_id` **único** (idempotencia), `organization_id`, `subscription_id`,
  `event_type`, `payment_method`, `amount numeric(10,2)`, `currency`, `status` (`RECEIVED` / `PROCESSED` / `IGNORED` /
  `FAILED`), `metadata`, `occurred_at`, `processed_at`, `recorded_by`. Sobrevive a la organización (`SET NULL`).
- **Enums**: `subscription_status` (`ACTIVE`, `PAST_DUE`, `SUSPENDED`, `CANCELED`, `EXPIRED`), `payment_method`
  (`CULQI`, `YAPE`, `CASH`, `TRANSFER`, `MANUAL`), `subscription_origin` (`ADMIN`, `CULQI`).
- **`organizations.plan`**: se mantiene por compatibilidad como **caché** del plan de la suscripción `ACTIVE` (`NULL`
  = sin plan). Solo lo escribe `private.sync_organization_plan()`. El trigger `organizations_guard_plan` rechaza
  cualquier otro cambio, también del dueño de las tablas, así que no puede haber `subscription = PRO` con
  `organization.plan = BUSINESS`.
- **RLS**:
  - Los miembros leen las suscripciones de su organización, pero nadie escribe suscripciones ni pagos por la Data API.
  - `payment_events` no tiene acceso por Data API.
  - El service role solo tiene `SELECT` en `subscriptions` / `plan_prices` (lo usa el callback OAuth).

## Núcleo de suscripciones (único camino)

- **`private.activate_subscription(org, plan_price, método, origen, inicio, fin, importe, moneda, external_event_id,
  tipo de evento, actor, request_id, metadata)`**: la **única** vía para activar, renovar o cambiar el plan. Todo
  ocurre en una transacción:
  1. registra el `payment_event` primero; un `external_event_id` repetido devuelve `DUPLICATE` y no cambia nada;
  2. crea la suscripción (`ACTIVATED`) o actualiza la abierta: `RENEWED` (mismo precio) o `PLAN_CHANGED` (otro
     precio). Esto reactiva también una `SUSPENDED` / `PAST_DUE`;
  3. sincroniza la caché;
  4. marca el evento `PROCESSED`;
  5. audita en `platform_audit_logs`: `subscription.activated` / `renewed` / `plan_changed` y `payment.recorded`.
- **`private.change_subscription_status(sub, estado, actor, motivo, request_id)`**, con su máquina de estados:
  - `SUSPENDED` desde `ACTIVE` / `PAST_DUE`;
  - `ACTIVE` (reactivar) desde `SUSPENDED` / `PAST_DUE`, solo dentro del periodo pagado;
  - `PAST_DUE` desde `ACTIVE` (proveedor de pagos);
  - `CANCELED` desde cualquier estado abierto (terminal, acceso termina ya);
  - `EXPIRED` desde cualquier estado abierto, solo con el periodo terminado (terminal).
  - Nunca borra nada y audita cada cambio.
- **`private.expire_due_subscriptions()`**: marca `EXPIRED` las suscripciones abiertas con el periodo terminado.
  Es idempotente (una ya `EXPIRED` no se vuelve a tocar ni a auditar) y segura en paralelo
  (`FOR UPDATE SKIP LOCKED`). El worker la ejecuta **cada 5 minutos** a través de
  `public.expire_due_subscriptions()`: job `EXPIRE_SUBSCRIPTIONS` del scheduler de BullMQ ya existente, que es la
  única función `SECURITY DEFINER` de `public` ejecutable por el service role, sin parámetros. El acceso no depende
  de ella: termina en el instante `current_period_end`; la expiración actualiza el estado y la caché.
- **Renovación anticipada**: si la suscripción tiene acceso ahora y el periodo pagado empieza en el futuro (por
  ejemplo, al terminar el actual), el acceso continúa sin hueco: el periodo va desde el momento del registro hasta
  el nuevo fin. El inicio pedido queda en la auditoría. Una primera suscripción pagada por adelantado no da
  acceso hasta su inicio.
- **Cambio de plan** (BASIC ↔ PRO ↔ BUSINESS, mensual ↔ anual): actualiza el `plan_price` de la suscripción
  abierta, sin prorrateo, créditos, devoluciones ni cargos por diferencia.
- **Renovación**: cada suscripción conoce `current_period_start` / `current_period_end`. Una renovación es otra
  activación con el periodo siguiente (por ejemplo `2026-10-06 → 2026-11-06` y luego `2026-11-06 → 2026-12-06`).

## Acceso (entitlements)

`public.organization_entitlements(org)` devuelve el plan en caché, el plan efectivo, `access` y el estado de la
suscripción:

| `access` | Cuándo | Entitlements |
|---|---|---|
| `SUBSCRIPTION` | suscripción `ACTIVE` con `current_period_start` <= ahora < `current_period_end` | los del plan del `plan_price` |
| `LEGACY` | la organización **nunca** tuvo suscripción y tiene un plan anterior a esta fase | los de ese plan (`FREE` → `BASIC`) |
| `NONE` | todo lo demás: organización nueva, `PAST_DUE`, `SUSPENDED`, `CANCELED`, `EXPIRED`, periodo vencido | ninguno |

En el API (`apps/api/src/modules/plans/entitlements.ts`), sin acceso, toda acción comercial responde
`403 SUBSCRIPTION_REQUIRED`:
- crear o conectar cuentas (también en el callback OAuth: `reason=subscription_required`);
- reglas, bots, clientes y miembros;
- Access IDs del portal.

Con acceso se aplican los límites duros: `403 PLAN_LIMIT_REACHED` / `PLAN_FEATURE_UNAVAILABLE`.

| Acción | Comprobación |
|---|---|
| `POST /email-accounts/oauth/:provider/start` | suscripción; feature `GMAIL` / `MICROSOFT`; `EMAIL_ACCOUNTS` (salvo que pueda ser la re-autorización de un buzón que ya cuenta) |
| `GET /oauth/:provider/callback` | de nuevo suscripción y feature, antes de canjear el código; `EMAIL_ACCOUNTS` con la dirección real, **atómico** (ver abajo) |
| `POST /email-accounts/imap` | `EMAIL_ACCOUNTS` (IMAP sigue desactivado) |
| `POST /rules` | `RULES` |
| `POST /bots` (ACTIVE), `PATCH /bots/:id` (→ ACTIVE) | `BOTS` (bots activos) |
| `POST /customers` (ACTIVE), `PATCH /customers/:id` (→ ACTIVE) | `CUSTOMERS` (clientes activos) |
| `POST /organizations/current/members` | `MEMBERS` |
| `POST /customers/:id/access` | feature `PORTAL` |

Lo existente **nunca** se borra ni se oculta: los datos se leen, y las cuentas se pueden pausar y desconectar.

### Conexión OAuth de un buzón (`public.connect_oauth_email_account`)

El callback OAuth guarda el buzón solo con esta función (migración `20261007160000_email_account_oauth_connect`,
SECURITY DEFINER, `search_path = ''`, EXECUTE solo para `service_role`). En **una** transacción:

1. bloquea la fila de la organización (`FOR NO KEY UPDATE`): las conexiones simultáneas de una organización se
   serializan;
2. busca el buzón por (organización, proveedor, `lower(email)`) y lo bloquea;
3. si es nuevo o está `DISCONNECTED`, exige `usados + 1 <= límite` (usados = buzones con estado distinto de
   `DISCONNECTED`; límite = `EMAIL_ACCOUNTS` del plan efectivo, `NULL` = ilimitado, sin acceso comercial = 0).
   `ACTIVE` / `PAUSED` / `ERROR` se re-autorizan sin consumir cupo;
4. inserta o reutiliza la fila (nunca dos filas para la misma dirección).

Resultados: `CREATED`, `RECONNECTED`, `PLAN_LIMIT_REACHED` (`reason=plan_limit`) y `MISSING_REFRESH_TOKEN`
(`reason=missing_refresh_token`: el proveedor no devolvió refresh token y no hay uno guardado; no se escribe nada y
se puede reintentar). En la re-autorización: estado `ACTIVE`, access token nuevo, refresh token nuevo solo si llegó
(si no, se conserva), `last_error_*` a `NULL`. **Gmail en `ERROR` conserva su `sync_cursor`** (historyId): se
sincroniza lo recibido mientras la autorización estuvo rota; si el cursor caducó, el worker usa la recuperación de
history gap. Nuevo, `DISCONNECTED`, `ACTIVE`, `PAUSED` y Microsoft parten del cursor actual (como antes). El watch
se sigue encolando igual (`WATCH_ACCOUNT`).

Pruebas: `packages/database/test/email-account-connect.test.ts` (PGlite: decisiones, permisos, A/B, mayúsculas; PGlite
tiene una sola conexión, así que ahí las llamadas «simultáneas» se ejecutan en serie) y
`packages/database/scripts/connect-concurrency-check.sh`, que comprueba el bloqueo con sesiones **realmente
simultáneas** contra el PostgreSQL local de Supabase, en una base temporal que crea y borra, y con una función de
control sin bloqueo que sí supera el límite.

`GET /api/organizations/current/plan` (todos los roles) devuelve los entitlements, el uso y la suscripción actual. La
web lo muestra en Configuración («Plan y uso» / «Sin suscripción activa») y desactiva los botones de conexión sin
suscripción.

## Super Admin (pagos manuales)

| Ruta | Qué hace |
|---|---|
| `GET /api/admin/plan-prices` | precios activos del catálogo |
| `GET /api/admin/organizations/:id/subscription` | suscripciones (abierta + historial) y últimos 25 pagos |
| `POST /api/admin/organizations/:id/subscription/activate` | registra un pago manual y activa / renueva / cambia el plan |
| `POST /api/admin/subscriptions/:id/{suspend,reactivate,cancel,expire}` | cambios de estado (motivo opcional) |

**Activación** (`POST /api/admin/organizations/:id/subscription/activate`):
- Cuerpo: `{ plan, billingPeriod, paymentMethod: YAPE|CASH|TRANSFER|MANUAL, amount: "39.90", periodStart, periodEnd,
  reference?, note? }`.
- El importe va como texto decimal (nunca float) y es el importe realmente pagado: por defecto el de lista, editable.
- La referencia (n.º de operación) hace la operación idempotente: el mismo método + referencia responde
  `409 PAYMENT_ALREADY_RECORDED`.
- `CULQI` nunca es manual.

**Otras reglas del Super Admin:**
- Crear una organización ya no acepta plan: nace sin plan ni acceso.
- `PATCH /api/admin/organizations/:id` solo cambia el estado operativo (`organizations.status`), que es independiente
  de la suscripción.
- En la consola, la ficha de la organización tiene la tarjeta «Suscripción»: registrar pago, acciones, pagos e
  historial. Las fechas son días en hora de Lima.

## Organizaciones existentes (legado)

- Las organizaciones creadas antes de esta fase conservan su `plan` (`FREE`, `PRO`, …) y su acceso (`LEGACY`): el
  despliegue no cambia nada real.
- El enum conserva `FREE` (un valor no se puede borrar).
- `FREE` no está en el catálogo y no se puede asignar ni contratar.
- El Super Admin las migra registrando su primer pago. La auditoría `subscription.activated` guarda
  `previousOrganizationPlan` y, desde ese momento, el acceso depende solo de la suscripción.
- Cuando no quede ninguna `FREE`: `alter table public.organizations validate constraint organizations_plan_in_catalog;`.

## Registro y compra (preparado, no implementado)

**Hoy:**
- `/register` crea un usuario y `/onboarding` crea una organización **sin plan ni acceso**: no hay uso gratuito.
- El flujo manual ya funciona:
  1. el cliente se registra y crea su organización (o el Super Admin la crea con su correo);
  2. paga por Yape, efectivo o transferencia;
  3. el Super Admin registra el pago y activa la suscripción.

**Página de planes y «Mi plan» (implementado, sin cobro):**
- `GET /api/plans` (público, sin sesión, solo lectura, `Cache-Control: public, max-age=300`): planes, precios y
  entitlements **activos** del catálogo de la base. Es la única fuente de la web: no hay precios ni límites escritos
  en el frontend. Lo lee el service role, que ya tenía `SELECT` sobre las tres tablas del catálogo; no hubo
  migración.
- `/planes` (pública):
  - tarjetas de BÁSICO, PRO («Más elegido») y BUSINESS, con el precio mensual y el anual, IGV incluido;
  - tabla comparativa.
- Solo se muestra lo que existe: cuentas, correos/mes, reglas, bots, clientes, miembros, almacenamiento, Gmail,
  Microsoft y Portal. `RETENTION_DAYS`, `ADVANCED_STATS`, `API` y `PRIORITY_SUPPORT` no se ofrecen (ver
  «Pendiente»).
- Botones de `/planes` según quién visita:
  - anónimo → «Crear cuenta» (`/register` existente);
  - con sesión → el plan efectivo aparece como «Plan actual» (deshabilitado; una organización FREE heredada se
    reconoce como BÁSICO);
  - los planes inferiores al actual → «Incluido en tu plan»;
  - los superiores → «Mejorar a …»;
  - sin suscripción → «Elegir …».
- Configuración → sección «Mi plan»:
  - la tarjeta de plan existente (uso real medido por `organization_usage` y funcionalidades);
  - «Mejorar plan», con los planes superiores y lo que cada uno añade;
  - en BUSINESS: «Actualmente tienes el plan más completo».
- **Elegir o mejorar un plan solo abre el aviso «Contratación en línea próximamente»**, con el contacto. No hay cobro,
  activación, suscripción ni registro de pago. El Super Admin sigue activando los planes como hasta ahora.
- Fase 2: la única acción a sustituir es la del botón «Elegir / Mejorar» (`PlanCta` `CHOOSE` en
  `apps/web/src/features/plans/plans-model.ts`), que pasará del aviso al checkout.

**Flujo objetivo con Culqi (fase 2):**
1. `/planes` → `/checkout?plan=PRO&period=MONTHLY`.
2. Pago confirmado por webhook.
3. `/register?purchase=…` → crear la cuenta y la organización.
4. `private.activate_subscription(..., origin CULQI, external_event_id = id del evento de Culqi)`.

No hay endpoints de pago simulado.

## Bloqueo sin suscripción (fase 1.2)

Una sola definición, `public.organization_access(org_ids[])` (SECURITY INVOKER), usada por el API (vía
`organization_entitlements`), el worker (service role) y el portal. Sin acceso no hay procesamiento comercial, y
**nada se borra ni se desconecta**: cuentas, cursores, correos, reglas, bots, clientes, Access IDs y sesiones se
conservan; al recuperar el acceso todo continúa desde donde quedó.

**Worker** (`apps/worker/src/pipeline/commercial-access.ts`):
- El acceso se comprueba en la base **en el momento de ejecutar**, no al encolar. Un job creado con acceso y
  ejecutado después de perderlo se omite: termina como completado, sin reintentos.
- Cobertura:
  - `syncAccount`: todas las sincronizaciones (push de Gmail, Graph, polling, manual, portal, continuación). No lista
    mensajes ni toma el lock, y el cursor no se mueve.
  - `processEmail`: cada mensaje, también los jobs de reanudación. Responde `skipped / subscription_inactive`
    antes de descargar nada; no se ejecutan reglas, bots, entregas, adjuntos ni notificaciones.
  - `GMAIL_NOTIFICATION`, `MICROSOFT_NOTIFICATION`, `MICROSOFT_LIFECYCLE`: se ignoran sin acceso.
  - `POLL_ACCOUNTS`, `RENEW_WATCHES`, `RECOVER_INCOMPLETE`: filtran por acceso con una consulta por lote. Un correo
    incompleto sin acceso no se reencola ni consume intentos.
  - `WATCH_ACCOUNT`: sin acceso no se crea ni se renueva el watch de Gmail / la suscripción de Graph.
  - Notificaciones de reglas ya encoladas: no se entregan.
- **Watches remotos**: no se borran. Sin renovación caducan solos (Gmail, 7 días; Graph, unas 70 h), y mientras
  tanto sus avisos se ignoran. Al recuperar el acceso, `RENEW_WATCHES` (cada hora) los recrea y el polling cubre el
  intervalo. Consecuencia: unos días de avisos de Google / Microsoft que se descartan, sin coste de procesamiento.
- **Fallos**:
  - Una organización sin respuesta de la base se trata como sin acceso.
  - Un error al consultar se lanza y el job se reintenta con backoff; nunca se interpreta como acceso.
- **Log**: `subscription.access_denied` con `organizationId`, `subscriptionStatus`, `operation`, `reason` y, si
  aplica, `emailAccountId`, `provider` y `jobType`. Nunca direcciones, tokens ni contenido. `subscription.expired`
  registra cuántas expiraron.

**Portal**:
- `private.portal_session_scope` y `portal.create_session` exigen acceso: `LEGACY` (sin cambios) o una suscripción
  `ACTIVE` cuyo plan incluya `PORTAL`.
- Esto cubre todas las funciones de datos, la validación de sesión, la sincronización del portal y el realtime.
- El login responde el mismo 401 genérico, auditado como `SUBSCRIPTION_INACTIVE`.
- Las sesiones abiertas dejan de funcionar y vuelven a funcionar al recuperar el acceso.
- Bajar de PRO a BÁSICO cierra el portal (BÁSICO no incluye `PORTAL`).

**API**:
- La sincronización manual también responde `403 SUBSCRIPTION_REQUIRED`.
- Cada rechazo se registra como `subscription.access_denied`, con la operación `MÉTODO /ruta`.

## Pendiente (identificado)

- **Renovación automática**: con Culqi (fase 2).
- **Métricas**: no hay sistema de métricas en el proyecto; los eventos están en los logs estructurados (aptos para
  alertas basadas en logs más adelante).
- **`PAST_DUE`**: hoy no da acceso (solo `ACTIVE` lo da). Hay que decidir si habrá periodo de gracia.
- **`CANCELED`**: termina el acceso al instante. Hay que decidir si hará falta «cancelar al final del periodo».
- **`MONTHLY_EMAILS` / `STORAGE_BYTES`**: se miden y se muestran, pero no se aplican. Puntos de aplicación: en el
  worker, al empezar cada sincronización y antes de subir adjuntos.
- **`RETENTION_DAYS`**: no hay purga. La web no la muestra.
- **`ADVANCED_STATS`, `API`, `PRIORITY_SUPPORT`**: sin producto detrás. La web no los muestra.
- **Microsoft al bajar a BÁSICO**: un buzón Microsoft ya conectado sigue sincronizando mientras haya suscripción (el
  portal sí se cierra; ver arriba).
- **Concurrencia**: `EMAIL_ACCOUNTS` en la conexión OAuth es atómico (ver arriba). Los demás límites se comprueban
  antes de crear; dos peticiones simultáneas pueden superarlos en una unidad.
- **Legal**: los Términos / la Privacidad no tienen todavía las condiciones de contratación, reembolsos, el Libro de
  Reclamaciones ni Culqi como encargado de pagos.

## Despliegue (cuando se autorice)

1. **Migraciones en producción** (`20261006120000`, `20261006120100`, `20261006130000`, `20261006140000`), **antes
   que el API y el worker**: ambos usan las funciones nuevas. Entre la migración y el despliegue, la consola admin
   antigua no puede crear organizaciones con plan ni cambiar el plan (la base lo rechaza); el resto sigue
   funcionando.
2. **API**, **worker** (registra el job `EXPIRE_SUBSCRIPTIONS` al arrancar), luego **web**.
3. **Comprobar**: las organizaciones existentes siguen con `access = LEGACY` y su plan; `GET /api/organizations/current/plan`.

## Rollback (manual)

```sql
-- 20261006140000: restaurar organization_entitlements, private.portal_session_scope, portal.create_session,
-- private.activate_subscription y private.expire_due_subscriptions desde sus migraciones anteriores, y:
drop function if exists public.expire_due_subscriptions();
drop function if exists private.portal_access_allowed(uuid);
drop function if exists public.organization_access(uuid[]);
-- 20261006130000
drop function if exists admin.update_subscription_status(uuid, uuid, text, text, text);
drop function if exists admin.activate_subscription(uuid, uuid, public.organization_plan, public.billing_period, public.payment_method, numeric, timestamptz, timestamptz, text, text, text);
drop function if exists admin.list_payment_events(uuid, uuid, integer);
drop function if exists admin.list_subscriptions(uuid, uuid);
drop function if exists admin.list_plan_prices(uuid);
drop function if exists private.expire_due_subscriptions(timestamptz);
drop function if exists private.change_subscription_status(uuid, public.subscription_status, uuid, text, text, timestamptz);
drop function if exists private.activate_subscription(uuid, uuid, public.payment_method, public.subscription_origin, timestamptz, timestamptz, numeric, text, text, text, uuid, text, jsonb);
drop trigger if exists organizations_guard_plan on public.organizations;
drop function if exists private.sync_organization_plan(uuid);
drop function if exists private.guard_organization_plan();
drop table if exists public.payment_events, public.subscriptions;
drop type if exists public.subscription_origin;
drop type if exists public.payment_method;
drop type if exists public.subscription_status;
-- organizations.plan sin valor: asignar uno antes de volver a NOT NULL.
-- 20261006120100
drop function if exists public.organization_usage(uuid, text[]);
drop function if exists public.organization_entitlements(uuid);
alter table public.organizations drop constraint if exists organizations_plan_in_catalog;
revoke select (plan) on table public.organizations from service_role;
revoke select on table public.plan_prices from service_role;
drop table if exists public.plan_entitlements, public.plan_prices, public.plan_catalog;
drop type if exists public.plan_entitlement_kind;
drop type if exists public.billing_period;
-- Restaurar default 'FREE', NOT NULL y admin.create_organization / update_organization desde 20261005120100.
-- El valor BASIC del enum no se puede quitar: es inofensivo.
```
