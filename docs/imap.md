# IMAP (correo externo)

Estado: **desactivado**. La API responde 503 al alta (`imapAccountsEnabled: false`) y el worker no
sincroniza IMAP (`imapSyncEnabled: false`, fijo en código, sin variable de entorno). Ningún buzón IMAP
se conecta en producción hasta que un cambio de código lo active.

| Fase | Contenido | Estado |
|---|---|---|
| E1 | Permisos de `email_accounts`, función atómica `connect_imap_email_account`, entitlement `IMAP` (PRO, BUSINESS), protección SSRF (`@emailbot/shared` `imap-destination.ts`), TLS obligatorio, `SecretBox` v2 | hecho |
| E2 | Adaptador IMAP del worker (este documento) | hecho, desactivado |
| E3 | Endpoint de alta / prueba de conexión / reconexión | pendiente |
| E4 | Formulario web | pendiente |

## Worker (E2)

`apps/worker/src/providers/imap/`:

- `adapter.ts` — `createImapAdapter()` es el andamiaje que el registro usa mientras IMAP está desactivado
  (rechaza todo). `createImapSyncAdapter()` es el adaptador real, que solo se crea con el flag activo.
  Mismo contrato que Gmail / Microsoft: lista y descarga; `syncAccount` / `processEmail` hacen el resto
  (reglas, bot, clientes, entregas al portal, adjuntos, eventos).
- `connection.ts` — cada conexión nueva: configuración guardada revalidada → `resolveImapDestination`
  (todas las A/AAAA públicas) → `imapConnectionOptions` (host = IP literal validada, `servername` = nombre
  DNS, certificado verificado, TLS ≥ 1.2, STARTTLS obligatorio en 143, sin proxy) →
  `assertSafeImapConnectionOptions` → ImapFlow. Si la primera IP validada no responde se prueba la segunda
  (nunca tras un fallo TLS o de login).
- `pool.ts` — 2 conexiones por buzón, 10 por proceso, cierre a los 30 s de inactividad, `closeAll()` al
  apagar el worker. Sin IDLE: polling cada 5 minutos.
- `cursor.ts` — cursor `imap:v1:<UIDVALIDITY>:<UID>`, id de mensaje `<UIDVALIDITY>:<UID>`.
- `normalize.ts` — MIME con `postal-mime` (límites de partes, anidamiento y cabeceras; cuerpos de hasta
  1 000 000 caracteres). Un mensaje que no se puede analizar produce un correo mínimo desde el sobre IMAP
  (nunca bloquea el buzón). El snippet de un correo solo HTML se calcula con `htmlToText` del motor de
  reglas (expresiones lineales) sobre un prefijo de 64 KB sin etiqueta cortada: el HTML del remitente
  nunca llega entero a una expresión regular.
- `errors.ts` — login rechazado → `ProviderAuthError` (ERROR, sin reintento); destino prohibido,
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

## Integration tests (Dovecot local)

`apps/worker/src/test/imap-integration.test.ts` es **opt-in**: sin `IMAP_INTEGRATION_SCENARIO` todos sus
tests aparecen como *skipped* (nunca como aprobados). `pnpm test` y la CI no lo definen, así que **la CI
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

El test ejecuta el script con `bash`.

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
`stop` (solo contenedores con la etiqueta `emailbot-imap-e2=1`) y `clean` (borra `$IMAP_E2_WORK`).
