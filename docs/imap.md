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

### Riesgos pendientes antes de activar IMAP

- **Redis / Valkey real: verificado en local (E4.1), no en el Redis de producción.** Las pruebas unitarias usan
  `FakeRedis`; la suite opt-in `imap-valkey-integration.test.ts` (ver "Integration tests (Valkey local)") se
  ejecutó contra Valkey 8.1.10 desechable: scripts, TTL, atomicidad, dos procesos de API, pausa y caída. El
  Redis gestionado de producción puede ser otra versión: repetir la suite contra una instancia equivalente y
  desechable antes de activar IMAP.
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
  apagar el worker. Sin IDLE: polling cada 5 minutos.
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
- Mensajes > 10 MB: cabeceras y partes de texto acotadas; los adjuntos se listan sin descarga.
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
