# EmailBot V2 — implementación

Rama: `feat/emailbot-v2`. Evolución incremental y aditiva de V1 (ver la auditoría arquitectónica aprobada).
Producción no se modifica sin autorización explícita por fase.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Preparación y compatibilidad | completada |
| 1 | Bots (tabla, `bot_id` en reglas y correos, motor de reglas) | pendiente |
| 2 | Customers, identificadores, asignaciones | pendiente |
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

## Decisiones pendientes

1. **Empate de bots** (misma prioridad, bots distintos). El motor ya ordena de forma estable (prioridad →
   `created_at` → `id`). Recomendación: tratar ese empate como **ambiguo** (`bot_id = NULL`, sin entrega) en
   lugar de elegir por antigüedad, porque entregar un código al cliente equivocado es un fallo de seguridad.
2. **Estado de la organización en el worker**: el worker (service role) no puede leer `organizations` (sin
   grant desde la migración 7). Aplicar `SUSPENDED` en el worker requiere un grant por columna
   (`select (id, status)`), es decir, una migración. Recomendación: incluirlo en la primera migración de la
   fase 1 junto con la comprobación en la API, en lugar de esperar a la fase 8.
3. **Orden de migraciones**: el plan lista `platform_admins` primero, pero Super Admin es la fase 7. Se propone
   crearla en la fase 7 (convención anterior).
