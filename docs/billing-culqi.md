# Billing con Culqi — suscripciones recurrentes (Comercial V1, fase 2)

> **Esta implementación está limitada al ambiente de integración/sandbox y no está habilitada para cobros reales.**
> La API y el worker rechazan llaves `sk_live_` / `pk_live_` al arrancar. Producción no tiene llaves de Culqi
> configuradas, así que `/api/billing/*` responde «no configurado» y la web mantiene el aviso «Próximamente».

Rama `feat/culqi-subscriptions-sandbox`. Se apoya en el núcleo comercial existente
([commercial-plans.md](commercial-plans.md)): **`public.subscriptions` sigue siendo la única fuente del acceso**.
Culqi es solo el proveedor de cobro.

## Fuentes verificadas

Todo nombre de endpoint, campo, estado o evento sale de la documentación oficial de Culqi (consultada el 2026-10-07):

| Qué | Fuente |
|---|---|
| Endpoints, cuerpos, estados, eventos | Especificación OpenAPI oficial, `https://apidocs.culqi.com/apiculqi.yaml` (API v2) |
| Flujo de suscripciones | `https://docs.culqi.com/es/documentacion/pagos-online/recurrencia/suscripciones/` |
| Checkout | `https://docs.culqi.com/es/documentacion/checkout/checkout-custom` (Culqi Custom Checkout; no se usa Checkout V4) |
| Dominios del checkout (CSP) | Script oficial `https://js.culqi.com/checkout-js` (monta su iframe desde `https://checkoutview.culqi.com`) |

Endpoints usados (base `https://api.culqi.com`, `Authorization: Bearer <llave secreta>`):

| Operación | Endpoint |
|---|---|
| Crear cliente | `POST /v2/customers` (`first_name`, `last_name`, `email`, `address`, `address_city`, `country_code`, `phone_number`) |
| Buscar cliente por email | `GET /v2/customers?email=` |
| Crear tarjeta | `POST /v2/cards` (`customer_id`, `token_id`); `200` + `action_code: REVIEW` = requiere 3DS |
| Crear / consultar plan | `POST /v2/recurrent/plans/create`, `GET /v2/recurrent/plans/{id}` |
| Crear suscripción | `POST /v2/recurrent/subscriptions/create` (`card_id`, `plan_id`, `tyc`, `metadata`) |
| Consultar / cancelar suscripción | `GET` / `DELETE /v2/recurrent/subscriptions/{id}` |
| Consultar evento | `GET /v2/events/{id}` («el ID del evento que te enviamos a través del Webhook») |

## Arquitectura

```
Navegador                         API                                 Culqi                 Worker
─────────                         ───                                 ─────                 ──────
/planes o Mi plan ─ plan+periodo ─► GET /api/billing/checkout
                                   precio = catálogo EmailBot
                                   + llave PÚBLICA
Culqi Custom Checkout ── tarjeta ─────────────────────────────────► token (tkn_test_…)
token + plan + periodo + T&C ────► POST /api/billing/subscriptions
                                   verifica plan Culqi = precio ─────► GET plan
                                   cliente (1 por organización) ────► POST customers
                                   fila PENDING (billing_subscriptions)
                                   tarjeta ─────────────────────────► POST cards
                                   suscripción ─────────────────────► POST subscriptions/create
                                   202 PENDING; encola CULQI_RECONCILE ───────────────────────► reintenta hasta confirmar
                                                                      cobro asíncrono
                                   POST /webhooks/culqi ◄──────────── evento (solo se usa su id)
                                   registra evento, encola CULQI_EVENT ───────────────────────► GET evento + GET suscripción
                                                                                               → activación idempotente
                                                                                                 (private.activate_subscription,
                                                                                                  origen CULQI)
```

- El navegador **nunca** decide el precio: envía `plan`, `billingPeriod`, `tokenId`, `acceptTerms`, `customer`. El
  esquema es estricto: `amount`, `currency`, `limits`, datos de tarjeta, etc. → `400`.
- La API **no activa** nada. El acceso cambia solo cuando el worker confirma el pago.
- EmailBot nunca recibe ni guarda número de tarjeta, CVV ni PAN: Culqi tokeniza en su iframe y guarda la tarjeta.

## Modelo de datos (migración `20261007130000_culqi_billing_sandbox.sql`)

| Tabla | Para qué | Claves |
|---|---|---|
| `billing_provider_plans` | Precio EmailBot (`plan_prices`) → plan de Culqi, por entorno | `unique(plan_price_id, provider, environment)`; `external_plan_id` único |
| `billing_customers` | Cliente de Culqi de cada organización, por entorno | `unique(organization_id, provider, environment)` |
| `billing_subscriptions` | Cada suscripción de Culqi (intento de checkout) | `external_subscription_id` único; **un `PENDING` por organización** |
| `billing_webhook_events` | Eventos recibidos (idempotencia) | `unique(provider, external_event_id)`; **sin payload** |
| `payment_events` (existente) | + `external_payment_id` (cargo), `payment_status` (`SUCCEEDED` / `FAILED`), `failure_*` | `external_event_id` único |

- Los ids tienen el formato de Culqi y deben ser del mismo entorno que la fila (`cus_test_…` en una fila `test`): un
  id `live` nunca entra en una fila de prueba.
- RLS: ningún miembro accede por la Data API. `service_role` (API + worker): `SELECT / INSERT / UPDATE`, nunca `DELETE`.
- Lo que toca `subscriptions`, `payment_events` o `platform_audit_logs` pasa por tres funciones `SECURITY DEFINER`
  (solo `service_role`):
  - `billing_activate_culqi_subscription`;
  - `billing_record_culqi_charge_failure`;
  - `billing_set_culqi_status`.

## Estados

`billing_subscriptions.status` (lado proveedor; **no** da acceso por sí mismo):

| Estado | Significado | Acceso EmailBot |
|---|---|---|
| `PENDING` | Suscripción creada en Culqi, cobro no confirmado | sin cambio (no se concede el plan nuevo) |
| `ACTIVE` | Pago confirmado | plan activado vía `private.activate_subscription` |
| `PAST_DUE` | Renovación rechazada / en reintento | sin cambio: el periodo pagado sigue; expira al final si no se cobra |
| `FAILED` | Primer cobro rechazado o suscripción no creada | sin plan |
| `CANCELED` | Cancelada (motivo `USER`, `PROVIDER` o `UPGRADED`) | sin cambio inmediato: el periodo pagado se respeta |
| `EXPIRED` | Vencida en Culqi | sin cambio inmediato: expira al final del periodo |

Transiciones permitidas (BD): `PENDING → FAILED / CANCELED / EXPIRED`, `FAILED → CANCELED / EXPIRED`,
`ACTIVE → PAST_DUE / CANCELED / EXPIRED`, `PAST_DUE → CANCELED / EXPIRED`. `ACTIVE` solo por pago confirmado
(también desde `FAILED` / `PAST_DUE` si un reintento se cobra). `CANCELED` / `EXPIRED` son terminales: un evento
tardío no las revive.

Mapper Culqi → EmailBot (`mapCulqiSubscriptionStatus`, `packages/shared/src/culqi.ts`). Los códigos de estado de
Culqi vienen de la especificación: 1 Creada, 2 Periodo de prueba, 3 Activa, 4 Cancelada, 5 En cola, 6 Vencida.

| Culqi | EmailBot |
|---|---|
| 1 Creada, 2 Prueba | `PENDING` |
| 3 Activa | `ACTIVE` (vía activación) |
| 5 En cola | `PAST_DUE` si ya estaba activa; si no, `PENDING` |
| 4 Cancelada | `CANCELED` (`PROVIDER`, salvo que ya tuviera otro motivo) |
| 6 Vencida | `EXPIRED` |
| otro | sin cambio (se registra) |

Casos cubiertos:

| Caso | Qué pasa |
|---|---|
| Pago inicial aprobado | `ACTIVATED` |
| Pago inicial rechazado | `FAILED` + `payment_events` `FAILED` |
| Renovación aprobada | `RENEWED`, se extiende el periodo |
| Renovación fallida | `PAST_DUE` |
| Culqi cancela tras reintentos | `CANCELED` (`PROVIDER`) o `EXPIRED` |
| Cancelación del usuario | `CANCELED` (`USER`); se representa, pero no hay botón en esta fase |

## Mapping EmailBot ↔ Culqi

EmailBot es la fuente de nombre, precio, moneda, límites y funcionalidades. Culqi solo guarda una copia del precio
para poder cobrar. Por eso los planes de Culqi se crean **desde** el catálogo:

```bash
pnpm --filter @emailbot/api culqi:sync-plans
```

```bash
pnpm --filter @emailbot/api culqi:sync-plans --apply
```

- Sin `--apply` es solo dry-run.
- Por cada precio activo (BÁSICO / PRO / BUSINESS × mensual / anual):
  - crea el plan con `amount` en céntimos, `currency` `PEN`, `interval_unit_time` (3 mensual, 4 anual) e `interval_count: 0`;
  - guarda el id en `billing_provider_plans`.
- Si el mapeo ya existe, verifica el plan contra el catálogo.
- Se niega a escribir en una BD no local salvo con `--allow-remote-database`.
- Solo usa llaves `sk_test_`.

En cada checkout, la API vuelve a leer el plan de Culqi y rechaza (`503 BILLING_PLAN_MISMATCH`) si el importe, la
moneda o el intervalo no coinciden con el catálogo. Los ids de plan nunca llegan al navegador.

## Checkout

1. «Elegir / Mejorar» → `GET /api/billing/config`. Si no está habilitado → aviso «Próximamente» (comportamiento actual).
2. Diálogo:
   - periodicidad, con precios del catálogo;
   - datos de contacto que Culqi exige para crear el cliente (no se guardan en EmailBot);
   - aceptación explícita de Términos y renovación automática (`tyc: true`);
   - aviso visible «Entorno de pruebas: no se realizan cobros reales».
3. `GET /api/billing/checkout`:
   - valida organización, permiso (`organization:update`), plan, precio, mapeo y regla de upgrade;
   - devuelve la llave **pública** y el importe en céntimos.
4. `CulqiCheckout`:
   - solo `tarjeta`;
   - tokeniza en `checkoutview.culqi.com`;
   - el callback entrega `Culqi.token.id`.
5. `POST /api/billing/subscriptions` → `202 PENDING`. El diálogo consulta `GET /api/billing/subscriptions/current` cada
   3 s hasta `ACTIVE` o `FAILED`.

Reglas (`apps/api/src/modules/billing/policy.ts`):
- sin acceso comercial → cualquier plan;
- **upgrade** BÁSICO → PRO / BUSINESS y PRO → BUSINESS;
- mismo plan solo para pasar a tarjeta un plan heredado o pagado a mano;
- **sin downgrade** (`409`);
- un checkout a la vez (`409 CHECKOUT_IN_PROGRESS`, también garantizado por índice único).

Errores:

| Código | Causa |
|---|---|
| `402 PAYMENT_DECLINED` | Culqi rechazó la tarjeta o los datos; el checkout queda `FAILED` |
| `422 THREE_DS_REQUIRED` | La tarjeta pide 3DS, no implementado |
| `502 PAYMENT_PROVIDER_ERROR` | Culqi no responde |

**Upgrade.** Culqi no permite cambiar el plan de una suscripción: `PATCH` solo modifica la metadata. Por eso un upgrade
funciona así:
1. Se crea una suscripción nueva.
2. Al confirmarse su pago se activa el plan nuevo (`PLAN_CHANGED`).
3. Las suscripciones anteriores de la organización se marcan `CANCELED (UPGRADED)`.
4. El worker las cancela en Culqi (`DELETE`, reintentado hasta confirmarlo).

**No hay prorrateo:** el cliente paga el plan nuevo completo y pierde el resto del periodo anterior. Es una decisión
comercial pendiente.

## Webhook

`POST /webhooks/culqi` (fuera de `/api`, como los webhooks de Gmail y Microsoft):

1. Si Culqi no está configurado → `404`.
2. Token opcional en la URL (`?token=` = `CULQI_WEBHOOK_TOKEN`, comparación en tiempo constante).
3. Cuerpo: solo se exige `id` con formato `evt_(test|live)_…`. Malformado → `400`. Evento de otro entorno → `200`
   sin registrar.
4. Registra el evento una vez (`billing_webhook_events`).
   - Ya `PROCESSED` o `IGNORED` → `200 duplicate`.
   - Si no → encola `CULQI_EVENT` (job id determinista) y responde `200`.
   - Cola caída → `503`, para que Culqi reintente.

**Autenticación.** La documentación de Culqi no describe ninguna firma del webhook. Por eso **no se confía en el cuerpo**:
- el worker lee de nuevo el evento con la llave secreta (`GET /v2/events/{id}`);
- un id falso no existe en Culqi y el evento queda `IGNORED` (`NOT_FOUND_AT_CULQI`);
- además, lee de nuevo la suscripción (`GET /v2/recurrent/subscriptions/{id}`) y aplica su estado **actual**.

El token en la URL es una defensa adicional contra tráfico basura (lo configuramos nosotros en la URL; no depende de
una función de Culqi).

**Procesamiento** (`apps/worker/src/pipeline/billing.ts`):
- Eventos manejados, con los nombres de la lista oficial:
  - `subscription.creation.succeeded` / `.failed`;
  - `subscription.charge.succeeded` / `.failed`;
  - `subscription.cancel.succeeded`;
  - `charge.creation.succeeded` / `.failed`.
- El resto → `IGNORED`.
- Como Culqi no documenta la forma de `data` en cada evento, se buscan los ids con los prefijos documentados (`sxn_`,
  `chr_`) en `data`, también si llega como texto JSON.
- Eventos sin suscripción o de suscripciones que EmailBot no creó → `IGNORED`.

**Idempotencia y orden:**
- **Clave de activación** = (suscripción de Culqi, ciclo), con el ciclo identificado por `next_billing_date`. El webhook
  y la reconciliación del mismo ciclo producen la misma clave y se aplican una sola vez (`DUPLICATE`).
- **Confirmación tardía de un ciclo anterior** → `ALREADY_COVERED`: nunca acorta el periodo.
- **Evento de una suscripción reemplazada o cancelada** → `IGNORED`: nunca baja el plan.
- **Cargos rechazados**: idempotentes por id de evento.
- **Errores**: el evento queda `FAILED` y el job se reintenta. Un reenvío de Culqi tras agotar los reintentos crea un job
  nuevo.

**Reconciliación (`CULQI_RECONCILE`).**
- Tras cada checkout, el worker vuelve a leer la suscripción a los 20 s y después con backoff exponencial (unas 2 h).
  Mientras siga en estado 1 o 5 sin fallo, reintenta.
- Así el sandbox funciona aunque Culqi no pueda llamar al webhook (por ejemplo, en local).

**Periodo.**
- El periodo de EmailBot termina en el `next_billing_date` de Culqi + 3 días de gracia
  (`CULQI_RENEWAL_GRACE_MS`), porque Culqi cobra las suscripciones en un lote diario.
- Si falta esa fecha: un intervalo del plan + gracia.
- **Política provisional**, pendiente de decisión.

## Variables de entorno

| Variable | Dónde | Notas |
|---|---|---|
| `CULQI_SECRET_KEY` | API y worker | solo `sk_test_` en esta fase; nunca en `VITE_*` |
| `CULQI_PUBLIC_KEY` | API | solo `pk_test_`; la API la entrega al navegador en `GET /api/billing/checkout` (sin variable `VITE_*` ni rebuild) |
| `CULQI_API_URL` | API y worker | opcional (por defecto `https://api.culqi.com`) |
| `CULQI_WEBHOOK_TOKEN` | API | opcional, 32+ caracteres; añadir `?token=…` a la URL del webhook en CulqiPanel |

Las dos llaves de la API van juntas o ninguna. Una llave `live` impide arrancar. Los mensajes de error nunca muestran
la llave.

## CSP de la web

`apps/web/src/lib/csp.ts` añade exactamente:
- `script-src https://js.culqi.com`;
- `frame-src https://checkoutview.culqi.com`, el único origen que aparece en el script oficial.

Nada en `connect-src`: la tarjeta y el token viajan dentro del iframe de Culqi. Sin comodines.

## Configurar el sandbox de Culqi (paso a paso)

1. Crear cuenta de integración en `https://integ-panel.culqi.com` y copiar las llaves de **integración**
   (`pk_test_…`, `sk_test_…`). Nunca las de producción.
2. En el `.env` local (raíz):
   - `CULQI_SECRET_KEY=sk_test_…`
   - `CULQI_PUBLIC_KEY=pk_test_…`
   - opcional: `CULQI_WEBHOOK_TOKEN=<32+ caracteres aleatorios>`.

   No configurar nada de esto en Render en esta fase.
3. Aplicar la migración **en la BD local**:

   ```bash
   supabase migration up
   ```
4. Crear los 6 planes en Culqi sandbox y su mapeo: primero `pnpm --filter @emailbot/api culqi:sync-plans` (dry-run) y
   después con `--apply`. Comprobar en CulqiPanel (integración) → Planes.
5. Levantar API, worker y web (`pnpm dev`). En Configuración → Mi plan → «Mejorar a …» se abre el checkout con el aviso
   de pruebas.
6. Usar una [tarjeta de prueba de Culqi](https://docs.culqi.com/es/documentacion/pagos-online/tarjetas-de-prueba/).
7. Confirmación:
   - **Sin webhook** (local): la reconciliación consulta la suscripción y activa el plan cuando Culqi la marca Activa.
   - **Con webhook**: requiere una URL pública HTTPS hacia la API (túnel o entorno de pruebas aprobado).
     1. En CulqiPanel → Eventos → Webhooks → «+Añadir», usar `https://<api-de-pruebas>/webhooks/culqi?token=<CULQI_WEBHOOK_TOKEN>`.
     2. Suscribir los eventos `subscription.creation.succeeded`, `subscription.creation.failed`,
        `subscription.charge.succeeded`, `subscription.charge.failed`, `subscription.cancel.succeeded`,
        `charge.creation.succeeded` y `charge.creation.failed`.
8. Verificar en la BD local:
   - `billing_subscriptions` en `ACTIVE`;
   - `subscriptions` con `origin = CULQI`;
   - `payment_events` con `payment_status = SUCCEEDED`;
   - `organizations.plan` actualizado.

## Puntos a confirmar en el sandbox (no documentados por Culqi)

| Duda | Dónde impacta | Cómo se mitigó |
|---|---|---|
| Autenticación del webhook (firma, usuario/clave) | `/webhooks/culqi` | No se confía en el cuerpo: se vuelve a leer el evento con la llave secreta; token opcional en la URL |
| Forma de `data` por tipo de evento | Worker | Búsqueda de ids por prefijo documentado y relectura de la suscripción |
| Si el estado 3 «Activa» implica primer cobro hecho | Activación por reconciliación | Por webhook, `subscription.charge.succeeded` verificado también activa. Revisar el primer cobro en sandbox |
| Semántica de `interval_count` («si envía 0 se cobrará de forma indefinida») | Planes | Se envía 0. Confirmar en el plan creado (`GET`) y en la primera renovación |
| Unidades de `next_billing_date` (los ejemplos mezclan segundos y ms) | Periodo | Se aceptan ambos |
| Respuesta al crear un cliente con email repetido | Checkout | Si Culqi lo rechaza, se busca el cliente por email y se reutiliza |
| Si las tarjetas de prueba piden 3DS (`action_code: REVIEW`) | Checkout | Se responde `THREE_DS_REQUIRED`. Culqi3DS no está integrado |
| Si el checkout llama al callback al cerrar sin pagar | Web | El diálogo de EmailBot permite cancelar; hay que probarlo |
| Cuándo cobra Culqi exactamente (lote diario) | Gracia de 3 días | Política provisional |

## Cómo ejecutar las pruebas

Comandos de validación generales:

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

```bash
pnpm build
```

Específicas de billing:

| Ámbito | Archivo |
|---|---|
| BD (PGlite) | `packages/database/test/billing.test.ts`, `service-role-privileges.test.ts` |
| Cliente Culqi y mapper | `packages/shared/src/culqi.test.ts` |
| Validación | `packages/validation/src/billing.test.ts` |
| API | `apps/api/src/test/billing.test.ts`, `culqi-plans.test.ts` |
| Worker | `apps/worker/src/test/billing.test.ts`, `config.test.ts` |
| Web | `apps/web/src/features/billing/*.test.ts(x)`, `lib/csp.test.ts` |

Ninguna prueba llama a Culqi: se usan fakes con las respuestas documentadas.

E2E (`apps/api/e2e/isolation.e2e.ts`, stack local) verifica que, sin llaves:
- el checkout está desactivado;
- `/webhooks/culqi` no existe;
- las tablas `billing_*` son inaccesibles por la Data API.

## Qué falta para producción

Todo lo siguiente está **pendiente** y requiere aprobación explícita:

- **Llaves y entorno:**
  - Llaves live: requieren quitar el bloqueo `CULQI_ALLOWED_ENVIRONMENTS` en el código y revisar todo lo de este documento.
  - Prueba completa en sandbox de punta a punta, incluido el webhook real y los puntos a confirmar.
  - Webhook live en CulqiPanel, URL pública y token.
  - Planes live (`culqi:sync-plans` contra producción, con aprobación).
- **Producción:** aplicar la migración en producción (dry-run y backup como en fases anteriores) y desplegar API, worker
  y web.
- **Funcionalidad:**
  - 3-D Secure (Culqi3DS).
  - Cancelación por el usuario desde la UI (endpoint + `DELETE` en Culqi; el estado `USER` ya existe).
  - Downgrade.
- **Políticas comerciales:**
  - prorrateo / crédito en upgrades;
  - gracia de `PAST_DUE` y qué pasa con el acceso;
  - cancelación al final del periodo;
  - reintentos de Culqi.
- **Facturación:** SUNAT / facturación electrónica, reembolsos.
- **Operación:** alertas sobre eventos `FAILED` y checkouts `PENDING` antiguos; panel de Super Admin para ver
  `billing_*`.
- **Legal (pendiente de revisión legal; no se redactó contenido definitivo):**
  - condiciones de contratación;
  - precio con IGV y periodicidad;
  - renovación automática;
  - cancelación;
  - reembolsos y derecho de desistimiento;
  - Culqi como encargado de pagos (Privacidad);
  - aceptación de Términos antes de pagar (hoy el checkbox enlaza a los Términos actuales, que no cubren pagos);
  - Libro de Reclamaciones;
  - datos de contacto de facturación que se envían a Culqi.
