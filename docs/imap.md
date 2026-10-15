# IMAP (correo externo)

Estado: **desactivado**. La API responde 503 al alta y a la prueba de conexión (`imapAccountsEnabled:
false`, fijo en código) y el worker no sincroniza IMAP (`imapSyncEnabled: false`, fijo en código, sin variable de entorno). Ningún buzón IMAP
se conecta en producción hasta que un cambio de código lo active.

| Fase | Contenido | Estado |
|---|---|---|
| E1 | Permisos de `email_accounts`, función atómica `connect_imap_email_account`, entitlement `IMAP` (PRO, BUSINESS), protección SSRF (`@emailbot/shared` `imap-destination.ts`), TLS obligatorio, `SecretBox` v2 | hecho |
| E2 | Adaptador IMAP del worker (este documento) | hecho, desactivado |
| E3 | Transporte compartido (`@emailbot/shared` `imap-client.ts`), prueba de conexión y alta con conexión previa en la API | hecho, desactivado |
| E4 | Endurecimiento de límites de abuso: claves HMAC, límites compartidos solo en Redis (503 si falla), límite global por buzón, 503 antes de leer el cuerpo | hecho, desactivado |
| E5 | Formulario web | pendiente |

## Transporte compartido (E3)

`packages/shared/src/imap-client.ts` (dependencia `imapflow` 2.1.2 exacta, solo en `@emailbot/shared`), usado
por el worker y por la API:

- `createImapConnector()` — `resolveImapDestination` (todas las A/AAAA públicas) → `imapConnectionOptions`
  (host = IP literal validada, `servername` = nombre DNS, certificado verificado, TLS ≥ 1.2, STARTTLS
  obligatorio en 143, sin proxy) → `assertSafeImapConnectionOptions` → `openImapClient()` (ImapFlow, timeouts
  `IMAP_TIMEOUTS`). Si la primera IP validada no responde se prueba la segunda (nunca tras un fallo TLS o de
  login). DNS se resuelve y valida de nuevo en cada conexión.
- `classifyImapFailure()` — `ImapTransportError` neutro (`AUTH` / `SECURITY` / `TRANSIENT` / `MAILBOX`, código
  estable, mensaje fijo). El worker lo traduce a sus clases (`errors.ts`) y la API a respuestas 422.
- `probeImapInbox()` — prueba de conexión: conecta, `EXAMINE INBOX` (solo lectura), lee UIDVALIDITY y UIDNEXT,
  `LOGOUT`. Cierra todos los clientes en éxito, error y al vencer `IMAP_PROBE_DEADLINE_MS` (30 s, cierre
  forzado incluso a mitad del handshake). Nunca lee un mensaje.
- `imap-cursor.ts` — cursor `imap:v1:<UIDVALIDITY>:<UID>` e id de mensaje `<UIDVALIDITY>:<UID>` (la API escribe
  el cursor inicial, el worker lo lee).

## API (E3)

Ambas rutas, detrás del mismo 503 `IMAP_NOT_AVAILABLE`:

- `POST /api/email-accounts/imap/test` — `{ emailAddress, host, port, security, username, password }` →
  `{ ok: true }`. No guarda nada, no encola nada, no importa nada.
- `POST /api/email-accounts/imap` — los mismos campos + `displayName`. Hace la misma prueba y, si pasa, cifra la
  contraseña con `SecretBox.encryptBound` (contexto organización + dirección) y llama a
  `connect_imap_email_account` (E1: bloqueo de la organización, plan, límite, duplicados y reconexión en una
  transacción; si falla no queda cuenta ni secreto). La cuenta queda PAUSED y no se encola nada.

### Ruta desactivada y cuerpo de la petición (E4, B2)

Ciclo de Fastify de las dos rutas IMAP: `onRequest` (límite por IP de la ruta, como todas) → `preParsing`
(autenticación → organización → `email-accounts:manage` → comprobación "IMAP desactivado") → lectura y
análisis del cuerpo → handler. Mientras IMAP está desactivado la respuesta 503 sale **antes de leer el
cuerpo**: un JSON válido, malformado, de más de 1 MB o `text/plain` reciben el mismo 503, y no se consulta DNS,
no se abre un socket, no se cifra ni descifra, no se persiste ni se encola nada. Anónimo → 401, sin permiso
o de otra organización → 403 (sin cambios). El resto de rutas conserva su orden (`preHandler`).

### Orden de comprobaciones (IMAP activado)

Límite por IP → autenticación → organización → permiso → validación estricta (solo 993/TLS o 143/STARTTLS,
nombre DNS público, sin IP literal, tamaños acotados, sin campos extra) → plan `IMAP` (PRO, BUSINESS) y hueco
en `EMAIL_ACCOUNTS` salvo reconexión del mismo buzón IMAP, y el mismo buzón no conectado por Gmail / Microsoft
(solo en la propia organización) → secreto de límites configurado → intentos por usuario / organización →
bloqueo por logins rechazados → destino SSRF con sus códigos (`IMAP_ADDRESS_FORBIDDEN`, `IMAP_DNS_FAILED`…) →
concurrencia → límite global por buzón → prueba. Ninguna consulta DNS ni conexión ocurre antes de contar el
intento.

### Límites de abuso

`apps/api/src/modules/email-accounts/imap-connection.ts` (`IMAP_CONNECTION_LIMITS`, `IMAP_LOGIN_LOCKOUT`):

| Límite | Valor | Respuesta |
|---|---|---|
| Por IP (ruta) | 10 / 10 min (`RATE_LIMITS.imapTest`, `imapCreate`) | 429 `RATE_LIMITED` |
| Intentos por usuario | 10 / 10 min (todo intento que llega a ese punto, sea cual sea su resultado) | 429 `IMAP_TEST_RATE_LIMITED` |
| Intentos por organización | 20 / 10 min | 429 `IMAP_TEST_RATE_LIMITED` |
| Logins rechazados por buzón (organización, servidor, usuario) | 10 / 15 min → bloqueo de 15 min | 429 `IMAP_LOGIN_LOCKED` |
| Logins rechazados por organización | 30 / 15 min → bloqueo de 15 min | 429 `IMAP_LOGIN_LOCKED` |
| **Logins rechazados por buzón externo, todas las organizaciones** (M2) | 30 / ventana fija de 15 min | 429 `IMAP_TEST_RATE_LIMITED` |
| Concurrencia por organización (compartida) | 1, con *lease* de 90 s | 429 `IMAP_TEST_BUSY` |
| Concurrencia por instancia de la API (recurso local) | 4 | 429 `IMAP_TEST_BUSY` |
| Duración de una prueba | 30 s y cierre forzado | 422 `IMAP_TIMEOUT` |

Solo los logins rechazados (`IMAP_AUTH_FAILED`) alimentan los bloqueos y el límite global; los errores de DNS,
TLS, timeout o validación nunca cuentan como contraseña incorrecta. El buzón se compara sin distinguir
mayúsculas en servidor y usuario y sin el puerto (993 y 143 llegan a la misma cuenta); es solo la clave: el
usuario enviado al servidor no cambia. El portal conserva su propia política (`LOGIN_LOCKOUT`).

**Límite global por buzón (E4, M2).** Clave: HMAC de (servidor, usuario), sin organización ni puerto. Antes de
conectar se reserva una unidad con un script Lua atómico (`RESERVE_SCRIPT`: INCR + PEXPIRE de la ventana +
tope); un login correcto o un fallo que no sea de contraseña la devuelve (`RELEASE_SCRIPT`), así que en la
ventana solo quedan los logins rechazados (y las pruebas en curso). Por qué 30 / 15 min:

- una organización aporta como máximo 10 logins rechazados a un buzón en 15 min (su bloqueo por buzón salta en
  el décimo, también si cambia mayúsculas o puerto), así que llenar el cupo exige **al menos 3 organizaciones**,
  cada una con plan PRO o BUSINESS de pago y con OWNER / ADMIN; ninguna organización puede, sola, impedir a otra
  conectar ese buzón;
- no es un bloqueo: caduca con su ventana (como mucho 15 min) y no se prolonga; solo afecta a pruebas y altas
  nuevas de ese buzón (la sincronización del worker no lo usa);
- protege al tercero: como mucho 30 contraseñas probadas cada 15 min contra un buzón, entre todas las
  organizaciones (antes, 10 por organización sin límite común);
- la respuesta es la genérica `IMAP_TEST_RATE_LIMITED` de los otros límites de intentos, sin decir si otras
  organizaciones usan el buzón (un rechazo sin fallos propios sí indica actividad ajena: inevitable en
  cualquier límite compartido).

### Claves HMAC (E4, B6)

Las claves de Redis de un buzón (`mailbox:<hmac>` por organización, `target:<hmac>` global) son
HMAC-SHA-256 con `IMAP_RATE_LIMIT_SECRET`, con separación de dominio por propósito
(`emailbot-imap-limit:v1:<propósito>`); quien lea Redis no puede probar usuarios candidatos sin el secreto. Las
claves de usuario y organización solo llevan sus UUID internos.

- Formato: base64 estándar de al menos 32 bytes aleatorios (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
  La API no arranca con un valor inválido (corto, no base64, todos los bytes iguales) ni si coincide con
  `TOKEN_ENCRYPTION_KEY` u `OAUTH_STATE_SECRET`; el error nunca muestra el valor.
- Opcional mientras IMAP esté desactivado. Sin él, la prueba y el alta responden 503 `PROVIDER_NOT_CONFIGURED`
  antes de Redis, DNS o cualquier conexión: **nunca** se usa un hash sin clave.
- Todas las instancias de la API deben compartir el mismo valor (si no, cada una calcula otras claves y los
  límites por buzón dejan de compartirse).
- Rotación: **no es transparente**. Con un secreto nuevo las claves cambian, así que los contadores, bloqueos
  por buzón y el cupo global anteriores dejan de aplicarse (caducan solos en ≤ 15 min). Los límites por
  usuario y organización (UUID) no se ven afectados. Rotar solo si el secreto se expone y aceptar ese reinicio.

### Si Redis falla (E4, B4)

Los límites compartidos de IMAP (intentos por usuario y organización, bloqueos, concurrencia por
organización, límite global) viven **solo en Redis**, con scripts atómicos y un plazo de 2 s por operación
(`storeTimeoutMs`). Sin Redis, con error o sin respuesta a tiempo, la prueba y el alta responden **503
`SERVICE_UNAVAILABLE`** antes de cualquier consulta DNS o socket: nunca un contador por instancia que
multiplicaría los límites por N instancias, y nunca una respuesta que parezca una contraseña incorrecta. El
log registra `imap.limits_unavailable` (sin secretos). Si Redis falla **después** de conectar (anotar el
fallo, devolver la reserva, liberar el hueco), la respuesta de la prueba no cambia y se registra
`imap.limits_bookkeeping_failed`; el *lease* de 90 s y las ventanas acotan el efecto.

El login del portal y el límite global por IP conservan su comportamiento (respaldo por instancia). El límite
por IP no tiene plazo propio: en producción lo acota el `commandTimeout` de 5 s de la conexión de Redis.

Errores públicos (422, mensaje fijo): `IMAP_AUTH_FAILED`, `IMAP_TLS_FAILED`, `IMAP_STARTTLS_UNAVAILABLE`,
`IMAP_HOST_FORBIDDEN`, `IMAP_DNS_FAILED`, `IMAP_TIMEOUT`, `IMAP_UNREACHABLE`, `IMAP_FAILED`,
`IMAP_INBOX_UNAVAILABLE`, `IMAP_RESPONSE_TOO_LARGE`. El log solo registra `imap.connection_test` con el código, el
puerto y la duración.

Límites del protocolo (E6.1): cada cliente ImapFlow recibe `maxLineLength`, `maxLiteralSize` y `maxResponseSize`
explícitos (`IMAP_PROTOCOL_LIMITS` en `packages/shared/src/imap-client.ts`; nunca los valores por defecto de ImapFlow,
1 GiB / 1 GiB / 2 GiB). Prueba de conexión de la API: 256 KiB / 256 KiB / 1 MiB. Sincronización del worker: 2 MiB /
11 MiB / 14 MiB (un mensaje de hasta 10 MiB con margen; los mayores se leen en trozos de 64 KiB). ImapFlow los aplica
mientras analiza, antes de guardar los bytes: un literal se rechaza al leer su `{tamaño}`. Superarlos cierra la
conexión con `IMAP_RESPONSE_TOO_LARGE` (SECURITY: en el worker, cuenta en ERROR y sin reintentos).

### Ciclo de vida de una cuenta IMAP (M1)

Implementado en local, sin commit (migración `20261015120000_imap_m1_lifecycle.sql`, aditiva; la de E1 no cambia).
IMAP sigue desactivado: con los indicadores en `false` la reanudación responde `409 IMAP_SYNC_NOT_IMPLEMENTED` y las
dos rutas IMAP, `503 IMAP_NOT_AVAILABLE`.

- **Conectar / reconectar** (prueba de conexión correcta) deja la cuenta en `PAUSED` con `IMAP_ACTIVATION_PENDING`,
  también si estaba `ACTIVE`. La sincronización solo empieza tras una reanudación explícita.
- **Reanudar** (`PATCH /api/email-accounts/:id` `{ status: "ACTIVE" }`, OWNER / ADMIN): aviso temprano de plan y
  después `public.activate_imap_email_account` (solo `service_role`, bloqueo por organización): cuenta de esa
  organización, IMAP, solo desde `PAUSED`, contraseña v2 y ajustes válidos, función IMAP del plan con acceso
  comercial. No ocupa un hueco nuevo (`PAUSED` ya cuenta). El *trigger* de E1 sigue impidiendo que un miembro la
  active directamente. Una activación válida se audita y encola la primera sincronización (si la cola falla, la
  cuenta queda `ACTIVE` y la recoge el sondeo). Pausar sigue igual.
- **Una cuenta en `ERROR` no se reanuda** (M1.4): el worker la detuvo (login rechazado, certificado, TLS, ajustes...)
  y reanudarla haría que volviera a iniciar sesión fuera de los límites anti-abuso de la prueba de conexión (E4).
  La API responde `409 IMAP_RECONNECT_REQUIRED` antes de consultar el plan o llamar a la RPC (sin trabajo, sin
  auditoría, sin conexión), y la RPC también la rechaza (`RECONNECT_REQUIRED`) si pasa a `ERROR` entre medias. Hay
  que conectarla de nuevo (mismo buzón: prueba de conexión con los límites E4, queda `PAUSED`; mismo servidor y
  usuario conservan el cursor) y después reanudarla. `DISCONNECTED` sigue respondiendo `409 RECONNECT_REQUIRED`.
  Gmail y Microsoft en `ERROR` se reanudan como antes.
- **Worker (solo IMAP)**: si durante un lote la cuenta deja de estar `ACTIVE`, la organización se suspende, se pierde
  el acceso comercial o la función IMAP del plan, el cursor **no** avanza (compare-and-set con `status = ACTIVE`).
  Cada mensaje comprueba el estado de la cuenta al empezar a procesarse: los que aún no han empezado no se
  procesan (el lote se detiene, `imap.sync.halted`), pero **la pausa no cancela lo que ya está en curso**: los
  mensajes que ya pasaron esa comprobación (hasta 3 a la vez) pueden terminar de procesarse y guardarse después de
  pedir la pausa. No se promete que ningún mensaje se procese tras solicitarla. Al reanudar, la ejecución vuelve a
  listar desde el mismo cursor y la deduplicación por id de mensaje del proveedor evita insertar de nuevo los ya
  guardados: nada se pierde ni se duplica (verificado contra PostgreSQL y Dovecot reales en M1.3 / M1.4). Perder
  la función IMAP no marca ERROR: la sincronización se detiene y continúa cuando el plan vuelve a incluirla.
  `markError` nunca cambia una cuenta IMAP `DISCONNECTED` (un trabajo atrasado no la revive). Una operación de red
  ya en curso no se cancela por la pausa, pero tiene un plazo total (A2, abajo).
- **Recuperación acotada**: cada ejecución IMAP lista como máximo 300 mensajes nuevos (el resto sigue en una
  ejecución de continuación desde el último procesado, sin saltar ninguno) y solo los recibidos en los últimos
  7 días (INTERNALDATE). Los más antiguos no se descargan ni se importan: se cuentan y se informan en el log
  (`imap.sync.outside_window`) y en la auditoría de la cuenta; el cursor los deja atrás. El cambio de UIDVALIDITY
  mantiene su recuperación (300 / 7 días, `truncated` en el log). Gmail y Microsoft no cambian.

### Riesgos pendientes antes de activar IMAP

Versión objetivo de Redis / Valkey, matriz de compatibilidad de los scripts, gestión de `IMAP_RATE_LIMIT_SECRET` y
lista de activación / reversión: [`docs/imap-production-readiness.md`](imap-production-readiness.md). La instancia de
Render se consultó en modo solo lectura el 2026-10-15: Valkey 8.1.10, 256 MiB, `noeviction`, AOF activo y `ok`,
`cluster_enabled:0` (fecha UTC; sin probar: durabilidad tras reinicio, réplicas / *failover*, permisos de los
scripts). La suite opt-in se repitió con esa versión exacta en una instancia desechable (E5.3: 19/19 y 2/2, sin
fallos; resultados en la sección 7 de ese documento). `IMAP_RATE_LIMIT_SECRET` **no está configurado en
producción**; configurarlo requiere autorización específica. Mientras falte cualquier condición,
las rutas siguen en 503 (estado por defecto del código).

- **Redis / Valkey real: verificado en local (E4.1, E4.4, E5.3), no en el Redis de producción.** Las pruebas
  unitarias usan `FakeRedis`; la suite opt-in `imap-valkey-integration.test.ts` (ver "Integration tests (Valkey
  local)") se ejecutó contra Valkey 8.1.10 desechable, la misma versión observada en Render: scripts, TTL,
  atomicidad, dos procesos de API, pausa y caída. No prueba permisos de comandos, durabilidad tras reinicio ni
  *failover* en Render; repetirla si cambia la versión de Render o el código de los límites.
- **Auditoría previa a la publicación (E5.5)**: ver la sección 8 de
  [`docs/imap-production-readiness.md`](imap-production-readiness.md). A1 (respuestas IMAP sin límite de tamaño:
  límites del protocolo, arriba) y E6.3 (texto de los mensajes grandes de una sola parte) están en commits **locales**
  de la rama `feat/imap-e4-abuse-hardening` (`578cec5` y `6f8c7c3`), sin publicar ni desplegar. Antes de activar
  IMAP: M1 está en un commit local (ciclo de vida, arriba) y A2 (plazos totales por operación IMAP y huecos IMAP en la
  cola `email-events`, abajo) también; A2.1 (huecos IMAP y presupuesto en la cola `email-processing`, F1) está
  implementado en local, sin commit. El lote de recuperación de incompletos sigue siendo común (F2, abajo): requiere
  corrección o una decisión explícita antes de activar, y sigue haciendo falta un cambio de código que active
  `imapAccountsEnabled` / `imapSyncEnabled`.
- **H2 (pendiente, bajo)**: si un trabajo atrasado falla después de desconectar una cuenta IMAP, la base de datos
  queda bien (`DISCONNECTED`, `markError` no la toca), pero `handleAccountFailure` publica igualmente el evento
  realtime `email-account.status` `ERROR` y la web muestra el aviso "Una cuenta de correo necesita reconectarse"
  (la lista se refresca y enseña `DISCONNECTED`). Corregirlo exige cambiar el flujo común de errores o la semántica
  del evento (compartidos con Gmail / Microsoft): queda para revisión (`docs/imap-production-readiness.md`).
- `IMAP_RATE_LIMIT_SECRET` debe configurarse (igual en todas las instancias) antes de activar IMAP; hoy no está
  definido en ningún entorno remoto.
- Señal lateral inevitable del límite global: una organización sin fallos propios que recibe
  `IMAP_TEST_RATE_LIMITED` sabe que hubo actividad reciente contra ese buzón.
- El límite por IP y el login del portal siguen con respaldo por instancia si Redis cae (comportamiento
  previo, fuera de IMAP).
- La concurrencia de 4 por instancia es un límite de recurso local, no compartido.
- Revisión de umbrales con datos reales tras la activación (no hay tráfico IMAP todavía).

Cursor inicial: `imap:v1:<UIDVALIDITY>:<UIDNEXT − 1>` del `EXAMINE` de la prueba. Todo mensaje que llegue
después recibe un UID ≥ UIDNEXT (RFC 3501 2.3.1.1), así que el worker importa lo recibido tras la prueba y
nada anterior. Sin UIDVALIDITY o UIDNEXT válidos el alta se rechaza (`IMAP_INBOX_UNAVAILABLE`). Una
reconexión del mismo servidor y usuario conserva el cursor guardado (E1). Límite conocido: si el servidor
cambia UIDVALIDITY antes de la primera sincronización, se aplica la recuperación acotada de E2 (sin
`last_synced_at` la ventana es de 24 h antes de esa sincronización, máximo 300 mensajes).

## Worker (E2)

`apps/worker/src/providers/imap/`:

- `adapter.ts` — `createImapAdapter()` es el andamiaje que el registro usa mientras IMAP está desactivado
  (rechaza todo). `createImapSyncAdapter()` es el adaptador real, que solo se crea con el flag activo.
  Mismo contrato que Gmail / Microsoft: lista y descarga; `syncAccount` / `processEmail` hacen el resto
  (reglas, bot, clientes, entregas al portal, adjuntos, eventos).
- `connection.ts` — configuración guardada revalidada, clave del pool y el conector compartido
  (`createImapConnector` de `@emailbot/shared`) con las clases de error del worker.
- `pool.ts` — 2 conexiones por buzón, 10 por proceso, cierre a los 30 s de inactividad, `closeAll()` al
  apagar el worker. Sin IDLE: polling cada 5 minutos. A2: cada `LOGOUT` tiene 5 s; después (o si falla) el socket se
  cierra igualmente.
- `deadline.ts` (A2) — plazos **totales** de cada operación de red (ImapFlow solo tiene límites de inactividad:
  conexión 15 s, saludo 10 s, socket 60 s; un servidor que envía un byte cada pocos segundos no los dispara nunca):
  conexión nueva (DNS + TCP + saludo + STARTTLS + LOGIN) 45 s; un listado (EXAMINE + UID SEARCH + INTERNALDATE)
  120 s; un mensaje (EXAMINE + metadatos + fuente ≤ 10 MiB, o sus partes acotadas) 180 s. Cada cliente ImapFlow de
  la operación (también a mitad de la conexión, por `onClient`, y los reutilizados del *pool*) queda registrado: al
  vencer el plazo se **cierra el socket** (ImapFlow se detiene y su comando falla) y la operación falla con
  `ImapDeadlineError` (`IMAP_TIMEOUT`, transitorio): reintento con el *backoff* existente, nunca ERROR de cuenta.
  Un mensaje cuya descarga vence no se guarda y el cursor no lo salta; si vence la descarga de un adjunto de un
  correo ya guardado, el correo queda `PROCESSING` / `ATTACHMENTS_PENDING` y lo retoma la recuperación de
  incompletos (cola `email-processing`, A2.1). Los errores de autenticación, certificado, TLS y política conservan su
  clasificación. Una operación que vence esperando un hueco del *pool* no abre después ninguna conexión.
  Los plazos son **por operación**, no por trabajo: un trabajo encadena varias (un listado, una por mensaje y una
  por cada adjunto pendiente, cada una de hasta 180 s o 60 s de espera del *pool*), así que puede durar bastante
  más de 180 s; lo acota el presupuesto del trabajo: el de la sincronización (abajo) o, en `email-processing`, el
  de A2.1 (abajo).
  **Presupuesto por ejecución** (sincronización IMAP, `withImapRunBudget`): tras 8 min no se empieza ningún mensaje
  nuevo; a los 11 min se cierra toda operación IMAP aún abierta. El bloqueo de sincronización dura 15 min (sin
  renovación). Los 4 min restantes están pensados para el trabajo de base de datos de los mensajes en curso (como
  mucho 3), el avance del cursor y la liberación, pero **no son una garantía estricta**: el presupuesto no corta las
  llamadas a Supabase ni a Redis, que siguen dentro de sus propios límites (cada petición HTTP a Supabase se aborta
  a los `SUPABASE_HTTP_TIMEOUT_MS`, 60 s por defecto, y algunas se reintentan; abortar la petición no deshace lo
  que el servidor ya confirmó). Si una ejecución supera los 15 min, otra puede tomar el bloqueo y solaparse con
  ella; el compare-and-set del cursor (desde el cursor inicial y con `status = ACTIVE`), la deduplicación al
  insertar y la liberación del bloqueo solo por su dueño impiden que el cursor retroceda o salte correo, no el
  solapamiento.
  **Apagado**: `abortImapOperations()` cierra todas las operaciones IMAP y rechaza las nuevas antes de
  `worker.close()` (sus trabajos se reintentan después; ningún cursor avanza sobre correo sin procesar).
  `worker.close()` sigue esperando, sin límite propio, el trabajo de base de datos y Redis de los trabajos activos
  (comportamiento previo, común a todos los proveedores).
- Cursor por **prefijo contiguo** (A2, solo IMAP, `syncAccount`): si un mensaje falla (por ejemplo, su plazo) o el
  presupuesto detiene el lote, el cursor avanza solo hasta el UID anterior al primer mensaje no terminado
  (compare-and-set con `status = ACTIVE`); los mensajes terminados detrás de él se deduplican en la siguiente
  ejecución. Después, un fallo se relanza (reintento) y un presupuesto agotado sigue en una ejecución de
  continuación. Los mensajes fuera de la ventana se informan solo cuando el cursor los deja atrás. La pausa y la
  desconexión conservan la semántica de M1 (el cursor no avanza). Gmail y Microsoft no cambian.
- Aislamiento de concurrencia (A2): las sincronizaciones IMAP comparten la cola `email-events` (y sus
  `WORKER_EVENTS_CONCURRENCY` huecos) con Gmail y Microsoft. Cada proceso ejecuta como mucho
  `max(1, min(WORKER_IMAP_SYNC_CONCURRENCY, WORKER_EVENTS_CONCURRENCY − 1))` a la vez (2 con los valores por
  defecto, 2 y 5): con `WORKER_EVENTS_CONCURRENCY` ≥ 2 queda al menos un hueco que IMAP no puede ocupar; con
  `WORKER_EVENTS_CONCURRENCY=1` IMAP podría ocupar el único hueco, así que con IMAP activado el worker **no arranca**
  si `WORKER_EVENTS_CONCURRENCY` o `WORKER_PROCESSING_CONCURRENCY` es menor que 2 (`assertImapWorkerConcurrency`,
  error de configuración que nombra la variable; con IMAP desactivado, 1 sigue siendo válido). Los huecos son por
  proceso. Un
  `SYNC_ACCOUNT` IMAP que no encuentra hueco vuelve a `delayed` con su propio *token* (15–20 s): libera su hueco de
  BullMQ al momento, no gasta intentos, conserva su id (la coalescencia lo sigue viendo pendiente) y no toca nada.
  No hay cola ni motor IMAP paralelo. Verificado con BullMQ real (`imap-a2-isolation.test.ts`, opt-in): con 6
  buzones IMAP saturados, 20 sincronizaciones Gmail / Microsoft terminan; sin los huecos (control) no avanza ninguna.
  Esto solo cubre la cola `email-events`.
- **Recuperación de correos incompletos en `email-processing` (A2.1, F1; implementado en local, sin commit)**: la
  recuperación (`RECOVER_INCOMPLETE`, cada 10 min) encola en esa cola los correos IMAP que quedaron a medias (por
  ejemplo `ATTACHMENTS_PENDING` tras vencer el plazo de un adjunto). Cada trabajo hace una operación por el mensaje y
  otra por cada adjunto pendiente, en serie y sin tope en el número de adjuntos; antes de A2.1 podía ocupar su hueco
  unos (1 + adjuntos) × 180 s, y trabajos IMAP lentos podían ocupar los **diez** huecos de
  `WORKER_PROCESSING_CONCURRENCY` y retrasar la reanudación de correos de Gmail / Microsoft. Ahora, solo para los
  trabajos cuyo `provider` es `IMAP` (lo fija `RECOVER_INCOMPLETE` desde `email_accounts.provider`):
  - huecos propios por proceso, `max(1, min(WORKER_IMAP_PROCESSING_CONCURRENCY, WORKER_PROCESSING_CONCURRENCY − 1))`
    (2 con los valores por defecto, 2 y 10; con IMAP activado, `WORKER_PROCESSING_CONCURRENCY` menor que 2 impide
    arrancar el worker, porque no quedaría ningún hueco reservado). Un
    trabajo que no encuentra hueco vuelve a `delayed` con su propio *token* (15–20 s), como en `email-events`: libera
    su hueco de BullMQ, no gasta intentos, conserva su id y no toca nada. Si BullMQ rechaza el movimiento (por
    ejemplo, bloqueo perdido), ese error falla el trabajo como cualquier otro;
  - presupuesto del trabajo (`IMAP_PROCESSING_BUDGET`), con tres límites distintos contados desde que el trabajo
    toma su hueco:
    - **inicio (6 min)**: después no empieza ninguna operación IMAP; una operación que aún esperaba conexión del
      *pool* tampoco la abre ni la usa. Los adjuntos que no empezaron quedan pendientes (ni se consultan en Storage),
      salvo los del mensaje que el trabajo ya tiene en memoria (abajo), que no necesitan ninguna operación;
    - **plazo de cada operación** (`IMAP_OPERATION_DEADLINES`: 180 s un mensaje o un adjunto, con su conexión):
      una operación empezada antes del inicio dispone de su plazo completo, el límite duro nunca lo recorta;
    - **límite duro (9 min)**: toda operación IMAP del trabajo aún abierta se cierra (socket destruido; su rechazo
      tardío se consume).
    **No** es la duración máxima del trabajo: después de una operación sigue el trabajo de base de datos, Storage
    y Redis (guardar contenidos, estados, avisos), cada llamada acotada solo por su propio plazo (por ejemplo
    `SUPABASE_HTTP_TIMEOUT_MS`, 60 s, con reintentos en Storage). Si quedan contenidos pendientes, el correo sigue
    `PROCESSING` / `ATTACHMENTS_PENDING` (nunca `PROCESSED`) y el reintento de BullMQ, con la política de siempre,
    lo retoma: solo guarda los contenidos que faltan (nada duplicado). El cursor de sincronización no se toca;
  - **reutilización del mensaje** (`message-scope.ts`): dentro de un trabajo, el mensaje que el adaptador ya leyó
    (al procesarlo, o en la primera descarga de un adjunto) sirve las demás descargas de adjuntos de ese mismo
    mensaje sin volver a leerlo del servidor. Antes cada adjunto volvía a leer el mensaje entero (hasta 10 MiB):
    con un servidor lento, un correo con muchos adjuntos podía agotar los 25 intentos de la recuperación y quedar
    `FAILED` con contenidos sin guardar (en el caso extremo, sin ninguno). Ahora un mensaje que se puede leer
    dentro de su plazo guarda todos sus adjuntos en el mismo intento. Alcance: un solo trabajo y un solo mensaje,
    identificado por cuenta + UIDVALIDITY + UID (nunca otra cuenta, otra generación del buzón u otro UID); se
    vacía al terminar el trabajo (éxito, fallo, presupuesto o apagado) y nunca guarda el resultado tardío de una
    operación ya vencida. Memoria: como mucho un mensaje (≤ 10 MiB, `IMAP_MAX_MESSAGE_BYTES`; tras la primera
    extracción solo sus adjuntos decodificados, que ocupan como mucho lo mismo) por trabajo IMAP de esta cola, es
    decir, ≤ 10 MiB × `WORKER_IMAP_PROCESSING_CONCURRENCY` por proceso (20 MiB con el valor por defecto), más el
    análisis MIME transitorio. Las sincronizaciones (`email-events`) no reutilizan: allí cada adjunto sigue leyendo
    el mensaje, y lo que no quepa en su presupuesto queda pendiente para esta recuperación;
  - un buzón pausado o desconectado sigue sin abrir conexión (M1: el trabajo se descarta al empezar). Una pausa
    durante el trabajo no lo detiene; lo acota el presupuesto. El apagado cierra las operaciones y no deja empezar
    otras; los huecos y la memoria del mensaje se liberan al terminar cada trabajo.
  Gmail / Microsoft no pasan por ese código. Verificado con BullMQ real (`imap-a2-1-processing-isolation.test.ts`,
  opt-in): con 10 trabajos IMAP saturados, 2 ocupan sus huecos, 8 vuelven a `delayed` con 0 intentos y los 20
  trabajos de Gmail / Microsoft terminan como sin IMAP; sin los huecos (control, igual que
  `imap-a2-processing-risk.test.ts`) no avanza ninguno; un trabajo con 30 adjuntos cuya lectura se cuelga ocupa su
  hueco hasta el límite duro y el reintento guarda los 30 leyendo el mensaje una sola vez. Si un trabajo lleva un `provider` distinto del de su cuenta,
  no usa estos huecos (solo lo produce `RECOVER_INCOMPLETE`, desde la base de datos).
- **Pendiente antes de activar IMAP (F2, fuera de A2 y A2.1)**: el lote de recuperación toma los 100 correos
  incompletos más antiguos de todos los proveedores (`processing_started_at` no cambia al reanudar): correos IMAP
  atascados pueden llenarlo e impedir que se encolen y recuperen los incompletos de Gmail / Microsoft. A2.1 no lo
  resuelve (limita cuántos trabajos IMAP se ejecutan, no cuántos entran en el lote). Mientras `imapSyncEnabled` sea
  `false` no hay exposición (`processEmail` descarta los correos IMAP sin conectar). Requiere corrección o una
  decisión explícita antes de activar IMAP; corregirlo cambia la política de recuperación, común a Gmail / Microsoft.
- Pruebas opt-in de A2 / A2.1 con BullMQ real (`imap-a2-isolation.test.ts`, `imap-a2-processing-risk.test.ts`,
  `imap-a2-1-processing-isolation.test.ts`): solo con
  `A2_BULLMQ_URL` hacia un Valkey **desechable** en esta máquina (la guarda de E4.4 rechaza todo lo que no sea TCP
  a loopback). Ambas vacían la base de datos entre escenarios: antes comprueban que estaba vacía al empezar (o que
  es suya) y que ninguna otra suite la usa; si no, fallan sin tocar nada. Se ejecutan **en serie**:
  `pnpm exec vitest run src/test/imap-a2-isolation.test.ts src/test/imap-a2-processing-risk.test.ts
  src/test/imap-a2-1-processing-isolation.test.ts --no-file-parallelism`. Nunca contra un Redis / Valkey compartido, de desarrollo o de producción. Sin la
  variable (CI) se omiten.
- `cursor.ts` — reexporta el cursor compartido (`imap:v1:<UIDVALIDITY>:<UID>`, id `<UIDVALIDITY>:<UID>`).
- `normalize.ts` — MIME con `postal-mime` (límites de partes, anidamiento y cabeceras; cuerpos de hasta
  1 000 000 caracteres). Un mensaje que no se puede analizar produce un correo mínimo desde el sobre IMAP
  (nunca bloquea el buzón). El snippet de un correo solo HTML se calcula con `htmlToText` del motor de
  reglas (expresiones lineales) sobre un prefijo de 64 KB sin etiqueta cortada: el HTML del remitente
  nunca llega entero a una expresión regular.
- `errors.ts` — traduce `classifyImapFailure` a las clases del worker: login rechazado → `ProviderAuthError` (ERROR, sin reintento); destino prohibido,
  certificado, TLS, STARTTLS ausente o configuración inválida → `ProviderSecurityError` (ERROR, sin
  reintento); DNS, timeout, red → `ProviderTransientError` (reintentos de BullMQ, acotados). Mensajes
  genéricos: nunca IP, host, usuario ni texto del servidor.
  ImapFlow marca `tlsFailed` en **cualquier** error de la mejora STARTTLS. Orden de clasificación:
  1. código de certificado o TLS (`CERT_*`, `*_SELF_SIGNED_*`, `ERR_TLS_*`, `ERR_SSL_*`, `EPROTO`…) →
     seguridad;
  2. `tlsFailed` con un código de red conocido (`ECONNRESET`, `ETIMEDOUT`, `UPGRADE_TIMEOUT`, `EPIPE`,
     conexión cerrada…) → transitorio;
  3. `tlsFailed` sin código (el servidor no ofrece STARTTLS) → seguridad `IMAP_STARTTLS_UNAVAILABLE`;
  4. `tlsFailed` con cualquier otro código (`STARTTLS_INJECTION`, códigos TLS desconocidos) → seguridad.

  Los casos ambiguos fallan cerrados (cuenta en ERROR, sin reintento) y nunca hay reintento en texto plano.
  Un corte de red durante el handshake se reintenta (acotado) en lugar de dejar la cuenta en ERROR.

Comportamiento:

- Solo INBOX, abierto con EXAMINE (solo lectura); los mensajes se leen con `BODY.PEEK[]`: nada se marca
  `\Seen` ni se modifica. Una conexión reutilizada sale del buzón (CLOSE, que en solo lectura no borra
  nada) antes de volver a examinarlo, para ver el UIDNEXT / UIDVALIDITY actuales.
- Sin cursor (o ilegible): la primera pasada solo registra el UID más reciente; no se importa historial.
- Máximo 200 mensajes por pasada (`hasMore`). Si cambia UIDVALIDITY: `historyGap` y la recuperación
  acotada existente (desde la última sincronización − 1 h, o 24 h sin sincronización previa; como
  máximo 7 días y 300 mensajes).
  - `SEARCH SINCE` solo compara la **fecha** de cada INTERNALDATE en su propia zona horaria (RFC 3501) e
    ImapFlow envía la fecha UTC. Por eso se busca desde 2 días antes y después se filtra por el
    INTERNALDATE exacto (`>= since`): no se pierde un correo recibido a las 22:00 en UTC−5 tras una
    sincronización a medianoche UTC, ni se importa historial anterior.
  - Límites que se mantienen: como máximo los 300 más recientes (`truncated` queda en el log; los más
    antiguos no se recuperan) y una ventana de 7 días. Un servidor con INTERNALDATE erróneo puede dejar
    fuera un mensaje.
  - Deduplicación: siempre por `(cuenta, provider_message_id)` (`<UIDVALIDITY>:<UID>`). **Solo** en esa
    recuperación IMAP, además, un mensaje con el mismo Message-ID **y** el mismo `received_at`
    (INTERNALDATE) que uno ya guardado se considera el mismo correo renumerado y se omite. Dos correos
    distintos con el mismo Message-ID (remitentes que lo reutilizan) se guardan ambos. Gmail y Microsoft
    no cambian (sus trabajos nunca llevan la marca de recuperación).
- Mensajes > 10 MB: cabeceras y partes de texto acotadas; los adjuntos se listan sin descarga. El texto se lee
  en trozos parciales de 64 KiB (`BODY.PEEK`, nunca el mensaje completo) hasta 4 MB y se recorta a 1 000 000
  caracteres. En un mensaje de una sola parte (`text/plain` o `text/html`) la raíz no tiene número de parte en
  ImapFlow: se pide como parte `1`, que ImapFlow lee como `TEXT` (E6.3). Si todo el mensaje es un adjunto, se lista
  igualmente sin descarga.
- Credenciales: `getImapCredentials()` descifra con `SecretBox.decryptBound` y el contexto
  (organización, dirección). Un valor v1 antiguo o ajeno falla con `CREDENTIALS_UNREADABLE`. Las cuentas
  IMAP no tienen token OAuth (`getAccessToken()` las rechaza).
- Solo cuentas ACTIVE de organizaciones ACTIVE con acceso comercial; PAUSED / DISCONNECTED / ERROR nunca
  abren conexión.

## Integration tests (Valkey local)

`apps/api/src/test/imap-valkey-integration.test.ts` es **opt-in** (sin `IMAP_VALKEY_URL` todo queda *skipped*;
la CI no lo define) y **solo** debe apuntar a un Valkey / Redis desechable de esta máquina: lee y escribe sus
claves (`KEYS`, `DEL`) y ejecuta `CLIENT PAUSE`.

**Guard (`apps/api/src/test/valkey-target.ts`).** El test y su proceso auxiliar validan `IMAP_VALKEY_URL` antes
de crear cualquier cliente y luego la usan sin modificarla. Solo se acepta, sobre TCP:

`redis://[usuario:contraseña@]<127.0.0.1 | localhost | [::1]>[:puerto][/db]` (o `rediss://` con la misma forma).

Se rechaza, sin conectar ni resolver nada y sin mostrar la URL ni sus credenciales en el error: cualquier otro
esquema (ioredis 5.11.1 reinterpreta `x://localhost:1` como host `x` con la ruta de *pipe* `//localhost:1`),
parámetros de consulta (`?path=//host/pipe` se convierte en una ruta de *pipe*, una ruta de red en Windows),
fragmentos, rutas, otros hosts o direcciones (incluidas `127.0.0.2`, `0.0.0.0`, `[::]`, IPv4 mapeadas, formas
decimales / hexadecimales / codificadas, `localhost.`, mayúsculas: `redis:` no normaliza el host), espacios,
caracteres de control y barras invertidas. Después de esa forma estricta se comprueba también el resultado del
propio `parseURL` de ioredis: solo `host` de loopback, `port`, `username`, `password` y `db`; nunca `path`.
`valkey-target.test.ts` (suite normal, sin red) lo prueba con 48 entradas y verifica, interceptando y bloqueando
conexiones, DNS y *pipes* en el mismo proceso y en procesos hijos (`net-block-hook.cjs`), que las rechazadas no
abren nada, con controles positivos que sí detectan el intento contra un puerto de loopback cerrado y el *pipe* de
una URL no validada. Lanza dos procesos de API independientes (`imap-valkey-process.ts`, `node --import tsx`) con el
limitador real y el cliente de producción (`createRedisConnection`), que solo comparten ese servidor; DNS e IMAP
son simulados (ningún socket hacia servidores de correo).

- `IMAP_VALKEY_PHASE=up` (por defecto): scripts Lua contra el servidor real (valores, TTL, caducidad, errores),
  atomicidad con 200 / 100 / 50 / 25 llamadas simultáneas, claves HMAC compartidas entre procesos, rotación,
  presupuesto global y hueco por organización con concurrencia entre procesos, contadores compartidos,
  distinción de fallos, caducidad (acortando el TTL de una clave **en ese servidor desechable**), `CLIENT PAUSE`
  (503 en el plazo de 2 s, sin DNS ni sockets), clave corrupta (503), logs sin secretos, y las rutas con el
  cliente real (desactivadas: 503 `IMAP_NOT_AVAILABLE` sin escribir claves; activadas solo en la configuración
  de test).
- `IMAP_VALKEY_PHASE=down` con el servidor detenido: 503 inmediato en dos procesos y en la ruta, sin DNS,
  sockets, cifrado, persistencia ni colas.

Ejemplo (Docker en WSL; publicado solo en `127.0.0.1`, sin persistencia, contraseña aleatoria de prueba):

```bash
docker network create --label emailbot-e41=1 -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 emailbot-e41-valkey-net
docker run -d --name emailbot-e41-valkey --label emailbot-e41=1 --network emailbot-e41-valkey-net -p 127.0.0.1:56379:6379 --tmpfs /data valkey/valkey:8 valkey-server --requirepass "$VALKEY_TEST_PASSWORD" --save "" --appendonly no
IMAP_VALKEY_URL="redis://:$VALKEY_TEST_PASSWORD@127.0.0.1:56379" pnpm --filter @emailbot/api exec vitest run src/test/imap-valkey-integration.test.ts
docker stop emailbot-e41-valkey
IMAP_VALKEY_URL="redis://:$VALKEY_TEST_PASSWORD@127.0.0.1:56379" IMAP_VALKEY_PHASE=down pnpm --filter @emailbot/api exec vitest run src/test/imap-valkey-integration.test.ts
docker rm emailbot-e41-valkey && docker network rm emailbot-e41-valkey-net
```

## Integration tests (Dovecot local)

`apps/worker/src/test/imap-integration.test.ts` (worker) y `apps/api/src/test/imap-api-integration.test.ts`
(prueba de conexión y alta de la API, E3) son **opt-in**: sin `IMAP_INTEGRATION_SCENARIO` todos sus tests
aparecen como *skipped* (nunca como aprobados). `pnpm test` y la CI no lo definen, así que **la CI
no ejecuta pruebas contra Dovecot**. Con un escenario inválido o sin `IMAP_TEST_PASSWORD` el archivo falla
en lugar de omitirse en silencio.

Usa el conector de producción sin cambios; un hook a nivel de socket registra el destino TCP real (la IP
validada) y solo después lo redirige al Dovecot local. La CA de prueba se confía con
`NODE_EXTRA_CA_CERTS` solo en ese proceso (nunca en las opciones de conexión).

Requisitos: Docker y la imagen `dovecot/dovecot:2.4.5` (el script no la descarga por su cuenta; `docker
run` la traería si falta), `openssl` y `bash`. Puertos 993 y 143 de `127.0.0.1` libres.

El test invoca `apps/worker/scripts/imap-integration-dovecot.sh` (comandos `uidvalidity`, `flags`). La ruta
se resuelve sola desde el paquete (funciona desde la raíz del monorepo o desde `apps/worker`);
`IMAP_E2_SCRIPT` solo hace falta para usar otro script (absoluta o relativa al directorio actual).
`$IMAP_E2_WORK` es el directorio de certificados y contraseña de prueba (por defecto
`${TMPDIR:-/tmp}/emailbot-imap-e2`, siempre fuera del repositorio). `paths` muestra ambas rutas sin crear
nada.

### Linux / macOS (Docker nativo)

```bash
export IMAP_E2_WORK="${TMPDIR:-/tmp}/emailbot-imap-e2"
bash apps/worker/scripts/imap-integration-dovecot.sh certs
bash apps/worker/scripts/imap-integration-dovecot.sh start A
IMAP_INTEGRATION_SCENARIO=A IMAP_TEST_PASSWORD="$(cat "$IMAP_E2_WORK/password.txt")" NODE_EXTRA_CA_CERTS="$IMAP_E2_WORK/ca.pem" pnpm --filter @emailbot/worker exec vitest run src/test/imap-integration.test.ts
```

El test del worker ejecuta el script con `bash`. El de la API no lo usa: misma variable y mismo comando
con `pnpm --filter @emailbot/api exec vitest run src/test/imap-api-integration.test.ts`.

### Windows (Docker dentro de WSL)

El test ejecuta el script con `wsl.exe -e env IMAP_E2_WORK=<ruta WSL> bash <ruta WSL del script>`:
convierte las rutas `C:\...` a `/mnt/c/...` y pasa `IMAP_E2_WORK` de forma explícita (`wsl.exe` no
reenvía variables de entorno). `$IMAP_E2_WORK` debe estar en una unidad de Windows para que el proceso
Node (Windows) pueda leer `ca.pem`. Por ejemplo, con `C:\Temp\emailbot-imap-e2`:

```bash
wsl.exe -e env IMAP_E2_WORK=/mnt/c/Temp/emailbot-imap-e2 bash apps/worker/scripts/imap-integration-dovecot.sh certs
```

```bash
wsl.exe -e env IMAP_E2_WORK=/mnt/c/Temp/emailbot-imap-e2 bash apps/worker/scripts/imap-integration-dovecot.sh start A
```

Y el test desde PowerShell:

```powershell
$env:IMAP_E2_WORK = "C:\Temp\emailbot-imap-e2"; $env:IMAP_INTEGRATION_SCENARIO = "A"; $env:IMAP_TEST_PASSWORD = (Get-Content "$env:IMAP_E2_WORK\password.txt"); $env:NODE_EXTRA_CA_CERTS = "$env:IMAP_E2_WORK\ca.pem"; pnpm --filter @emailbot/worker exec vitest run src/test/imap-integration.test.ts
```

Desde **Git Bash**, MSYS reescribe los valores con forma de ruta POSIX en las variables de entorno
(`/mnt/c/x` pasa a `C:/Program Files/Git/mnt/c/x`) y en los argumentos de `wsl.exe`. Usa rutas Windows
(`C:/Temp/...`) en las variables, o antepone `MSYS_NO_PATHCONV=1` a la orden (y
`MSYS2_ENV_CONV_EXCL=IMAP_E2_SCRIPT` si pasas una ruta POSIX en `IMAP_E2_SCRIPT`). El test deshace la forma
reescrita habitual, pero conviene no depender de ello.

El script se guarda con finales de línea LF (`apps/worker/scripts/.gitattributes`); con CRLF `bash`
fallaría dentro de WSL.

### Escenarios y limpieza

A (certificado válido de la CA de prueba), B (certificado autofirmado no confiable) y C (sin TLS ni
STARTTLS), uno cada vez: `start <A|B|C>` y el test con el mismo `IMAP_INTEGRATION_SCENARIO`. Al terminar,
`stop` (solo contenedores con la etiqueta `emailbot-imap-e2=1`, con sus volúmenes anónimos: `docker rm -f -v`) y
`clean` (borra `$IMAP_E2_WORK`).
