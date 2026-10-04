# Auditoría de seguridad y preparación para producción

Fecha: 2026-10-03. Alcance: monorepo completo (API, worker, motor de reglas, web, migraciones) y el proyecto
Supabase remoto "EmailBot Production", este último **solo en lectura**: consultas `SELECT` a catálogos, sin
cambios ni datos.

Metodología: revisión de código y migraciones, pruebas de explotación locales (tiempos medidos, PoC en
navegador, PostgreSQL embebido con las migraciones reales), `pnpm audit` y búsqueda de secretos en el código y
en el historial de git.

## Resumen de hallazgos

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| C1 | CRÍTICO | ReDoS en regex de reglas: una petición bloquea la API y una regla bloquea el worker | Corregido |
| A1 | ALTO | Regex internas cuadráticas sobre contenido del correo (cualquier remitente externo) | Corregido |
| A2 | ALTO | Firma de URLs de adjuntos con service role a partir de columnas escribibles por usuarios | Corregido (API) + migración 6 (no aplicada) |
| A3 | ALTO | Sin rate limiting en la API | Corregido (API) · Auth requiere configuración en Supabase |
| A4 | ALTO | Agregar miembros por email sin email verificado (suplantación de cuentas) | Corregido en código + config local · **producción requiere configuración** |
| M1 | MEDIO | Membresías sin consentimiento y enumeración de emails registrados | Mitigado (rate limit) · requiere invitaciones |
| M2 | MEDIO | Socket.IO no revalida tras el handshake | Corregido |
| M3 | MEDIO | `state` OAuth reutilizable durante 10 minutos | Corregido |
| M4 | MEDIO | Los adjuntos quedan en Storage tras borrar correos/cuentas/organizaciones; retención no aplicada | Pendiente |
| M5 | MEDIO | Frontend sin CSP ni cabeceras de seguridad (depende del hosting) | Pendiente (configuración de despliegue) |
| M6 | MEDIO | La Data API (PostgREST) permite saltarse las reglas extra de la API | Documentado; lo crítico, cubierto por la migración 6 |
| M7 | MEDIO | `gmail.readonly` es un scope restringido de Google | Configuración externa |
| B1 | BAJO | `email_rules.category_id` podía apuntar a otra organización | Migración 6 |
| B2 | BAJO | `public.rls_auto_enable()` ejecutable por `PUBLIC` en el remoto | Migración 6 (condicional) · no explotable |
| B3 | BAJO | Webhook de Gmail autenticado por token en query (no OIDC) | Recomendación |
| B4 | BAJO | Al desconectar no se revocan los tokens en el proveedor | Pendiente |
| B5 | BAJO | Supabase Auth usa el flujo implícito (tokens en el fragmento de la URL) | Recomendación (PKCE) |
| B6 | BAJO | Errores de PostgREST pueden registrar valores (PII) en logs | Recomendación |
| B7 | BAJO | Sin límites de número de reglas ni de tamaño de mensaje en el worker | Mitigado (presupuesto por correo) · pendiente |
| B8 | BAJO | Política de contraseñas local débil y `secure_password_change` desactivado | Corregido (config local) · producción: dashboard |
| I1–I9 | INFORMATIVO | Ver sección final | — |

---

## CRÍTICO

### C1. Denegación de servicio por regex de reglas (ReDoS)

- **Archivos**: `packages/rules-engine/src/conditions.ts` (operador `regex`), `extractors.ts` (EXTRACT con `pattern`),
  `packages/validation/src/regex-safety.ts:16`. Expuesto en `POST /api/rules/test` y `POST /api/rules/:id/test`
  (permiso `rules:read`, que tiene cualquier miembro) y en el worker.
- **Problema**: las regex de usuario se ejecutaban sin límite de tiempo. El validador estático solo detectaba
  cuantificadores anidados: `(a|a)+$` pasaba la validación.
- **Escenario**:
  1. Cualquier usuario se registra y crea su propia organización (queda como OWNER).
  2. Llama a `/api/rules/test` con `(a|a)+$` y un cuerpo de 64 000 `a`.
  3. El event loop de la API queda bloqueado y la API entera deja de responder para **todos** los tenants.
  - Variante en el worker: crea esa regla y se envía un correo a su propio buzón; el job bloquea el worker, BullMQ lo
    reintenta y el procesamiento de **todas** las organizaciones se detiene.
- **Evidencia**: `(a|a)+$` con 27 caracteres tardó **9 315 ms**; con 64 000 caracteres, el tiempo es indefinido.
- **Solución aplicada**:
  1. `RegexGuard` (`packages/rules-engine/src/regex-guard.ts`): las regex de usuario se ejecutan vía `node:vm`
     con `timeout` de 50 ms por llamada y un presupuesto de 250 ms por correo (V8 interrumpe el backtracking).
     Un timeout cuenta como "no coincide" y se informa con `regexTimedOut`; la API lo devuelve, el worker lo
     registra y la UI muestra un aviso.
  2. El validador rechaza además grupos repetidos con alternativas (`(a|b)+`).
- **Resultado**: el mismo ataque termina en **59–63 ms**. Tests: `packages/rules-engine/src/security.test.ts`
  y `apps/api/src/test/security.test.ts`.
- **Migración / configuración externa**: no.

## ALTO

### A1. Procesamiento cuadrático de contenido controlado por el remitente

- **Archivos**: `packages/rules-engine/src/text.ts` (`htmlToText`) y `extractors.ts` (presets `email` y
  `verification_code`).
- **Problema**: regex con lazy scan y backreference (`<(script|style|head)[^>]*>[\s\S]*?<\/\1>`), `<[^>]+>`,
  `\s*\n\s*` y `[A-Z0-9._%+-]+@…` eran cuadráticas con entradas como `<<<<…`, `\r\r\r…` o letras sin `@`.
- **Escenario**: cualquier persona externa envía un correo diseñado a un buzón conectado. Si existe una regla
  sobre el cuerpo o un extractor, el worker gasta segundos por correo; con varios correos se satura.
- **Evidencia**: el extractor de email tardaba 300 ms con 20 000 caracteres y `htmlToText` 244 ms con 20 000
  `\r`; el tamaño permitido llega a 200 000 caracteres.
- **Solución aplicada**:
  - Eliminación de bloques en una pasada con `indexOf`, cuantificadores acotados y lookahead acotado
    (`(?=[A-Z0-9]{0,7}\d)`).
  - Caché por evaluación: el HTML se convierte y se pliega una vez por correo, no una vez por condición.
  - Límite de tamaño al parsear cabeceras de direcciones en el worker.
- **Resultado**: 200 000 caracteres adversarios se procesan en ≤ 19 ms. Tests de regresión con 6 entradas
  adversarias.
- **Migración / configuración externa**: no.

### A2. Confused deputy en descarga de adjuntos (lectura cross-tenant de Storage)

- **Archivos**: `supabase/migrations/20261002035803_emails_and_attachments.sql:765-792` (concede
  INSERT/UPDATE de `storage_bucket`, `storage_path` y `storage_uploaded` al rol `authenticated`) y
  `apps/api/src/modules/emails/routes.ts` (firma con service role).
- **Escenario**: un OPERATOR de la organización A, usando la Data API directamente (anon key pública + su JWT),
  inserta o edita un adjunto de su organización con `storage_path = "<orgB>/<email>/<adjunto>/<archivo>"` o con
  otro bucket. Al pedir `/api/attachments/:id/download`, la API comprueba con RLS que el adjunto es suyo y luego
  **firma con service role la ruta elegida por el atacante**. Requiere conocer la ruta (UUIDs), pero rompe el
  aislamiento por diseño y también permite firmar objetos de cualquier otro bucket.
- **Solución aplicada**:
  - La API solo firma en el bucket configurado y con la estructura exacta
    `<org>/<email>/<adjunto>/<archivo>` (`isExpectedStorageLocation`, línea 118).
  - Migración 6 revoca a `authenticated` el INSERT/UPDATE de esas tres columnas; solo el worker escribe ubicaciones.
- **Tests**: API (ruta manipulada → 404 sin firmar) y DB (OPERATOR → `permission denied`).
- **Migración**: sí, `20261003120000_security_hardening.sql` (**no aplicada**).

### A3. Sin rate limiting

- **Escenario**:
  - Fuerza bruta de enumeración de emails en `POST /organizations/current/members`.
  - Abuso de `rules/test` (CPU).
  - Creación masiva de organizaciones.
  - Bearer tokens aleatorios: cada uno provoca una llamada a Supabase Auth (amplificación).
- **Solución aplicada**:
  - `@fastify/rate-limit` por IP, con almacenamiento compartido en Redis y fail-open si Redis cae.
  - Límite global configurable con `RATE_LIMIT_MAX` (300/min por defecto).
  - `TRUST_PROXY` para obtener la IP real detrás de un balanceador.
  - Límites estrictos por ruta (`apps/api/src/lib/rate-limits.ts`):

    | Ruta | Límite |
    |---|---|
    | Prueba de reglas | 30/min |
    | Agregar miembro | 20/10 min |
    | Crear organización | 10/hora |
    | Inicio de OAuth | 20/10 min |
    | Callback de OAuth | 30/10 min |
    | Alta IMAP | 10/10 min |
    | Sincronizar cuenta | 10/min |
    | Webhooks | 1 200/min |

  - `/health` queda excluido.
- **Configuración externa**: login, registro y recuperación de contraseña los atiende Supabase Auth; sus límites
  se configuran en el proyecto (*Auth → Rate Limits*). La Data API directa no pasa por estos límites (ver M6).

### A4. Agregar miembros por email sin email verificado

- **Archivos**: `apps/api/src/repositories/supabase/privileged.ts:15`, `supabase/config.toml`
  (`enable_confirmations = false`).
- **Escenario**:
  1. Con confirmación de email desactivada, un atacante se registra con `ceo@empresa.com` sin ser el dueño.
  2. Un ADMIN de "Empresa" agrega a `ceo@empresa.com`.
  3. El atacante entra a la organización y lee sus correos y códigos de verificación.
- **Solución aplicada**:
  - Solo se agregan usuarios con `email_confirmed_at` (consulta con `auth.admin.getUserById`).
  - Config local: `enable_confirmations = true`.
- **Configuración externa (BLOQUEANTE)**: en producción, activar *Confirm email*. Con la confirmación
  desactivada, Supabase marca a todos como confirmados y la comprobación del código no protege.

## MEDIO

### M1. Membresías sin consentimiento / enumeración

Cualquier OWNER/ADMIN (cualquier usuario, creando su propia organización) puede:
- saber si un email está registrado (404 vs 201);
- agregar a esa persona sin su aceptación; su organización aparece en el selector de la víctima, y el nombre de
  la organización puede usarse para phishing.

Mitigado por el rate limit (20 cada 10 minutos). **Solución real**: invitaciones con aceptación. Recomendado
antes de abrir el registro al público.

### M2. Socket.IO sin revalidación (corregido)

El token y la membresía se validaban solo en el handshake. Un miembro removido, o con el token expirado o
revocado, seguía recibiendo eventos, incluidas notificaciones con **códigos extraídos**.

Ahora:
- se revalida cada 5 minutos y se desconecta si ya no es válido (el cliente se reconecta con su token renovado);
- `maxHttpBufferSize` es de 16 KB.

Test: `revalidateSockets`.

### M3. OAuth `state` reutilizable (corregido)

El `state` firmado podía reutilizarse durante 10 minutos: si se filtraba (historial o Referer), un atacante podía
asociar **su** buzón a la organización de la víctima. Ahora el nonce es de un solo uso (Redis `SET NX EX`).
Test de replay incluido.

### M4. Datos que sobreviven al borrado (pendiente)

Borrar un correo, una cuenta o una organización elimina las filas, pero no los objetos del bucket
`email-attachments`. `email_retention_days` todavía no se aplica.

Solución propuesta: limpieza de Storage con service role antes del borrado, más un job de retención en el worker.

### M5. Cabeceras de seguridad del frontend (configuración de despliegue)

La sesión de Supabase vive en `localStorage`, por lo que un XSS permitiría robar tokens. No se encontró ningún
XSS (React escapa la salida, no se usa `dangerouslySetInnerHTML` y el HTML de correos va en un iframe aislado),
pero el hosting debe enviar estas cabeceras:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:; connect-src 'self' https://<api> wss://<api> https://<ref>.supabase.co;
  frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

El iframe `srcdoc` hereda esta CSP. Las imágenes `https:` solo se cargan si el usuario las permite: la CSP
interna del visor las bloquea por defecto.

### M6. Acceso directo a la Data API

La anon key es pública por diseño, así que un usuario puede llamar a PostgREST con su JWT sin pasar por la API.
**RLS impide cualquier acceso cross-tenant** (52 + 9 tests). Las reglas extra de la API, en cambio, no aplican
por esa vía:
- un ADMIN puede cambiar su propio rol o el de otro ADMIN;
- se pueden crear organizaciones ilimitadas vía RPC;
- un OPERATOR puede insertar correos falsos en **su propia** organización (phishing interno);
- un ADMIN puede editar `provider_metadata` o `sync_cursor` de sus cuentas (el worker solo sigue `deltaLink`
  de `graph.microsoft.com`).

Lo explotable entre tenants quedó cerrado por la migración 6 (A2, B1).

Recomendación: si el frontend no usa la Data API, reducir los grants de escritura directa a lo mínimo y mover
las mutaciones sensibles a la API o a RPCs `SECURITY DEFINER`.

### M7. Scopes OAuth (configuración externa)

`gmail.readonly` es un scope **restringido**: para usuarios externos, Google exige verificar la app y una
evaluación de seguridad (CASA). Microsoft recomienda verificar al publisher. Bloquea el lanzamiento público con
Gmail, no las pruebas internas.

## BAJO

- **B1.** `email_rules.category_id` solo tenía FK. Un ADMIN, vía la Data API, podía apuntar a una categoría de
  otra organización: no filtraba datos, pero hacía fallar el procesamiento. Migración 6 añade un trigger de
  consistencia de tenant.
- **B2.** `public.rls_auto_enable()`: ver la sección dedicada.
- **B3.** El webhook de Gmail se autentica con un token en la query (comparación en tiempo constante; se
  sanea en logs). Recomendado: verificar el JWT OIDC de Pub/Sub (`Authorization: Bearer`).
- **B4.** Al desconectar una cuenta se borran los tokens localmente, pero no se revocan en Google/Microsoft.
- **B5.** `supabase-js` usa el flujo implícito, así que en la recuperación el token viaja en el fragmento de la
  URL. Recomendado `flowType: "pkce"` tras probar los flujos de email.
- **B6.** `serializeError` registra mensajes de PostgREST que pueden incluir valores (por ejemplo,
  `Key (email)=(…)`). No son secretos, pero sí PII.
- **B7.** No hay límite de reglas por organización. El presupuesto de regex y la caché acotan el costo por
  correo. Mensajes de Gmail muy grandes se cargan completos en memoria (concurrencia 10).
- **B8.** Configuración local endurecida: contraseña mínima de 8 con letras y dígitos,
  `secure_password_change = true` y confirmación de email activa. **Replicar en producción.**

## INFORMATIVO

- **I1. Visor HTML.**
  - El iframe usa `sandbox="allow-popups allow-popups-to-escape-sandbox"`, sin `allow-scripts`,
    `allow-same-origin` ni `allow-forms`: no se ejecuta JS ni eventos, no se envían formularios y no navega
    la ventana superior.
  - CSP `default-src 'none'` con imágenes remotas bloqueadas por defecto.
  - **Verificado con PoC en navegador**: `<meta http-equiv="refresh">` **no** navega el iframe (el sandbox
    deshabilita las "automatic features"); el servidor de rastreo no recibió ninguna petición.
  - Un enlace con `target="_self"` puede navegar el iframe al hacer clic (sin scripts ni formularios):
    riesgo bajo de phishing dentro del marco.
- **I2. Secretos.**
  - No se detectaron secretos en el código, la documentación, los tests, `.env.example` ni el historial de git.
  - Se detectaron secretos del **stack local** de Supabase en `supabase/.temp/start-secrets/…/docker.env`:
    está ignorado por git y no referencia hosts remotos.
- **I3. Dependencias.** `pnpm audit`: 0 vulnerabilidades. Versiones mayores disponibles (no actualizadas):

  | Paquete | Actual | Disponible | Acción |
  |---|---|---|---|
  | bullmq | 5.81.5 | 6.3.11 | API de backends nueva; evaluar aparte |
  | ioredis | 5.11.1 | 6.0.0 | debe ir alineado con bullmq |
  | typescript | 5.9.3 | 7.0.2 | compilador nativo nuevo; evaluar aparte |
  | dotenv | 17.4.2 | 18.0.5 | bajo riesgo |
  | @types/node | 24.19.0 | 26.6.4 | alinear con el runtime |

  Fastify 5, supabase-js 2.117, Zod 4, React 19, Vite 8, Socket.IO 4.8, Sentry 11 (con `dataCollection`
  restringido), TanStack Query 5, Radix y Lucide están en la última versión de su rama, sin avisos.
- **I4. SQL injection.** No encontrada: supabase-js parametriza, todos los ids se validan como UUID, la
  búsqueda usa `websearch_to_tsquery` y no hay SQL dinámico con entrada de usuario.
- **I5. CSRF.** No aplica a la API (Bearer, sin cookies). El callback OAuth está protegido por un `state`
  firmado, con expiración y de un solo uso.
- **I6. SSRF.** El código no hace fetch a URLs elegidas por usuarios: Gmail, Graph y OAuth usan hosts fijos y
  `deltaLink` se restringe a `graph.microsoft.com`. La futura integración IMAP deberá bloquear IPs privadas al
  conectar al host indicado por el usuario.
- **I7. JWT / sesión.**
  - La API valida cada token con `auth.getUser`, que respeta revocación y logout.
  - `X-Organization-Id` se verifica contra la membresía en la base de datos en **cada** petición (tests:
    organización ajena → 403 sin consultar datos).
  - Cambiar `localStorage` no da acceso.
- **I8. Adjuntos.** URLs firmadas de 60 s con `Content-Disposition: attachment` (no se renderiza HTML en el
  dominio de Storage). Nombres saneados (sin traversal) y tamaño máximo de 25 MB (bucket y worker).
- **I9. Logs.** Se redactan `authorization`, cookies, tokens y secretos. Las URLs se sanean (`code`, `state`,
  `token`, `validationToken`). Sentry no recoge headers, cuerpos ni variables locales. Verificado con test.

---

## `public.rls_auto_enable()` (proyecto remoto)

| | |
|---|---|
| **ACTUAL** | `public.rls_auto_enable()` → `event_trigger`, `SECURITY DEFINER`, owner `postgres`, `search_path = pg_catalog`, ACL por defecto (EXECUTE para `PUBLIC`). La usa el event trigger `ensure_rls` (`ddl_command_end` en `CREATE TABLE`, `CREATE TABLE AS` y `SELECT INTO`), que ejecuta `ALTER TABLE … ENABLE ROW LEVEL SECURITY` sobre las tablas nuevas de `public`. **No viene del repositorio**; es la opción del dashboard de Supabase para activar RLS automáticamente en tablas nuevas. |
| **RIESGO** | Bajo. El linter la marca porque `anon` tiene EXECUTE, pero PostgreSQL rechaza llamar directamente a una función de event trigger (verificado: *"trigger functions can only be called as triggers"*). No acepta argumentos ni afecta tablas existentes. Su efecto (activar RLS) es protector. |
| **CAUSA** | Una función creada sin `REVOKE` hereda EXECUTE para `PUBLIC`. |
| **CAMBIO PROPUESTO** | Mantenerla (es útil). Revocar EXECUTE a `PUBLIC`/`anon`/`authenticated` (migración 6, bloque condicional: no falla si no existe; el event trigger sigue funcionando; probado). Documentar el objeto como parte del entorno remoto. **No se eliminó ni se modificó nada en producción.** |

## Estado real de producción (solo lectura)

- Migraciones aplicadas: **ninguna**.
- Tablas en `public`: **ninguna**. No existe el esquema `private`. Políticas RLS: 0. Buckets: ninguno.
- Objetos que no vienen del repositorio: `public.rls_auto_enable()` y el event trigger `ensure_rls`. Los demás
  event triggers son de la plataforma Supabase (`pgrst_*`, `issue_*`).

## Matriz RLS (tras la migración 6)

`org` = organización de la fila. Todas las tablas tienen RLS; `anon` no tiene privilegios. La service role
(API privilegiada/worker) omite RLS y solo se usa tras verificar membresía y rol.

| Tabla | SELECT | INSERT | UPDATE | DELETE | Notas |
|---|---|---|---|---|---|
| organizations | miembros | — (solo RPC `create_organization`) | OWNER/ADMIN (`name`, `slug`) | — | `plan` y `status` no son escribibles |
| organization_members | miembros de la org | OWNER/ADMIN, rol ≠ OWNER | OWNER/ADMIN, filas no OWNER, `role` ≠ OWNER | OWNER/ADMIN, filas no OWNER | Un único OWNER (índice); nunca sin OWNER (trigger diferido); identidad inmutable |
| profiles | uno mismo y quienes comparten org | — (trigger) | uno mismo (`full_name`, `avatar_url`) | — | |
| email_accounts | miembros (sin columnas de tokens) | OWNER/ADMIN (sin tokens) | OWNER/ADMIN (sin tokens) | OWNER/ADMIN | Tokens solo vía service role |
| categories | miembros | OWNER/ADMIN | OWNER/ADMIN | OWNER/ADMIN | |
| email_rules | miembros | OWNER/ADMIN (`created_by` = uno mismo) | OWNER/ADMIN | OWNER/ADMIN | Categoría del mismo tenant (migración 6) |
| emails | miembros | OPERATOR+ | OPERATOR+ (estado, categoría, extraídos) | OWNER/ADMIN | Cuenta, categoría y regla del mismo tenant (trigger) |
| email_attachments | miembros | OPERATOR+ (sin `storage_*`) | OPERATOR+ (`extracted_text`, `metadata`) | OWNER/ADMIN | `storage_*` solo service role (migración 6) |
| organization_settings | miembros | — (trigger) | OWNER/ADMIN | — | |
| audit_logs | OWNER/ADMIN | — (service role) | — (inmutable) | — (inmutable; solo cascada al borrar la org) | Actor debe ser miembro |
| storage.objects (`email-attachments`) | — | — | — | — | Bucket privado; solo URLs firmadas |

Verificado con las migraciones reales sobre PostgreSQL (`packages/database`, 61 tests). La organización A no
puede leer, insertar, modificar ni eliminar datos de B en ninguna tabla, y los roles se comportan como indica la
matriz.

---

## SECURITY STATUS

- Todas las vulnerabilidades críticas y altas con corrección de código quedaron corregidas y con tests de
  regresión: C1, A1, A2, A3 y A4 en código.
- El aislamiento multi-tenant está verificado en dos capas: RLS con las migraciones reales, y la API con la
  organización activa verificada por petición.
- Queda pendiente: la migración 6 sin aplicar, configuración externa (A4, M5, M7, B8) y mejoras funcionales
  (M1, M4, B4).

## PRODUCTION READINESS

**Bloquea producción:**
1. La base de datos de producción está vacía. Hay que aplicar las migraciones 1–6 (incluida la 6 de
   hardening), **con tu autorización**, y verificar antes con `supabase db reset` + `db diff` en local con Docker.
2. Supabase Auth en producción:
   - activar *Confirm email*;
   - política de contraseñas (mínimo 8, letras y dígitos);
   - *Secure password change*;
   - rate limits de Auth;
   - Site URL y Redirect URLs del frontend.
3. Despliegue:
   - HTTPS;
   - `CORS_ORIGINS`, `TRUST_PROXY` y `RATE_LIMIT_MAX`;
   - Redis gestionado con contraseña y TLS;
   - `TOKEN_ENCRYPTION_KEY` y `OAUTH_STATE_SECRET` únicos de producción;
   - cabeceras de seguridad del frontend (M5).
4. Pruebas end-to-end con Supabase real y buzones reales de Gmail/Microsoft: los adapters y OAuth solo están
   probados con mocks.

**No bloquea una beta privada, pero es necesario antes de un lanzamiento público:**
- invitaciones con aceptación (M1);
- verificación de Google para `gmail.readonly` (M7);
- limpieza de Storage y retención (M4);
- revocación de tokens en el proveedor (B4);
- suscripciones push (hoy se usa polling);
- PKCE en Auth (B5).
