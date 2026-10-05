# EmailBot V2 — implementación

Rama: `feat/emailbot-v2`. Evolución incremental y aditiva de V1 (ver la auditoría arquitectónica aprobada).
Producción no se modifica sin autorización explícita por fase.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Preparación y compatibilidad | completada |
| 1 | Bots (tabla, `bot_id` en reglas y correos, motor de reglas) + `organizations.status` | completada |
| 2 | Customers, identificadores, asignaciones | completada |
| 3 | Routing: Customer Resolver + `email_deliveries` | completada |
| 4 | Customer Access ID + sesiones | completada |
| 5 | API del portal | pendiente |
| 6 | UI del portal | pendiente |
| 7 | Super Admin | pendiente |
| 8 | Hardening, E2E, documentación, preparación de producción | pendiente |

## Convenciones

- **Migraciones**: nunca se edita una migración aplicada. Las nuevas usan el formato de timestamp existente
  (`YYYYMMDDHHMMSS_nombre.sql`), posteriores a `20261003150000_processing_completion.sql` (última de V1).
  Cada migración se crea en la fase que la usa; el orden de los timestamps es el orden de creación.
- **Funciones del portal y del worker** con `SECURITY DEFINER`: en un schema propio (`portal`), con
  `search_path` fijado y `EXECUTE` solo para `service_role`. No en `public`/`private`: el test de
  privilegios de V1 exige que `service_role` no ejecute funciones definer de esos schemas.
- **Rutas web**: se mantiene la convención actual en la raíz (`/inbox`, `/rules`, …). Las nuevas pantallas de
  empresa usan `/bots` y `/customers` (no `/app/*`) para no romper enlaces ni la redirección de OAuth a
  `/accounts`. Nuevas áreas: `/portal/*` y `/admin/*`.

## Garantías automáticas (fase 0)

`packages/database/test/v1-compatibility.test.ts` construye el esquema dos veces (solo V1 y con todas las
migraciones) y falla si una migración de V2:

- cambia una política RLS de una tabla V1, el flag de RLS o una función V1 (salvo las listadas en
  `INTENTIONAL_V1_CHANGES`, que quedan visibles en revisión);
- elimina un grant de V1 o añade un grant de tabla completa a una tabla V1 (los nuevos accesos deben ser por
  columna).

Y exige para toda tabla y función presente y futura en `public`, `private` y `portal`:

- RLS activo en todas las tablas;
- `anon` sin privilegios de datos;
- funciones `SECURITY DEFINER` con `search_path` fijado, no ejecutables por `anon`/`PUBLIC`, y ejecutables por
  `authenticated` solo si están en la lista permitida.

Control negativo verificado: una migración temporal que alteraba una política, quitaba un grant y creaba una
tabla y una función inseguras hizo fallar 6 de estas comprobaciones.

## CORS

`CORS_ORIGINS` se valida en todos los entornos y se normaliza como lo envía el navegador
(`normalizeOrigin` en `@emailbot/validation`): host en minúsculas, sin puerto por defecto y sin `/` final. Un
valor con ruta, query, fragmento o credenciales impide el arranque. La API registra al arrancar la lista
efectiva (`corsOrigins`). Base para el portal (fase 5), que usará `credentials: true` con esta misma lista.

## Plantilla RLS para cada tabla nueva

¿Quién puede SELECT / INSERT / UPDATE / DELETE? ¿Puede cruzar `organization_id`? ¿Puede un Customer acceder?
¿Puede un Super Admin acceder? ¿Puede `service_role` acceder? La respuesta se documenta junto a la migración.

## Fase 1: decisiones implementadas

### Selección de bot (`packages/rules-engine/src/engine.ts`)

1. Solo cuentan las reglas que pertenecen a un bot (`bot_id`); las reglas generales clasifican pero no
   eligen bot.
2. Gana el bot de la regla coincidente con **mayor prioridad** (menor número) si es el único bot en esa
   prioridad.
3. Bots distintos empatados en esa prioridad = **AMBIGUOUS**: `emails.bot_id = NULL`, sin entregas, y
   `emails.provider_metadata` guarda `botSelection: "AMBIGUOUS"` y `botCandidateIds` (más un log
   `bot.selection.ambiguous`). `created_at`/`id` siguen ordenando la evaluación pero **nunca** deciden el bot.
4. `stop_processing` conserva su semántica V1 para las acciones. Para que el orden de creación no pueda
   ocultar un empate, tras una parada se comprueban (solo condiciones, sin acciones) las reglas restantes
   con la **misma** prioridad y otro bot.
5. Reglas de un bot **PAUSED** no se evalúan (ni acciones ni bot). Un bot cuyo estado no se puede confirmar
   como ACTIVE se trata como pausado.

### Estado de la organización

- API: `requireOrganization` responde `403 ORGANIZATION_INACTIVE` si la organización está SUSPENDED o
  CANCELLED. Excepciones explícitas (`config.allowInactiveOrganization`): `GET /organizations/current`.
  `/api/me` no exige organización y muestra el estado. Sin cambios en `private.is_organization_member`.
- Worker: `processEmail` (`organization_inactive`) y `syncAccount` no procesan ni listan nada (el cursor no
  avanza: no se pierde correo); el polling y el barrido de recuperación excluyen esas organizaciones (los
  correos incompletos no se reintentan hacia FAILED). Nada se borra.
- Grant mínimo: `service_role` solo `select (id, status)` sobre `organizations`.
- Web: pantalla de organización inactiva (cambiar de organización o cerrar sesión).

### RLS de `bots` (plantilla)

| Pregunta | Respuesta |
|---|---|
| SELECT | miembros de la organización (todos los roles) |
| INSERT | OWNER/ADMIN; `created_by`/`updated_by` = el propio usuario o NULL |
| UPDATE | OWNER/ADMIN; `organization_id` no es actualizable (grants por columna) |
| DELETE | OWNER/ADMIN (la API rechaza bots con correos: `BOT_HAS_EMAILS`) |
| ¿Cruza `organization_id`? | No: RLS + FK compuestas `(organization_id, bot_id)` en `email_rules` y `emails` (también para service role y owner) |
| ¿Customer? | No (portal: fases 4-5) |
| ¿Super Admin? | Sin excepción RLS (fase 7: API + service role) |
| service_role | `select (id, organization_id, status)` |

`email_rules.bot_id`: INSERT/UPDATE por columna para `authenticated` (RLS existente: OWNER/ADMIN).
`emails.bot_id`: lo escribe el worker; sin UPDATE para `authenticated` (re-enrutado: fase 3).

## Fase 2: decisiones implementadas

### Customers

- Pertenecen a una organización; no son usuarios de Supabase Auth.
- **Sin borrado**: `authenticated` no tiene DELETE (ni grant ni política) y la API no expone DELETE. Un cliente
  sale con `status = SUSPENDED`, que conserva historial, identificadores y asignaciones. Solo borrar la
  organización entera los elimina (cascada).
- Permisos (`@emailbot/types`): `customers:read` todos los roles; `customers:manage` OWNER/ADMIN/OPERATOR
  (incluye identificadores y asignaciones bot ↔ cliente). Las políticas RLS replican la misma matriz.
- `external_ref` único por organización (opcional).

### Normalización de identificadores

Una sola implementación: `normalizeIdentifier` en `@emailbot/validation` (API al escribir, web para la vista
previa, worker al buscar en la fase 3). Todos los tipos: Unicode NFC + trim.

| Tipo | Regla |
|---|---|
| EMAIL | minúsculas; **se conservan** puntos y `+alias` (`john.smith@` ≠ `johnsmith@`, `john+netflix@` ≠ `john@`) |
| PHONE | dígitos, conservando un `+` inicial; se quitan espacios, guiones, puntos, paréntesis y `/`; 6-15 dígitos; letras rechazadas; no se deduce el código de país |
| USERNAME / EXTERNAL_ID / CUSTOM | minúsculas |

La base de datos solo comprueba invariantes de la salida (`customer_identifiers_normalized_format`), sin
duplicar la lógica.

### Unicidad de identificadores

`UNIQUE NULLS NOT DISTINCT (customer_id, type, normalized_value, bot_id)`:

- impide duplicados exactos del mismo cliente y alcance (incluido el alcance NULL);
- **permite** el mismo valor en varios clientes (cuentas compartidas): la política `onMultipleMatches` del bot
  decide en la fase 3 (DELIVER_ALL o LEAVE_UNASSIGNED);
- el mismo valor con alcance distinto (todos los bots / un bot concreto) es otra relación.

Búsqueda del resolver: índice `(organization_id, type, normalized_value) where active`.

### Integridad entre organizaciones

FK compuestas sobre `(organization_id, ...)`: identificador → cliente y bot de su organización; asignación →
bot y cliente de su organización. Lo impide la base de datos para cualquier rol (también service role y
owner). Las referencias a `bots` son NO ACTION: un bot con clientes asociados o identificadores propios no se
puede borrar (la API responde `409 BOT_IN_USE`); nada se borra ni se amplía en silencio. Borrar la organización
elimina todo en cascada.

### Estados

Cliente SUSPENDED y bot PAUSED conservan identificadores y asignaciones; una asignación con `active = false`
se conserva. La fase 3 debe considerar elegibles solo: cliente ACTIVE, asignación activa, bot ACTIVE e
identificador activo.

### API y auditoría

- `organizationId` siempre de la organización activa y el actor del JWT; cuerpos estrictos.
- Todo id de la ruta se resuelve dentro de la organización activa (404 si no): ids de otro tenant son
  indistinguibles de inexistentes (IDOR).
- Búsqueda solo en la organización activa (nombre, referencia externa, identificador normalizado); el término
  se sanea para que no pueda añadir filtros PostgREST ni comodines.
- Eventos: `customer.created/updated/suspended/reactivated`, `identifier.created/updated/deleted`,
  `customer.bot.assigned/unassigned/activated/deactivated`. Los **valores** de los identificadores son datos
  personales y nunca se escriben en auditoría (solo tipo y alcance).

### RLS (plantilla)

| Pregunta | customers | customer_identifiers | bot_customer_assignments |
|---|---|---|---|
| SELECT | miembros | miembros | miembros |
| INSERT | OWNER/ADMIN/OPERATOR; `created_by` propio o NULL | OWNER/ADMIN/OPERATOR | OWNER/ADMIN/OPERATOR; `created_by` propio o NULL |
| UPDATE | nombre, estado, referencia, notas | valor, valor normalizado, alcance, activo | solo `active` |
| DELETE | nadie | OWNER/ADMIN/OPERATOR | OWNER/ADMIN/OPERATOR |
| ¿Cruza organización? | no (RLS + FK compuestas) | no | no |
| ¿Customer (portal)? | no | no | no |
| ¿Super Admin? | sin excepción RLS | sin excepción RLS | sin excepción RLS |
| service_role | fase 3: `select (id, organization_id, status)` | fase 3: lectura por columnas, sin `value` | fase 3: lectura por columnas |

### Búsqueda de clientes por teléfono (corrección)

La búsqueda compara los identificadores por su forma normalizada: el texto en minúsculas **o**, para `PHONE`,
el fragmento de teléfono normalizado (`+51 987` → `+51987`, `987 654 321` → `987654321`). Ambas formas salen de
`normalizeIdentifierFragment`, que reutiliza la misma canonicalización que `normalizeIdentifier` (sin las
comprobaciones de valor completo). Valores almacenados y semántica de `PHONE` sin cambios.

## Fase 3: decisiones implementadas

### Flujo del worker

```
proveedor -> worker -> fetch/normalize -> dedupe -> evaluateRules (selección de bot + extractores)
  -> insert email (RECEIVED) -> PROCESSING -> CustomerResolver -> insert email_deliveries
  -> adjuntos -> realtime -> notificaciones -> PROCESSED
```

**Desviación documentada:** el resolver se ejecuta **después** de insertar el correo (no antes). Motivo: la
entrega necesita `email_id`, y así el primer intento y cualquier reanudación (reintento BullMQ, job estancado,
barrido de recuperación, workers concurrentes) siguen exactamente el mismo camino. El resolver usa lo
**guardado** con el correo (`emails.bot_id`, `provider_metadata.botSelection`, `extracted_data`), no una
reevaluación: si las reglas cambian entre intentos, el routing no cambia (y `emails.bot_id` nunca cambia).
`PROCESSED` se escribe solo después de las entregas.

### CustomerResolver (`apps/worker/src/pipeline/resolve-customers.ts`)

Entrada: organización, bot del correo, resultado de la selección de bot, datos normalizados del correo,
`extracted_data` y `customer_resolution` del bot (revalidado con `customerResolutionSchema`). Salida
determinista:

| Caso | Resultado | Auditoría (`metadata.event`) |
|---|---|---|
| Sin bot (regla general, correo V1) | sin entregas | — |
| Empate entre bots | sin entregas | `routing.ambiguous_bot` (ids de bots candidatos) |
| Bot no encontrado / PAUSED | sin entregas | `routing.unassigned` (`BOT_NOT_FOUND` / `BOT_PAUSED`) |
| `customer_resolution` inválido | sin entregas | `routing.unassigned` (`INVALID_CONFIGURATION`) |
| `source = NONE` | sin entregas | — |
| El correo no aporta identificador válido | sin entregas | `routing.unassigned` (`NO_IDENTIFIER`) |
| 0 clientes | sin entregas | `routing.unassigned` (`NO_MATCH`) |
| 1 cliente | 1 entrega AUTOMATIC | — |
| N clientes + LEAVE_UNASSIGNED | sin entregas | `routing.multiple_matches` |
| N clientes + DELIVER_ALL | N entregas AUTOMATIC | `routing.multiple_matches` (`delivered`) |
| Error (BD, red) | excepción → política de reintentos | `routing.failed` (solo código de error) |

- Valores buscados: RECIPIENT = To ∪ Cc; SENDER = remitente; EXTRACTED_FIELD = `extracted_data[field]`. Todos
  pasan por `normalizeIdentifier` (el mismo normalizador que la API); los inválidos se ignoran.
- Cliente elegible: identificador activo, de la organización, con alcance organización (`bot_id` NULL) o el bot
  del correo; cliente ACTIVE; asignación activa al bot; bot ACTIVE. El store filtra en SQL y el resolver vuelve a
  filtrar (defensa en profundidad); la base de datos vuelve a comprobarlo al insertar.
- Un cliente encontrado por varios identificadores cuenta una vez (se registra el identificador con alcance de
  bot; si no, el de menor id). Los clientes se ordenan por id: nunca se elige uno arbitrariamente.
- Auditoría: eventos SYSTEM (acción `PROCESS`, entidad `email`) sin datos personales (nunca valores de
  identificadores, Access IDs ni tokens). Es *at-least-once*: un correo reanudado o procesado por workers
  concurrentes puede registrar el mismo evento más de una vez (las entregas nunca se duplican).
- Consultas del worker: búsqueda por `(organization_id, type, normalized_value) where active` (en bloques de 50
  valores, cada valor entrecomillado y escapado para PostgREST) + asignaciones activas del bot.

### `email_deliveries`

- `unique (email_id, customer_id)`: el worker inserta con `ON CONFLICT DO NOTHING` (idempotente).
- FK `(organization_id, email_id, bot_id)` → `emails(organization_id, id, bot_id)`: el correo es de la misma
  organización **y** su bot es exactamente el de la entrega; un correo sin bot nunca se entrega.
- FK `(organization_id, customer_id)` → `customers`; FK `(organization_id, customer_id, identifier_id)` →
  `customer_identifiers` (el identificador es de ese cliente; borrarlo solo pone `identifier_id` a NULL);
  FK `(organization_id, bot_id)` → `bots` (un bot con entregas no se puede borrar).
- Trigger `validate_email_delivery_eligibility` (SECURITY INVOKER, no ejecutable directamente): una entrega
  **nueva** exige bot ACTIVE, cliente ACTIVE y asignación activa. Pausar un bot o suspender un cliente no borra
  el historial.
- AUTOMATIC nunca tiene `created_by`; MANUAL queda reservado (sin API ni política en la fase 3).

### RLS de `email_deliveries` (plantilla)

| Pregunta | Respuesta |
|---|---|
| SELECT | miembros de la organización (todos los roles) |
| INSERT / UPDATE / DELETE | nadie (sin grant ni política) en la fase 3 |
| ¿Cruza `organization_id`? | No: RLS + FK compuestas + trigger (también para service role y owner) |
| ¿Customer? | No (portal: fases 4-5, mediante funciones SECURITY DEFINER) |
| ¿Super Admin? | Sin excepción RLS (fase 7) |
| service_role | `insert (organization_id, email_id, customer_id, bot_id, resolution, identifier_id)`, `select (id, email_id, customer_id)` |

### Grants del worker (migración `worker_customer_resolution_access`)

Solo lectura por columnas: `bots.customer_resolution`; `customers (id, organization_id, status)`;
`customer_identifiers (id, organization_id, customer_id, type, normalized_value, bot_id, active)` (sin el valor
original); `bot_customer_assignments (organization_id, bot_id, customer_id, active)`. Sin escritura en esas
tablas y sin acceso a nombres, notas ni referencias externas.

### Compatibilidad

Correos V1 y de reglas generales (`bot_id` NULL): mismo comportamiento, sin entregas ni auditoría; sin backfill
ni asignación retroactiva. Un correo que quedó sin asignar no se reasigna solo cuando después se crea el
cliente (la entrega manual es una fase posterior).

### Decisiones cerradas tras la fase 3

1. **Entregas MANUAL: sí, en una fase posterior** (no forman parte de la fase 4). Mismas fronteras que las
   automáticas: bot ACTIVE, cliente ACTIVE, asignación bot ↔ cliente activa y misma organización (el trigger
   `validate_email_delivery_eligibility` ya lo exige para toda entrega nueva). Si el cliente no está asignado, la
   operación primero crea/activa la asignación y después la entrega; nunca es una forma de saltarse la
   asignación. `resolution = MANUAL`, permiso `deliveries:manage` (VIEWER no), auditada.
2. **Correos sin asignar:** no se reasignan automáticamente cuando después se crea un cliente compatible. La
   entrega será manual. Un futuro «reprocesar correo» sería una acción explícita y auditada (ni fase 3 ni 4).
3. **RECIPIENT = To + Cc**, nunca Bcc, con el modelo normalizado actual.
4. **Auditoría de routing *at-least-once*** aceptada: en concurrencia o reanudación puede registrarse más de una
   entrada para el mismo evento lógico. Las operaciones reales (correos, entregas, adjuntos, notificaciones) siguen
   siendo idempotentes. Los eventos no llevan datos personales innecesarios.

## Fase 4: decisiones implementadas

Identidad y sesión del cliente final (sin Supabase Auth). Sin UI del portal todavía (fase 5); en el panel, la
ficha del cliente tiene la tarjeta «Acceso al portal».

### Access ID

- Formato `SP-XXXXXXXXXXXX`: 12 caracteres Crockford base32 = 60 bits de `crypto.randomBytes`. El prefijo es
  cosmético (por ahora fijo `SP`, guardado en `display_prefix`) y no forma parte del secreto.
- **Nunca se guarda** (ni en claro ni cifrado): solo `secret_hash = hex(HMAC-SHA256(k, secreto normalizado))` con
  `k = HKDF-SHA256(TOKEN_ENCRYPTION_KEY, info "emailbot:customer-access:v1")`, más `last4`. Se muestra completo
  **una vez** (respuesta de la generación, `Cache-Control: no-store`); después solo `SP-••••••••XXXX`.
- **Normalización única** (`normalizeAccessId`, `@emailbot/validation`): NFKC, mayúsculas, sin espacios ni
  guiones, prefijo ignorado (primer segmento separado si el resto tiene 12 caracteres, o letras iniciales de una
  entrada sin separadores), O→0, I/L→1; una entrada truncada se rechaza, nunca se reinterpreta. Nota: el ejemplo
  `SP-7KQ9X82MP4L7` contiene una L, que no pertenece al alfabeto: se normaliza a 1. Los IDs generados nunca
  contienen I, L, O ni U.
- Una sola credencial ACTIVE por cliente (índice único parcial). Generar con una ACTIVE = **regenerar**: en una
  transacción (bloqueo de la fila del cliente) se revoca la anterior (`REGENERATED`), se revocan todas las
  sesiones del cliente y se crea la nueva. Revocar: credencial `REVOKED` + sesiones revocadas. Caducidad opcional
  (`expires_at`). Nada se borra.

### Sesiones

- Token de 256 bits (base64url) solo en la cookie `__Host-emailbot_portal`: `HttpOnly; Secure; SameSite=Strict;
  Path=/`, sin `Domain`, `Max-Age` hasta la caducidad absoluta. La base guarda `SHA-256(token)`. El frontend nunca
  recibe el token (ni en el cuerpo ni accesible a JavaScript); nada en localStorage/sessionStorage/IndexedDB.
- Inactividad 7 días, máximo absoluto 30 (y nunca más allá de la caducidad de la credencial). `last_seen_at` y la
  inactividad se deslizan como mucho cada 5 minutos.
- `requirePortalSession` (API) → `portal.validate_session`: sesión no revocada ni caducada, credencial ACTIVE y no
  caducada, cliente ACTIVE, organización ACTIVE. **La sesión es la única autoridad**: el cliente no aporta
  `customerId`, `organizationId` ni rol (cuerpos estrictos; cabeceras y query ignoradas).
- Cliente SUSPENDED: un trigger revoca sus sesiones abiertas en la misma transacción (`CUSTOMER_SUSPENDED`); al
  reactivarlo debe volver a entrar. Organización suspendida: login rechazado y sesiones inválidas mientras dure
  (no se revocan ni borran; vuelven a valer al reactivarla).

### Endpoints

| Método y ruta | Acceso | Notas |
|---|---|---|
| `POST /api/portal/session` | público | `{ accessId }`; 5/min/IP + bloqueo de 15 min tras 10 fallos; error único `401 INVALID_CREDENTIALS` «Las credenciales no son válidas.» |
| `GET /api/portal/me` | sesión | nombre y estado del cliente, nombre de la organización, bots activos asignados con su `portalSettings`, caducidades; sin ids internos |
| `POST /api/portal/logout` | sesión | revoca solo la sesión actual (`LOGOUT`), limpia la cookie; idempotente (204) |
| `GET/POST/DELETE /api/customers/:id/access` | `customer-access:manage` | estado y `last4` / generar o regenerar (`{ expiresAt? }`) / revocar |
| `GET/DELETE /api/customers/:id/sessions[/:sessionId]` | `customer-access:manage` | listar (sin hashes) / revocar todas / revocar una |

`customer-access:manage` = OWNER, ADMIN, OPERATOR (nunca VIEWER). Ids de la ruta resueltos dentro de la
organización activa (404 si no: IDOR).

### Login: enumeración, tiempos y fuerza bruta

- Desconocido, malformado, revocado, caducado, cliente suspendido y organización suspendida → misma respuesta
  (estado, código, mensaje, sin cookie). La categoría solo va a logs estructurados (sin el Access ID) y, si la
  credencial existe, a la auditoría de su organización. La auditoría se escribe fuera del camino de la
  respuesta. Un ID desconocido no se puede atribuir a ninguna organización: solo logs.
- Búsqueda por `secret_hash` con índice único (sin comparación de secretos en la aplicación).
- Rate limit de ruta (5/min/IP) y bloqueo (10 fallos en 15 min → IP bloqueada 15 min; un login correcto
  reinicia el contador) con el **mismo mecanismo resiliente** existente: Redis (scripts Lua atómicos) y, si Redis
  falla, los mismos contadores locales acotados por instancia. Las claves solo contienen la IP.
- CSRF: `SameSite=Strict`; `POST /api/portal/*` exige `application/json` (login) y rechaza un `Origin` fuera de
  `CORS_ORIGINS`. CORS con credenciales **solo** para `/api/portal/*`; el resto de la API sigue sin cookies.

### Base de datos

| Pregunta | customer_access_credentials | customer_sessions |
|---|---|---|
| SELECT | OWNER/ADMIN/OPERATOR, todas las columnas **salvo** `secret_hash` | OWNER/ADMIN/OPERATOR, todas **salvo** `token_hash` |
| INSERT / UPDATE / DELETE | nadie directamente (funciones) | nadie directamente (funciones) |
| ¿Cruza organización? | no: RLS + FK `(organization_id, customer_id)` | no: RLS + FK `(organization_id, customer_id, credential_id)` |
| ¿Customer (portal)? | nunca la lee; `portal.create_session` | solo vía `portal.*` con su token |
| ¿Super Admin? | sin excepción RLS | sin excepción RLS |
| service_role | **sin privilegios de tabla** | **sin privilegios de tabla** |

Funciones `SECURITY DEFINER` (`search_path = ''`, nombres calificados, EXECUTE revocado a PUBLIC/anon y concedido
a un único rol):

- `authenticated` (miembros, vía API con su JWT): `public.issue_customer_access`,
  `public.revoke_customer_access`, `public.revoke_customer_sessions`. Autoridad: `auth.uid()` con rol
  OWNER/ADMIN/OPERATOR en la organización **del cliente** (leída de la base); `customer_id` es solo el objetivo.
  Cliente ajeno o inexistente → mismo error.
- `service_role` (API del portal): `portal.create_session`, `portal.validate_session`, `portal.end_session`.
  Autoridad: el secreto (hash del Access ID o del token); no aceptan `customer_id` ni `organization_id`.
  `create_session` usa `FOR SHARE` sobre la credencial para no crear una sesión de una credencial revocada en
  paralelo.

Ningún rol de la API puede leer `secret_hash` ni `token_hash`. Lista de funciones permitidas a `authenticated`
ampliada en la guarda V1; matriz del service role sin cambios para estas tablas.

**Schema `portal` expuesto en PostgREST** (`supabase/config.toml [api].schemas`), con `USAGE` solo para
`service_role`. En producción habrá que añadir `portal` a *Exposed schemas* (Dashboard → API) en el despliegue
de V2; sin ello el login del portal fallaría (fallo cerrado).

### Auditoría

| Evento | Acción | Actor |
|---|---|---|
| `customer.access.generated` / `customer.access.regenerated` | CREATE | miembro |
| `customer.access.revoked` | UPDATE | miembro |
| `customer.session.revoked` (una sesión: admin o logout) | UPDATE / LOGOUT | miembro / SYSTEM |
| `customer.sessions.revoked` | UPDATE | miembro |
| `portal.login.succeeded` (incluye la creación de la sesión) | LOGIN | SYSTEM |
| `portal.login.failed` (solo `reason` categórico) | FAIL | SYSTEM |

Nunca se registran el Access ID, `secret_hash`, el token, su hash ni tokens OAuth. Política actual: la IP no se
guarda en `audit_logs` (sí en `customer_sessions.ip` y en los logs).

## Deuda de QA

- **TODO antes del lanzamiento**: añadir `jsdom` + `@testing-library/react` para tener tests de
  componentes/render reales en la aplicación web (hoy la suite web solo cubre lógica sin DOM). No instalado
  todavía.

## Decisiones pendientes

Fases 0 a 3: todas cerradas. Abiertas tras la fase 4:

1. Prefijo del Access ID: hoy fijo `SP`. ¿Configurable por organización (`customer_access_prefix`, diseño
   aprobado como cosmético)? Requiere una columna nueva, fuera del alcance de la fase 4.
2. Despliegue: exponer el schema `portal` en PostgREST de producción (Dashboard → API → Exposed schemas).
3. Entregas MANUAL (decididas, ver fase 3): ¿en qué fase se implementan?
