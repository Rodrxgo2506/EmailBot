# EmailBot V2 — implementación

Rama: `feat/emailbot-v2`. Evolución incremental y aditiva de V1 (ver la auditoría arquitectónica aprobada).
Producción no se modifica sin autorización explícita por fase.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Preparación y compatibilidad | completada |
| 1 | Bots (tabla, `bot_id` en reglas y correos, motor de reglas) + `organizations.status` | completada |
| 2 | Customers, identificadores, asignaciones | completada |
| 3 | Routing: Customer Resolver + `email_deliveries` | pendiente |
| 4 | Customer Access ID + sesiones | pendiente |
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
| service_role | sin acceso (fase 3) | sin acceso (fase 3) | sin acceso (fase 3) |

### Búsqueda de clientes por teléfono (corrección)

La búsqueda compara los identificadores por su forma normalizada: el texto en minúsculas **o**, para `PHONE`,
el fragmento de teléfono normalizado (`+51 987` → `+51987`, `987 654 321` → `987654321`). Ambas formas salen de
`normalizeIdentifierFragment`, que reutiliza la misma canonicalización que `normalizeIdentifier` (sin las
comprobaciones de valor completo). Valores almacenados y semántica de `PHONE` sin cambios.

## Deuda de QA

- **TODO antes del lanzamiento**: añadir `jsdom` + `@testing-library/react` para tener tests de
  componentes/render reales en la aplicación web (hoy la suite web solo cubre lógica sin DOM). No instalado
  todavía.

## Decisiones pendientes

Ninguna abierta tras la fase 1 (las cuatro de la fase 0 se aprobaron: empate = AMBIGUOUS, estado de la
organización en la fase 1, migraciones en la fase que las usa, rutas en la raíz).
