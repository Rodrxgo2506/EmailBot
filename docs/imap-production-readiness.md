# IMAP — preparación para producción (E5)

Estado: **IMAP desactivado** (`imapAccountsEnabled: false` en la API e `imapSyncEnabled: false` en el worker, fijos
en código; las dos rutas IMAP responden `503 IMAP_NOT_AVAILABLE`). Este documento prepara una activación futura
**autorizada**; no activa nada. Base: commits locales E3 `445f854`, E4 `c9585f2`, E4.4 `f7f7288`, A1 `578cec5` y
E6.3 `6f8c7c3` (rama `feat/imap-e4-abuse-hardening`; ninguno publicado ni desplegado). Diseño de los límites:
[`docs/imap.md`](imap.md). Resultado de la suite opt-in contra Valkey 8.1.10 desechable (E5.3): sección 7. Auditoría
previa a la publicación y plan de publicación (E5.5): sección 8.

## 1. Redis / Valkey objetivo

Servicio: Render Key Value, **una instancia compartida** con BullMQ, realtime, rate limit, nonces OAuth y bloqueos de
login (`docs/render.md`, `docs/operations.md`).

### Consulta real en Render (E5.2, 2026-10-15)

- **Método:** el usuario ejecutó una vez, desde el *shell* de `emailbot-api` en Render (red privada), un comando de
  solo lectura (`INFO server`, `INFO memory`, `INFO persistence` e `INFO cluster` con la conexión `REDIS_URL` de la
  API, sin imprimirla) que solo muestra los campos de la tabla. Ningún comando de escritura, `KEYS`, `SCAN`,
  `CONFIG` ni `MONITOR`. Esta sesión no se conectó a Render ni a Redis (intento previo E5.1, 2026-10-14: sin acceso
  autenticado). No se registra la salida completa, la URL, el host, el puerto ni identificadores del servicio.
- **Fecha:** 2026-10-15 es la fecha **UTC** de la consulta. Evidencia local: `rdb_last_save_time` de la propia
  salida es 2026-10-15 01:39:17 UTC y los resultados se registraron en esta sesión hacia las 01:40 UTC; en la zona
  de la máquina local (Lima, UTC−5) eso corresponde al 2026-10-14 hacia las 20:39. No es una contradicción con el
  entorno (2026-10-14, hora local): es el mismo momento en otra zona horaria. Las demás fechas no se han cambiado.

| Campo | Valor observado | Interpretación | Limitaciones |
|---|---|---|---|
| `server_name` / `valkey_version` | `valkey` / `8.1.10` | el servidor es **Valkey 8.1.10** (no Redis estándar) | — |
| `redis_version` | `7.2.4` | nivel de compatibilidad con Redis que declara Valkey | no es la versión del servidor |
| `maxmemory` | `268435456` | **256 MiB** (268 435 456 B) | coincide con el plan de 256 MB; el uso actual no se consultó |
| `maxmemory_policy` | `noeviction` | Valkey no expulsa claves: al llenarse, las escrituras fallan (los límites IMAP responden 503, BullMQ falla), nunca se borran contadores en silencio | configuración en el momento de la consulta; puede cambiarse en el panel: revisar antes de activar |
| `loading` | `0` | no estaba cargando datos de disco | — |
| `aof_enabled` | `1` | AOF activo | — |
| `aof_last_write_status` / `aof_last_bgrewrite_status` / `aof_rewrite_in_progress` | `ok` / `ok` / `0` | las últimas escrituras y reescrituras de AOF terminaron bien | estado reportado; **la durabilidad real tras un reinicio no se ha probado** |
| `rdb_last_bgsave_status` / `rdb_bgsave_in_progress` | `ok` / `0` | el último *snapshot* RDB terminó bien | ídem |
| `rdb_last_save_time` / `rdb_changes_since_last_save` | `1792028357` (2026-10-15 01:39:17 UTC) / `0` | *snapshot* reciente, sin cambios pendientes en ese instante | foto de un momento |
| `cluster_enabled` | `0` | **modo Redis Cluster deshabilitado** en el servidor consultado: los scripts de dos claves no darían `CROSSSLOT` | no demuestra la ausencia de réplicas ni de *failover* gestionado por Render; la topología gestionada más amplia sigue sin confirmar |
| `redis_mode` | **no apareció** en la salida | — | el comando lo filtraba; Valkey 8.1 puede no exponerlo con ese nombre. La topología se apoya solo en `cluster_enabled:0` |

**No verificado:** permisos de `EVAL` y del resto de comandos usados por los scripts en esa instancia (indicio: el
rate limit por IP y el bloqueo del portal ya los usan en producción, pero un fallo pasaría a contadores locales con
solo un aviso en el log), `CLIENT SETNAME`, réplicas / *failover*, durabilidad tras reinicio, uso real de memoria.
Conocer la versión **no valida** la compatibilidad en producción: la suite opt-in pasó contra una Valkey **8.1.10
local y desechable** (misma versión) en E4.4 y de nuevo en E5.3 (sección 7), lo que no sustituye las comprobaciones
anteriores en la instancia real.

Comando ejecutado (solo lectura; si falla, solo el tipo de error, nunca la URL):

```bash
node -e "let R;try{R=require(require.resolve('ioredis',{paths:['/repo/apps/api',process.cwd()]}))}catch(e){console.log('ioredis not found');process.exit(1)}const u=process.env.REDIS_URL;if(u===undefined||u===''){console.log('REDIS_URL not set');process.exit(1)}const r=new R(u,{lazyConnect:true,connectTimeout:5000,maxRetriesPerRequest:1,retryStrategy:()=>null,enableReadyCheck:false});r.on('error',()=>{});const keep=/^(server_name|valkey_version|redis_version|redis_mode|maxmemory|maxmemory_policy|loading|aof_enabled|aof_rewrite_in_progress|aof_last_write_status|aof_last_bgrewrite_status|rdb_bgsave_in_progress|rdb_last_bgsave_status|rdb_changes_since_last_save|rdb_last_save_time|cluster_enabled):/;const t=setTimeout(()=>{console.log('timeout');process.exit(1)},15000);r.connect().then(()=>Promise.all(['server','memory','persistence','cluster'].map(s=>r.info(s).catch(e=>'# '+s+' unavailable: '+(e&&e.name))))).then(a=>console.log(a.join('\n').split(/\r?\n/).filter(l=>keep.test(l)||l.indexOf(' unavailable: ')>0).join('\n'))).catch(e=>console.log('connection failed:',e&&e.name)).finally(()=>{clearTimeout(t);r.disconnect()})"
```

## 2. Matriz de compatibilidad de los scripts Lua

Todos se ejecutan con `EVAL` (no `EVALSHA`), sin `TIME`, sin acceso a claves no declaradas, con valores enteros
como texto (`INCR` / `DECR` sobre cadenas) y TTL en milisegundos. Comandos usados en total: `EVAL`, `INCR`, `DECR`,
`GET`, `PTTL`, `PEXPIRE`, `SET … PX`, `DEL`.

| Script | Uso | Claves / ARGV | Comandos | TTL / expiración | Atomicidad necesaria | Ante error | Probado en Valkey 8.1.10 local (E4.1 / E4.4 / E5.3) | Producción (Valkey 8.1.10 observado) |
|---|---|---|---|---|---|---|---|---|
| `INCR_SCRIPT` (`rate-limit-store.ts`) | rate limit por IP (**ya en producción**) e intentos IMAP por usuario / organización | 1 clave; ARGV ventana ms | `INCR`, `PTTL`, `PEXPIRE` | fija la ventana en el primer `INCR` (o si falta TTL) | sí: contador + ventana | por IP: respaldo local; IMAP: 503 | crea, incrementa, caduca; 50 llamadas simultáneas = 50 valores distintos | misma versión; ya se ejecuta allí, pero un fallo sería silencioso (respaldo local + log `rate limit store unavailable`): no comprobado directamente |
| `FAIL_SCRIPT` (`login-throttle.ts`) | bloqueo del portal (**ya en producción**) y logins IMAP rechazados | **2 claves** (`fail:`, `lock:`); ARGV ventana, máximo, bloqueo ms | `INCR`, `PEXPIRE`, `SET … PX`, `DEL` | ventana en el primer fallo; bloqueo con `PX` | sí: contar, bloquear y reiniciar juntos | portal: respaldo local; IMAP: 503 | 9 fallos cuentan, el 10.º bloquea y borra el contador; 25 simultáneos = 2 bloqueos exactos | `cluster_enabled:0`: sin `CROSSSLOT` hoy; **si algún día hubiera Redis Cluster**, fallaría (las claves no llevan *hash tag*) → IMAP 503, portal a respaldo local |
| `LOCK_TTL_SCRIPT` | ¿bloqueado? | 1 clave | `PTTL` | solo lee | no | ídem | TTL > 0 si bloqueado, 0 si no | misma versión; permisos no comprobados |
| `RESET_SCRIPT` | login correcto | 1 clave | `DEL` | — | no | ídem | borra el contador | misma versión; permisos no comprobados |
| `RESERVE_SCRIPT` (`imap-connection.ts`, **nuevo E4**) | límite global por buzón externo (30 / 15 min) | 1 clave; ARGV ventana, máximo | `INCR`, `PTTL`, `PEXPIRE`, `DECR` | ventana fija desde la primera reserva | **sí**: nunca superar el máximo | 503 (sin conexión) | 200 simultáneas con máximo 30 = exactamente 30; el rechazo no deja rastro; caduca | misma versión; **nunca ejecutado en producción** (IMAP desactivado) |
| `RELEASE_SCRIPT` (**nuevo E4**) | devolver reserva / liberar hueco | 1 clave | `GET`, `DECR` | conserva el TTL | sí: nunca bajo cero | registrado, no cambia la respuesta | nunca crea la clave ni baja de 0 | ídem |
| `ACQUIRE_SLOT_SCRIPT` (**nuevo E4**) | 1 prueba concurrente por organización | 1 clave; ARGV máximo, *lease* ms | `INCR`, `DECR`, `PTTL`, `PEXPIRE` | *lease* de 90 s renovado al adquirir | **sí** | 503 | 100 simultáneas con máximo 1 = exactamente 1; el *lease* libera | ídem |

Probado además contra Valkey 8.1.10 local (E4.4 y E5.3) con dos procesos de API independientes: claves HMAC
iguales con el mismo secreto, bloqueos compartidos, rotación, presupuesto global exacto bajo concurrencia, hueco
por organización, contadores atómicos, distinción de fallos, caducidad, `CLIENT PAUSE` (503 en ~2 s), clave
corrupta (503) y Valkey detenido (503 inmediato, sin DNS ni sockets). Ningún script se ha ejecutado contra la
instancia de producción.

## 3. Límites distribuidos: revisión

Límites de **seguridad** (compartidos en Redis, fallan cerrados con 503): intentos por usuario (10 / 10 min) y por
organización (20 / 10 min), bloqueo por buzón (10 / 15 min) y por organización (30 / 15 min), límite global por
buzón externo (30 / 15 min), hueco de concurrencia por organización (1, *lease* 90 s).
Límites de **recursos** (locales a cada instancia): 4 pruebas simultáneas por instancia; límite por IP de la ruta
(con respaldo local si Redis falla, comportamiento previo de toda la API).

No se cambia ningún umbral. Casos de borde documentados (sin explotación que permita superar los límites):

| Caso | Efecto | Severidad | Corrección propuesta (sin aplicar) |
|---|---|---|---|
| `maxmemory_policy` distinta de `noeviction` | Redis podría expulsar contadores, bloqueos o reservas → los límites se reiniciarían (además de romper BullMQ) | **alta si ocurre**; hoy `noeviction` (observado 2026-10-15) | repetir la consulta de la sección 1 antes de activar (la política se cambia en el panel) |
| Reinicio de Redis con pérdida de datos | contadores y bloqueos vuelven a cero (como mucho una ventana de 15 min de margen) | baja-media: AOF activo y AOF / RDB `ok` (observado 2026-10-15), durabilidad tras reinicio sin probar | ninguna en código; no depender de los límites más allá de su ventana |
| Redis Cluster en el futuro | `FAIL_SCRIPT` con dos claves fallaría (`CROSSSLOT`) → IMAP respondería 503 (falla cerrado) y el portal pasaría a respaldo local | hoy no aplica (`cluster_enabled:0`, observado 2026-10-15) | si se migrara a Cluster, usar *hash tags* antes |
| Operación que Redis aplica **después** del plazo de 2 s | una reserva o un hueco quedan contados hasta su ventana / *lease* (más restrictivo, nunca más permisivo) | baja | ninguna |
| Instancia que muere con un hueco tomado | esa organización recibe `IMAP_TEST_BUSY` hasta 90 s | baja | ninguna |
| Despliegue gradual con secretos distintos | instancias con claves distintas no comparten contadores por buzón durante el solapamiento | media durante la rotación | procedimiento de la sección 4 |
| Señal lateral del límite global | una organización sin fallos propios que recibe `IMAP_TEST_RATE_LIMITED` sabe que hubo actividad ajena | baja (inevitable) | ninguna |

## 4. `IMAP_RATE_LIMIT_SECRET`

Estado: **no configurado en producción ni en ningún entorno remoto**. Configurarlo requiere una **autorización
específica** (no forma parte de ninguna fase de auditoría). Solo lo usa la API (el worker no lo lee). Sin él, la
prueba de conexión y el alta responden `503 PROVIDER_NOT_CONFIGURED`.

- **Generar sin imprimirlo** (fuera del repositorio, en una máquina de confianza): escribirlo directamente en un
  fichero con permisos restringidos fuera de cualquier repositorio, por ejemplo
  `(umask 077; openssl rand -base64 32 > "$HOME/.emailbot-imap-secret")`, copiarlo desde ahí al gestor de
  contraseñas y al panel de Render, y borrar el fichero. No usar `console.log` / `echo` en una terminal compartida
  ni guardarlo en ficheros del repositorio o en el historial del *shell*.
- **Validar sin imprimirlo** (mismas reglas que la API: base64 estándar, ≥ 32 bytes, no todos iguales):
  `IMAP_RATE_LIMIT_SECRET="$(cat "$HOME/.emailbot-imap-secret")" node -e "const v=process.env.IMAP_RATE_LIMIT_SECRET||'';const b=Buffer.from(v,'base64');console.log(/^[A-Za-z0-9+/]+={0,2}$/.test(v)&&v.length%4===0&&b.toString('base64')===v&&b.length>=32&&!b.every(x=>x===b[0])?'valid':'INVALID')"`.
  Debe ser **distinto** de `TOKEN_ENCRYPTION_KEY` y `OAUTH_STATE_SECRET` (la API no arranca si coincide) y de
  cualquier otro secreto.
- **Entrega** (solo con autorización de despliegue): variable de entorno del servicio `emailbot-api` en Render
  (Dashboard → Environment, marcada como secreta), **el mismo valor en todas las instancias** de la API; guardar
  el original en el gestor de contraseñas del equipo. Nunca en tickets, chats, commits, logs ni diagnósticos.
- **Si falta o es inválido**: falta → la API arranca y las rutas IMAP responden 503 `PROVIDER_NOT_CONFIGURED`
  (nunca un hash sin clave); inválido o reutilizado → la API **no arranca** (error de configuración que nombra la
  variable sin mostrar su valor).
- **Rotación** (no transparente): las claves HMAC de buzón cambian, así que los contadores, bloqueos por buzón y
  el cupo global anteriores dejan de aplicarse (caducan solos en ≤ 15 min); los límites por usuario y
  organización (UUID) no cambian. Procedimiento: (1) generar y validar el nuevo valor; (2) elegir un momento de
  poca actividad IMAP; (3) actualizarlo en el servicio y hacer un despliegue manual que reinicie **todas** las
  instancias; (4) comprobar que ya no queda ninguna instancia con el release anterior (durante el solapamiento
  las instancias no comparten las claves por buzón); (5) revocar el valor anterior en el gestor de contraseñas.
  Rotar solo si el secreto se expone o por política, aceptando ese reinicio.

## 5. Lista de comprobación para una activación futura (no ejecutar sin autorización)

Requisitos previos (todos deben cumplirse; si uno falla, **no activar**):

1. Redis: repetir la consulta de la sección 1 justo antes (2026-10-15: Valkey 8.1.10, `noeviction`, AOF activo y
   `ok`, `cluster_enabled:0`); `EVAL` permitido. Suite opt-in contra una Valkey 8.1.10 **desechable**: hecha en
   E5.3 (sección 7); repetirla (sección 6) si cambia la versión de Render o el código de los límites, y nunca
   contra la de producción (la suite usa `KEYS`, `DEL` y `CLIENT PAUSE`).
2. `IMAP_RATE_LIMIT_SECRET` configurado y validado, el mismo en todas las instancias de la API; la API arranca.
3. Commits E1–E4.4, A1 y E6.3 revisados, fusionados y desplegados **con IMAP aún desactivado**: las rutas siguen
   en 503 y `/api/email-accounts/providers` devuelve `IMAP: false`.
4. Migraciones E1 (`20261014120000_imap_e1_security.sql`) y M1 (`20261015120000_imap_m1_lifecycle.sql`) aplicadas
   con el procedimiento habitual (copia de seguridad, *dry-run*, confirmación).
5. M1 (ciclo de vida con activación explícita) implementado en local, sin commit: migración M1, RPC
   `activate_imap_email_account`, reanudación por la API y correcciones D1 / D2 del worker (`docs/imap.md`). Además,
   un cambio de código revisado que active los indicadores; no hay variable de entorno para ello. Mecanismo real comprobado en el código: `imapAccountsEnabled` (`apps/api/src/config/env.ts:337`) e
   `imapSyncEnabled` (`apps/worker/src/config/env.ts:169`) fijos a `false`; la ruta PATCH rechaza siempre reanudar
   una cuenta IMAP (`routes.ts:382-384`); el *trigger* de la migración E1 lo rechaza también en la base de datos y
   `connect_imap_email_account` guarda las cuentas en PAUSED con `IMAP_SYNC_NOT_IMPLEMENTED`; el worker solo sondea
   cuentas ACTIVE. Además, A1 (límites de tamaño de ImapFlow) ya corregido en el commit local `578cec5`, que debe
   estar desplegado, y A2 (commit local, sección 8.2), A2.1 (F1, cola `email-processing`, commit local) y F2 (lote de
   recuperación propio para IMAP, implementado en local) publicados con él.

Verificación tras activar (con una cuenta de prueba propia, nunca credenciales de clientes):

- prueba de conexión: un servidor con nombre DNS público y certificado válido responde 200; un host interno o
  una IP literal → 422; un certificado no confiable → `IMAP_TLS_FAILED`; 143 sin STARTTLS →
  `IMAP_STARTTLS_UNAVAILABLE`, sin credenciales en claro;
- alta: la contraseña se guarda cifrada (`v2.`), vinculada a organización y dirección; la cuenta queda PAUSED; el
  cursor inicial es `imap:v1:<UIDVALIDITY>:<UIDNEXT-1>` y **no se importa ningún correo anterior**;
- aislamiento: otra organización no ve la cuenta ni su estado; el mismo buzón en dos organizaciones son dos
  cuentas;
- límites: 11.º intento de un usuario → 429; Redis no disponible → 503 sin conexión; logs sin contraseñas,
  usuarios, hosts ni claves HMAC.

Monitorización (logs de la API y Sentry): `imap.connection_test` por resultado (proporción de `IMAP_AUTH_FAILED`,
`IMAP_TLS_FAILED`, `IMAP_TIMEOUT`), duración, `IMAP_TEST_RATE_LIMITED` / `IMAP_LOGIN_LOCKED` / `IMAP_TEST_BUSY`,
`imap.limits_unavailable`, `imap.limits_bookkeeping_failed`; memoria y latencia de Key Value; en el worker,
errores de cuentas IMAP y cursor.

Criterios para abortar o revertir: cualquier 503 `imap.limits_unavailable` sostenido; un correo histórico
importado; una conexión a un destino no público; credenciales o secretos en logs; errores TLS inesperados con
proveedores conocidos; Key Value sin `noeviction` o sin persistencia. **Reversión**: desplegar el release anterior
o un cambio que devuelva `imapAccountsEnabled` / `imapSyncEnabled` a `false` (las rutas vuelven a 503 antes de leer
el cuerpo y el worker deja de sincronizar IMAP); las cuentas IMAP ya creadas quedan en PAUSED y pueden
desconectarse; el secreto puede quedarse configurado (sin la activación no se usa). Mientras falte cualquier
comprobación, el *endpoint* permanece desactivado: no hace falta ninguna acción, es el estado por defecto del
código.

## 6. Suite opt-in contra una Valkey 8.1.10 desechable (instrucciones; ejecutadas en E5.3, resultados en la sección 7)

Objetivo: repetir `apps/api/src/test/imap-valkey-integration.test.ts` contra la **misma versión** que producción
(8.1.10) en una instancia **local y desechable**, con la configuración de memoria de producción. La suite ejecuta
`KEYS`, `DEL` y `CLIENT PAUSE`:

- **nunca** contra producción ni con la `REDIS_URL` de la API desplegada (el *guard* `valkey-target.ts` solo admite
  `redis://` / `rediss://` a `127.0.0.1`, `localhost` o `[::1]` por TCP y rechaza el resto antes de conectar);
- nunca contra recursos existentes: **no tocar** `emailbot-redis-local` ni ningún otro contenedor, red o volumen;
- sin descargas: la imagen local `valkey/valkey:8` declara `VALKEY_VERSION=8.1.10`; `--pull never` impide que Docker
  descargue nada si faltara;
- requiere autorización explícita para levantar el contenedor.

Pasos (Docker en WSL; nombres y etiqueta exclusivos de la ejecución; el secreto de prueba vive solo en un fichero fuera
del repositorio):

```bash
# 0. Comprobaciones previas: imagen local y versión, nada con estos nombres, puerto libre, línea base.
docker image inspect valkey/valkey:8 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep VALKEY_VERSION   # 8.1.10
docker ps -a --format '{{.Names}}' | grep -c '^emailbot-e5-' ; docker network ls --format '{{.Name}}' | grep -c '^emailbot-e5-'   # 0 y 0
ss -ltn | grep ':56379 ' || echo libre
{ docker ps -a --format '{{.ID}} {{.Names}} {{.State}}'; docker volume ls -q; docker network ls -q; } | sort > /tmp/e5-baseline.txt

# 1. Red propia que publica solo en loopback, y prueba de aislamiento ANTES de arrancar Valkey.
docker network create --label emailbot-e5=1 -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 emailbot-e5-valkey-net
docker run -d --rm --pull never --name emailbot-e5-bindprobe --label emailbot-e5=1 --network emailbot-e5-valkey-net -p 127.0.0.1:56379:6379 --entrypoint sleep valkey/valkey:8 60
docker port emailbot-e5-bindprobe        # solo 127.0.0.1:56379 (sin 0.0.0.0 ni [::])
docker rm -f emailbot-e5-bindprobe

# 2. Contraseña de prueba aleatoria (nunca se imprime) y Valkey 8.1.10 con la política de memoria de producción,
#    sin persistencia (desechable) y datos en tmpfs (sin volúmenes).
umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > /tmp/e5-valkey-pass
docker run -d --pull never --name emailbot-e5-valkey --label emailbot-e5=1 --network emailbot-e5-valkey-net \
  -p 127.0.0.1:56379:6379 --tmpfs /data:size=64m valkey/valkey:8 \
  valkey-server --requirepass "$(cat /tmp/e5-valkey-pass)" --save "" --appendonly no --maxmemory 256mb --maxmemory-policy noeviction
docker exec -e REDISCLI_AUTH="$(cat /tmp/e5-valkey-pass)" emailbot-e5-valkey valkey-cli INFO server | grep -E '^valkey_version'

# 3. Suite, fase "up" (desde el worktree; la URL apunta SOLO a esa instancia local).
IMAP_VALKEY_URL="redis://:$(cat /tmp/e5-valkey-pass)@127.0.0.1:56379" pnpm --filter @emailbot/api exec vitest run src/test/imap-valkey-integration.test.ts

# 4. Fase "down": detener solo ese contenedor (comprobando la etiqueta) y repetir.
[ "$(docker inspect emailbot-e5-valkey --format '{{index .Config.Labels "emailbot-e5"}}')" = 1 ] && docker stop emailbot-e5-valkey
IMAP_VALKEY_URL="redis://:$(cat /tmp/e5-valkey-pass)@127.0.0.1:56379" IMAP_VALKEY_PHASE=down pnpm --filter @emailbot/api exec vitest run src/test/imap-valkey-integration.test.ts

# 5. Limpieza verificable: solo lo que lleva la etiqueta emailbot-e5, y comparación con la línea base.
[ "$(docker inspect emailbot-e5-valkey --format '{{index .Config.Labels "emailbot-e5"}}')" = 1 ] && docker rm emailbot-e5-valkey
[ "$(docker network inspect emailbot-e5-valkey-net --format '{{index .Labels "emailbot-e5"}}')" = 1 ] && docker network rm emailbot-e5-valkey-net
rm -f /tmp/e5-valkey-pass
{ docker ps -a --format '{{.ID}} {{.Names}} {{.State}}'; docker volume ls -q; docker network ls -q; } | sort | diff /tmp/e5-baseline.txt - && echo "idéntico a la línea base"
```

Notas: si el proceso de test corre en Windows (los `node_modules` del repositorio son de Windows) y Docker en WSL, la
contraseña debe guardarse en una ruta legible por ambos (fuera del repositorio) y el puerto llega por el reenvío de
`localhost` de WSL (comprobado en E4.1 / E4.4). La instancia desechable **no** reproduce la persistencia AOF de
producción (es irrelevante para la suite, que no reinicia el servidor), ni réplicas o *failover*. Resultado esperado
(E4.4): fase *up* 19/19, fase *down* 2/2.

## 7. Resultados E5.3: suite opt-in contra Valkey 8.1.10 desechable

Ejecutada el 2026-10-14 (hora de Lima, UTC−5; 2026-10-15 UTC) sobre `f7f7288`, sin cambios de código (solo estaban
pendientes los documentos de E5), con el procedimiento de la sección 6 y estas diferencias: la contraseña de prueba
se guardó fuera del repositorio en una ruta legible desde Windows y WSL (los tests corren con el Node de Windows y
llegan al puerto por el reenvío de `localhost` de WSL), y la línea base incluyó también las imágenes y una huella de
solo lectura de la base de datos local de desarrollo. Se usaron las aserciones y umbrales existentes, sin cambios.

**Entorno.** Imagen local `valkey/valkey:8` (`VALKEY_VERSION=8.1.10`, id `sha256:640c5e62…`), arrancada con
`--pull never`; el servidor informó `valkey_version:8.1.10`. `--maxmemory 256mb --maxmemory-policy noeviction` (como
producción), sin persistencia (`--save ""`, `--appendonly no`), datos en tmpfs, sin volúmenes, contraseña aleatoria
exclusiva de la prueba (nunca impresa; 0 apariciones en los logs de ambas fases).

| Fase | Estado de Valkey | Aprobados | Omitidos | Fallidos | Código de salida |
|---|---|---|---|---|---|
| `up` | disponible | 19 | 3 | 0 | 0 |
| `down` | detenido (solo el contenedor de la prueba, tras comprobar su etiqueta) | 2 | 20 | 0 | 0 |

La suite tiene 22 casos: 19 de la fase `up`, 2 de la fase `down` y un marcador que solo se ejecuta cuando no hay
`IMAP_VALKEY_URL`. Los omitidos son exactamente los de la fase opuesta más ese marcador (`up`: 2 + 1; `down`:
19 + 1); no se omitió ningún caso aplicable a la fase.

Comprobado en la fase `up` (descripción completa en [`docs/imap.md`](imap.md), "Integration tests (Valkey
local)"): scripts Lua contra el servidor real (valores, TTL, caducidad, errores); atomicidad con 200 / 100 / 50 / 25
llamadas simultáneas (presupuesto global de exactamente 30, hueco por organización de exactamente 1); **dos procesos
de API independientes** con el limitador real y el cliente de producción compartiendo claves HMAC, bloqueos y
contadores; rotación del secreto; distinción de fallos; caducidad de claves; `CLIENT PAUSE` → 503 dentro del plazo de
2 s sin DNS ni sockets; clave corrupta → 503; logs sin secretos; rutas con el cliente real (desactivadas: 503
`IMAP_NOT_AVAILABLE` sin escribir claves; activadas solo en la configuración de test). En la fase `down`: 503
rápido en dos procesos (sin llegar al DNS ni al IMAP simulados) y en la ruta, sin DNS, sockets, cifrado,
persistencia ni colas.

**Aislamiento y limpieza.**

- Red propia con `host_binding_ipv4=127.0.0.1` y publicación `127.0.0.1:56379`. Antes de arrancar Valkey, un
  contenedor de sondeo confirmó que solo se publicaba `127.0.0.1:56379`, que la conexión se rechazaba desde la `eth0`
  de WSL y que no había respuesta desde la LAN; después se eliminó. La URL pasó además por el *guard*
  `valkey-target.ts` (solo loopback por TCP).
- Sin descargas: `--pull never` y lista de imágenes idéntica a la línea base.
- Limpieza verificada: solo se eliminaron `emailbot-e5-valkey` y `emailbot-e5-valkey-net`, tras comprobar la etiqueta
  `emailbot-e5=1`; no queda ningún recurso con esa etiqueta. Contenedores, volúmenes, redes, imágenes y la huella de
  la base de datos local de desarrollo quedaron **idénticos a la línea base**; el puerto 56379 quedó sin escucha, sin
  procesos auxiliares; la contraseña y los logs se borraron.
- No se tocaron recursos preexistentes (`emailbot-redis-local` siguió detenido, sin usarse), no se consultó Render, no
  se usó la `REDIS_URL` de producción y no hubo ninguna conexión con producción.

**Qué demuestra.** Con la misma versión observada en Render (Valkey 8.1.10) y su política de memoria, los scripts y la
lógica de límites se comportan como en E4.1 / E4.4: atomicidad bajo concurrencia, TTL y caducidad, coordinación
entre dos procesos de API y fallo cerrado (503) ante pausa, clave corrupta o servidor detenido, sin abrir DNS ni
sockets hacia IMAP cuando Valkey no responde.

**Qué no demuestra** (sigue pendiente, sección 9):

- permisos de `EVAL`, de los comandos de los scripts y de `CLIENT SETNAME` en la instancia de Render (ACL o
  comandos restringidos del servicio gestionado);
- durabilidad tras un reinicio: la instancia de prueba no tenía persistencia y no se reinició;
- réplicas, *failover* gestionado ni la topología de Render más allá de `cluster_enabled:0`;
- latencia y red de Render, ni la memoria compartida con BullMQ bajo carga real;
- que la configuración de Render siga igual en el momento de activar IMAP.

## 8. Auditoría previa a la publicación (E5.5)

Revisión de código y documentación, sin cambios de producto. Estados usados en esta sección: **[local]** verificado
localmente; **[Render]** observado en la consulta de solo lectura de la sección 1; **[pendiente]** sin verificar;
**[autorización]** requiere una autorización específica antes de hacerse.

### 8.1 Commits auditados

Base: `origin/main` = `0e7a0b8` (desplegado). Cadena lineal, cada commit hijo del anterior, sin publicar:

| Fase | Commit | Padre | Contenido |
|---|---|---|---|
| E1 | `1cdd25a` | `0e7a0b8` | SSRF, SecretBox v2, migración `20261014120000_imap_e1_security.sql` |
| E2 | `ac8909b` | `1cdd25a` | adaptador IMAP del worker (desactivado) |
| E3 | `445f854` | `ac8909b` | prueba de conexión en la API y transporte compartido |
| E4 | `c9585f2` | `445f854` | límites distribuidos (Redis, HMAC, 503 antes de leer el cuerpo) |
| E4.4 | `f7f7288` | `c9585f2` | *guard* de la suite Valkey (solo tests) |

Diferencia acumulada `0e7a0b8..f7f7288`: 78 ficheros (+9345 / −130), 1 migración nueva.

Posteriores a esta auditoría, también locales y sin publicar (sin migraciones):

| Fase | Commit | Padre | Contenido |
|---|---|---|---|
| E6.1 (A1) | `578cec5` | `f7f7288` | `fix(imap): enforce protocol response limits` (8 ficheros) |
| E6.3 | `6f8c7c3` | `578cec5` | `fix(imap): preserve oversized single-part message bodies` (2 ficheros) |

### 8.2 Hallazgos

Ningún hallazgo afecta al despliegue **con IMAP desactivado**: las dos rutas responden 503 antes de leer el cuerpo y
el worker no crea el adaptador. Los defectos A1 y M1 **bloquean la activación** y requieren cambios de código (no
aplicados en esta fase).

| Id | Severidad | Tipo | Dónde | Hallazgo | Evidencia |
|---|---|---|---|---|---|
| A1 | **Alta** (bloquea la activación) | defecto confirmado [local] | `packages/shared/src/imap-client.ts:204-220`; `apps/worker/src/providers/imap/adapter.ts:277-281, 295, 308-311` | El cliente ImapFlow se crea sin `maxLineLength`, `maxLiteralSize` ni `maxResponseSize`: rigen los valores por defecto de ImapFlow 2.1.2 (1 GiB por línea o literal, 2 GiB por respuesta). El worker decide entre mensaje completo y "sobredimensionado" con el `RFC822.SIZE` que declara el propio servidor. Un servidor IMAP público controlado por un OWNER / ADMIN de una organización PRO o BUSINESS puede llenar la memoria de una instancia de la API (prueba de conexión) o del worker (sincronización), con efecto sobre todos los clientes | prueba local contra un servidor falso en `127.0.0.1` (sin red externa, con `openImapClient` del proyecto): 200 MiB enviados → +239 MiB de RSS con una línea de saludo sin CRLF (cortada a los 10 s por `greetingTimeout`) y +439 MiB con un literal (cortado a los 60 s por inactividad), **sin login** |
| A2 | Media | riesgo potencial | `packages/shared/src/imap-client.ts:38`; `apps/worker/src/providers/imap/pool.ts:46, 79-89`; `apps/worker/src/index.ts:181, 205` | Las operaciones del worker no tenían plazo total: solo inactividad del socket (60 s) y espera del *pool* (60 s). Un servidor que envía datos muy despacio podía retener una conexión y un trabajo de BullMQ cuya concurrencia comparten Gmail y Microsoft | **corregido en local (commit de la fase A2), salvo F1 / F2**: plazos totales por operación que cierran el socket, presupuesto por ejecución de la sincronización, cursor por prefijo contiguo y huecos IMAP en la cola `email-events`; reproducido y verificado con un servidor que envía un byte cada 100 ms y con BullMQ real. La cola `email-processing` (F1) tiene huecos IMAP y presupuesto en A2.1 (commit local; verificado con BullMQ real); el lote de recuperación tiene un lote IMAP propio en F2 (implementado en local, sin commit; verificado contra PostgREST real) (`docs/imap.md`, "Worker") |
| M1 | Media (operativa) | defecto confirmado [local] | `apps/api/src/modules/email-accounts/routes.ts:382-384`; migración E1 líneas 142-144, 312-314, 328, 337-338; `apps/worker/src/infrastructure/supabase-stores.ts:109-114` | Activar IMAP **no** consiste solo en poner `imapAccountsEnabled` / `imapSyncEnabled` a `true`: la ruta PATCH rechaza siempre reanudar una cuenta IMAP, el *trigger* de la migración lo rechaza también en la base de datos, `connect_imap_email_account` guarda la cuenta en PAUSED con `IMAP_SYNC_NOT_IMPLEMENTED` y el worker solo sondea cuentas ACTIVE. Con solo los dos indicadores, las cuentas nunca se sincronizarían (falla de forma segura, pero no funciona) | lectura de código y de la migración |
| B1 | Baja | riesgo potencial (diseño) | `apps/api/src/modules/email-accounts/imap-connection.ts:73, 248-253` | El cupo global por buzón externo (30 / 15 min) lo pueden agotar otras organizaciones: con 3 o más (10 rechazos cada una antes de su bloqueo) la organización legítima recibe `IMAP_TEST_RATE_LIMITED` hasta 15 min, y el servidor externo recibe hasta 30 logins rechazados por ventana | lectura de código; requiere varias organizaciones PRO / BUSINESS |
| B2 | Baja | riesgo potencial | `packages/shared/src/imap-destination.ts:141-144, 161-173`; `imap-connection.ts:240-242` | `dns.lookup` usa el *threadpool* de libuv y el plazo de 5 s no cancela la consulta; la resolución ocurre antes del límite de concurrencia por instancia. Un dominio con DNS lento puede ocupar hilos del *threadpool* de la API (acotado por los límites de 10 / 20 intentos por usuario / organización) | lectura de código |
| I1 | Informativo | — | `packages/validation/src/resources.ts:57-58` | Usuario y contraseña IMAP admiten caracteres de control; solo afectan a la sesión del propio usuario contra su servidor | lectura de código |
| I2 | Informativo | — | migración E1 líneas 166-343 | `p_sync_cursor` no se valida en SQL (solo lo llama `service_role` con el cursor que calcula la API) | lectura de código |
| I3 | Informativo | — | `packages/shared/src/crypto.ts` | Sin anillo de claves: rotar `TOKEN_ENCRYPTION_KEY` deja ilegibles v1 y v2 (diseño previo; v2 lo hereda) | lectura de código |

**A1, corregido en E6.1; commit local `578cec5` (sin publicar ni desplegar)**: límites explícitos de ImapFlow por
uso (`IMAP_PROTOCOL_LIMITS`: prueba de la API 256 KiB / 256 KiB / 1 MiB; worker 2 MiB / 11 MiB / 14 MiB), código
`IMAP_RESPONSE_TOO_LARGE` (SECURITY, sin reintentos) y pruebas de regresión con un servidor simulado en `127.0.0.1`;
la misma prueba de memoria (200 MiB ofrecidos) pasa de +239 / +439 MiB a +5 / +7 MiB, con corte en milisegundos.
En E6.2 se repitieron con los límites las suites Dovecot locales A / B / C (TLS 993, STARTTLS 143, certificado no
confiable, sin STARTTLS) sin fallos [local]. Detalle en `docs/imap.md`.

**E6.3, defecto funcional encontrado en E6.2 (previo, desde E2), corregido; commit local `6f8c7c3`**: un mensaje
de más de 10 MiB y una sola parte llegaba sin texto, porque la raíz no tiene número de parte en ImapFlow y el camino de
mensajes grandes no la descargaba. Ahora se pide como parte `1` (ImapFlow la lee como `TEXT` en trozos parciales);
los mensajes multiparte no cambian y los límites A1 tampoco. Pruebas: 7 con servidor simulado y Dovecot local
(`text/plain` y `text/html` de 10,5 MiB, multiparte con adjunto que no se descarga) [local].
**M1, implementado en local (M1.2, sin commit)**: migración `20261015120000_imap_m1_lifecycle.sql` (aditiva),
RPC `activate_imap_email_account`, reanudación explícita por la API, D1 (el cursor IMAP no avanza si la cuenta deja
de ser procesable durante un lote) y D2 (`markError` no revive una cuenta IMAP `DISCONNECTED`), pérdida del plan
sin ERROR y recuperación de 300 mensajes / 7 días [local: PGlite, PostgreSQL 17 desechable, Dovecot]. Detalle en
`docs/imap.md`. Corrección propuesta (no aplicada): A2, plazo total por operación del worker que cierre la conexión.
**Auditoría M1.3 y correcciones M1.4 (local, sin commit)**: recorrido integrado API → PostgREST / PostgreSQL →
BullMQ / Valkey → worker → Dovecot en una pila desechable [local]. H1 (reanudar una cuenta IMAP en `ERROR` hacía que
el worker volviera a iniciar sesión fuera de los límites E4) corregido: la API responde `409 IMAP_RECONNECT_REQUIRED`
sin RPC, trabajo, auditoría ni conexión, y la RPC responde `RECONNECT_REQUIRED`; hay que reconectar (prueba de
conexión con los límites E4) [local: PGlite, PostgreSQL 17 desechable con una carrera nueva, pila integrada]. H2
(aviso realtime `ERROR` para una cuenta ya `DISCONNECTED`, bajo) queda pendiente: su corrección toca el flujo común
de errores compartido con Gmail / Microsoft. La pausa no cancela los mensajes ya en curso; el cursor no avanza y la
deduplicación evita duplicados (`docs/imap.md`).

Revisado sin encontrar defectos (por lectura de código y tests locales; un test que pasa no basta por sí solo):
SSRF (todas las direcciones A / AAAA públicas, IPv6 por lista de permitidos, conexión a la IP validada; el código de
ImapFlow 2.1.2 confirma que `tls.connect` y la mejora STARTTLS usan esa IP como `host` y el nombre DNS como
`servername`, con `rejectUnauthorized: true`, TLS ≥ 1.2 y sin *proxy*); STARTTLS obligatorio en 143
(`doSTARTTLS: true`, sin respaldo en claro); `EXAMINE` (buzón de solo lectura) y lectura con `BODY.PEEK`; SecretBox v2
con AAD de organización y dirección (v1 no acepta v2; otro contexto o dato alterado → error, cuenta
`CREDENTIALS_UNREADABLE`); credenciales borradas al desconectar; RBAC `email-accounts:manage` y comprobaciones de
plan; 503 en `preParsing` antes de leer el cuerpo; logs con código de error solamente (`serializeError`: nombre,
mensaje y código) y Sentry sin cuerpos ni cabeceras; IMAP solo se habilita cambiando constantes en el código (ninguna
variable de entorno lo activa). No verificable localmente: comportamiento con proveedores reales, carga real y
permisos de Render.

### 8.3 Migración E1 (`20261014120000_imap_e1_security.sql`)

- **Compatibilidad** [local]: depende de `plan_catalog`, `plan_entitlements`, `organization_entitlements()`,
  `email_accounts` y del patrón de `20261007160000_email_account_oauth_connect.sql`, presentes en `0e7a0b8`. Es
  posterior a la última aplicada en producción (`20261007170000`). Las migraciones de Culqi pendientes en otra rama
  (`20261007150000`, `20261007150100`) son **anteriores** a `20261007170000` y necesitarán su propio análisis de
  orden; no afectan a E1.
- **Sin cambios destructivos de datos** [local]: inserta 3 filas de `plan_entitlements` (falla si ya existieran:
  no es idempotente), crea un *trigger* y una función. No borra ni modifica filas. Sí cambia privilegios:
  `authenticated` pierde `INSERT` y `UPDATE` sobre `email_accounts` salvo `UPDATE (status, display_name)`. Revisado
  [local]: la única escritura con el JWT del miembro es la ruta PATCH (`status`, `display_name`); el resto usa
  `service_role`.
- **Permisos** [local]: `connect_imap_email_account` es `SECURITY DEFINER` con `search_path = ''`; se revoca a
  `public`, `anon`, `authenticated` y `service_role` y solo se concede `EXECUTE` a `service_role`. La función del
  *trigger* se revoca a todos.
- **Atomicidad** [local]: bloqueo de la fila de la organización (`FOR NO KEY UPDATE`) y de la fila del buzón (`FOR
  UPDATE`); plan, límite, duplicados e inserción / reconexión en la misma transacción. Una respuesta de rechazo no
  escribe nada.
- **No activa IMAP** [local]: las cuentas quedan PAUSED y el *trigger* impide reanudarlas (ver M1).
- **Tests**: `packages/database/test/imap-e1.test.ts` y `packages/database/scripts/imap-connect-concurrency-check.sh`
  existen; **no** se ejecutaron en E5.5 (necesitan una base de datos local y solo se usan pilas desechables).
- **Verificación sin tocar producción** (procedimiento propuesto):
  1. [local] pila Supabase **desechable** (nunca la base de datos de desarrollo compartida): aplicar todas las
     migraciones desde cero, ejecutar `imap-e1.test.ts` y el script de concurrencia, y destruir la pila.
  2. [autorización] en producción, consultas de solo lectura previas: número de filas `provider = 'IMAP'` (se
     espera 0; una fila antigua con `secure` booleano quedaría en `IMAP_SETTINGS_INVALID`), ausencia de filas
     `IMAP` en `plan_entitlements` y lista de migraciones aplicadas.
  3. [autorización] `supabase db push --dry-run` (lista lo pendiente, no aplica nada) y copia de seguridad antes de
     aplicar.
  4. Reversión manual: SQL de la cabecera de la migración. Volver a conceder los privilegios reabre el problema que
     E1 corrige: preferible no revertir mientras IMAP esté desactivado.

### 8.4 Comandos Redis / Valkey y permisos

El código IMAP no usa `CLIENT SETNAME`. Lo usa BullMQ (cliente ioredis), y un fallo no se propaga:
ioredis 5.11.1 lo ignora (`built/redis/event_handler.js:58`, `.catch(noop)`).

| Comando | Dónde | Lectura / escritura | Evidencia en producción | Estado |
|---|---|---|---|---|
| `INFO` | consulta de la sección 1; BullMQ | lectura | consulta del 2026-10-15 (UTC) | [Render] permitido |
| `EVAL` | `rate-limit-store.ts:79`, `login-throttle.ts:116-136`, `imap-connection.ts:197`, worker `sync-lock.ts:27` | según el script | los tres primeros usos ya existen en producción, pero un fallo pasa a respaldo local con un aviso en el log; no hay observación directa | [pendiente] |
| `GET`, `PTTL` (dentro de scripts) | límites IMAP, bloqueo | lectura | ninguna directa | [pendiente] |
| `INCR`, `DECR`, `PEXPIRE`, `SET … PX`, `DEL` (dentro de scripts) | límites IMAP, bloqueo, rate limit | escritura | ninguna directa | [pendiente] |
| `CLIENT SETNAME` | BullMQ | escritura (estado de la conexión) | el worker procesa trabajos, pero el fallo sería silencioso | [pendiente]; no bloquea IMAP |
| `KEYS`, `CLIENT PAUSE` | solo la suite opt-in | — | nunca contra producción | no aplica |

Método mínimo propuesto para los permisos (no ejecutado):

1. **Pasivo, sin comandos** [autorización]: revisar en los logs de la API y del worker en Render la ausencia de
   `rate limit store unavailable`, `login lockout store unavailable` y errores de `sync-lock` durante un periodo
   representativo. Es evidencia indirecta.
2. **Entorno desechable equivalente** [autorización; con coste]: una instancia Key Value de Render **no
   productiva**, del mismo plan y versión, creada para la prueba y eliminada al terminar. Desde un *shell* puntual,
   ejecutar cada script una vez sobre claves `emailbot-e5-probe:<aleatorio>` con `PX` ≤ 60 s, más
   `CLIENT SETNAME` / `CLIENT GETNAME`. Son comandos de escritura, pero solo en esa instancia. La suite opt-in no
   sirve aquí: su *guard* solo admite loopback.
3. **Producción, solo si 1–2 no bastan** [autorización con confirmación escrita]: un único
   `EVAL "return redis.call('PTTL', KEYS[1])" 1 emailbot-e5-probe:<aleatorio>`. Demuestra el permiso de `EVAL` con
   un comando de solo lectura (devuelve −2 y no cambia nada). Los comandos de escritura se confirmarían por los logs
   del punto 1.

### 8.5 `IMAP_RATE_LIMIT_SECRET`

Estado: **no generado ni configurado** en ningún entorno remoto. Validación [local]: `apps/api/src/config/env.ts:7-14,
70-78` (base64 estándar, ≥ 32 bytes, no todos iguales; si es inválido, la API no arranca) y `:146-148` (distinto de
`TOKEN_ENCRYPTION_KEY` y `OAUTH_STATE_SECRET`). Si falta: `503 PROVIDER_NOT_CONFIGURED` (`imap-connection.ts:293`).
Generación sin imprimirlo, entrega, mismo valor en todas las instancias y rotación: sección 4. Configurarlo
[autorización] solo tiene efecto cuando IMAP esté activado.

### 8.6 Plan de publicación propuesto (no ejecutado)

| Paso | Qué | Estado |
|---|---|---|
| 1. Revisión del código | revisar `0e7a0b8..6f8c7c3` (E1–E4.4, A1 y E6.3) y los documentos E5 (este documento, `docs/imap.md`, `docs/render.md`); A1 ya está corregido (commit local); decidir si A2 y M1 se corrigen antes o después de publicar con IMAP desactivado (**antes de activar, obligatorio**) | [autorización] commit de la documentación E5 |
| 2. Publicación | `git push` de `feat/imap-e4-abuse-hardening` (contiene E1–E4.4, A1 y E6.3) y PR contra `main`; CI completa en verde | [autorización] |
| 3. Migraciones E1 y M1 | comprobaciones de 8.3 (también para `20261015120000_imap_m1_lifecycle.sql`) (pila desechable, consultas de solo lectura, `--dry-run`, copia de seguridad) y aplicación controlada con confirmación escrita | [autorización] |
| 4. Despliegue | API y worker con IMAP desactivado; no necesita `IMAP_RATE_LIMIT_SECRET` (es opcional y solo se valida si existe). Orden indiferente respecto a la migración: el código desplegado (`0e7a0b8`) solo escribe `status` / `display_name` con el JWT del miembro | [autorización] |
| 5. Secreto | sección 4, coordinado, el mismo valor en todas las instancias de la API | [autorización específica] |
| 6. Verificación tras desplegar | `/health` y *readiness* de API y worker; `POST /api/email-accounts/imap/test` y `POST /api/email-accounts/imap` → `503 IMAP_NOT_AVAILABLE`; `/api/email-accounts/providers` → `IMAP: false`; logs sin `imap.*` inesperados ni secretos; permisos de 8.4 (punto 1); regresiones de Gmail y Microsoft (conexión OAuth, *push*, sondeo, procesamiento, pausar / reanudar y renombrar una cuenta: ahora con privilegios de columna) | [pendiente] |
| 7. Antes de cualquier activación | M1 corregido y revisado; A1 (`578cec5`) desplegado; A2, A2.1 (F1) y F2 publicados (`docs/imap.md`, "Worker"); sección 5; consulta de la sección 1 repetida; permisos de 8.4; secreto configurado; suite opt-in repetida si cambió la versión o el código de los límites | [pendiente] |
| 8. Activación | cambio de código **y** migración revisados (M1), desplegados por separado con autorización explícita; verificación de la sección 5 con una cuenta de prueba propia | [autorización explícita] |
| 9. Aborto y reversión | criterios de la sección 5. Código: desplegar el release anterior (`0e7a0b8`, o el que deje IMAP desactivado). Secreto: quitarlo solo deja las rutas IMAP en 503. Migración: preferible no revertir (8.3) | [autorización] |
| 10. Evidencias | SHA de cada commit y del PR, resultado de CI, salida del `--dry-run` y lista de migraciones antes / después, identificadores de despliegue, respuestas de salud y de las rutas en 503, extractos de logs filtrados, subconjunto de `INFO` de la sección 1, marcas de tiempo en UTC. **Nunca** secretos, URL de Redis, contraseñas, *tokens* ni contenido de correo | — |

## 9. Riesgos pendientes

| Riesgo | Qué hace falta |
|---|---|
| La suite E5.3 (19/19 y 2/2) solo prueba una instancia local desechable: sin AOF, réplicas, ACL ni red de Render | las comprobaciones de las filas siguientes; repetir la suite (sección 6) si cambia la versión de Render o el código de los límites |
| A1: respuestas IMAP sin límite de tamaño (memoria de la API y del worker) | corregido en el commit local `578cec5` (Dovecot A / B / C repetido con los límites en E6.2): falta publicación, revisión del PR y despliegue |
| A2: operaciones del worker sin plazo total | commit local de la fase A2 (rama `feat/imap-a2-deadlines`): falta publicación. F1 (los trabajos IMAP de `email-processing` podían ocupar los diez huecos que comparten Gmail y Microsoft): huecos IMAP propios, presupuesto (no empieza ninguna operación IMAP tras 6 min, cada operación conserva su plazo, todo se cierra a los 9 min; no es la duración máxima del trabajo) y reutilización del mensaje leído dentro del mismo trabajo para sus adjuntos (sin ella, un correo con muchos adjuntos en un servidor lento podía quedar `FAILED` con contenidos perdidos) en A2.1 (rama `feat/imap-a2-1-processing-isolation`, implementado en local, sin commit; falta revisión, commit autorizado y publicación). F2 (correos IMAP incompletos podían llenar el lote global de recuperación, 100, e impedir que se recuperaran los de Gmail / Microsoft): lote IMAP propio de 20 en F2 (rama `feat/imap-f2-recovery-isolation`, commit local; falta publicación). Dentro del lote IMAP, el bloqueo por organizaciones sin acceso comercial o sin IMAP en el plan (A) y el reparto por organización (B) se corrigen en F2.2 (rama `feat/imap-f2-2-fair-recovery`, implementado en local, sin commit): lectura paginada y acotada que salta esas organizaciones y reparto por turnos; no es una equidad garantizada (`docs/imap.md`, "Worker"). Además, el margen de 4 min del presupuesto no es estricto (`docs/imap.md`, "Worker") |
| M1: la activación necesita código **y** migración, no solo los dos indicadores | implementado en local (M1.2), sin commit: falta revisión, commit autorizado, migración aplicada y despliegue; después, el cambio que active los indicadores (secciones 5 y 8.2) |
| H2: un trabajo atrasado que falla tras desconectar una cuenta IMAP publica un aviso realtime `ERROR` (la base de datos queda `DISCONNECTED`; solo es un aviso engañoso en la web) | decidir una corrección en el flujo común de errores (`markError` que informe si cambió la fila y publicación condicionada) con regresiones de Gmail / Microsoft; no bloquea la base de datos |
| B1 / B2: cupo global agotable por otras organizaciones; DNS lento en el *threadpool* | aceptados como riesgo bajo o revisión tras uso real (sección 8.2) |
| Permisos de `EVAL` / comandos de los scripts y `CLIENT SETNAME` en la instancia real sin comprobar directamente | método de la sección 8.4 (logs, instancia no productiva o un `EVAL` de solo lectura autorizado) |
| Durabilidad tras reinicio, réplicas / *failover* gestionado | información de Render o una prueba autorizada en un entorno no productivo; la consulta solo muestra estados de AOF / RDB |
| `maxmemory_policy` / persistencia pueden cambiar en el panel | repetir la consulta de la sección 1 justo antes de activar |
| `IMAP_RATE_LIMIT_SECRET` no configurado en producción | autorización específica de despliegue y entrega por el gestor de secretos |
| Migración E1 y commits E1–E4.4, A1 y E6.3 no publicados ni desplegados; tests de base de datos de E1 no repetidos en E5.5 | plan de la sección 8.6 (revisión, PR, pila desechable, autorización de migración y despliegue con IMAP desactivado) |
| Umbrales sin datos reales | revisión tras las primeras semanas de uso real |
