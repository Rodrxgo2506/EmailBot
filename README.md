# EmailBot

Plataforma SaaS multiusuario para conectar cuentas de correo (Gmail, Microsoft 365 / Outlook, IMAP) y **procesar solo los correos que coinciden con reglas** definidas por cada organización: clasificarlos, marcarlos como importantes, extraer datos (por ejemplo, códigos de verificación) y notificar en tiempo real.

> Los correos que no coinciden con ninguna regla activa **no se almacenan**.

## Arquitectura

```
Proveedor (Gmail Pub/Sub · Graph webhooks · polling)
        │
        ▼
apps/api  ── webhook ──► Redis / BullMQ ──► apps/worker
(Fastify)                                   │ fetch + normalize (NormalizedEmail)
   ▲  ▲                                     │ rules-engine
   │  └── Socket.IO ◄── Redis pub/sub ◄─────┤ persistencia idempotente
   │                                        ▼
apps/web (React)             Supabase (PostgreSQL + RLS · Auth · Storage)
```

| Paquete | Descripción |
|---|---|
| `apps/web` | Frontend React + Vite + Tailwind (componentes estilo shadcn/ui), TanStack Query, React Hook Form + Zod, Supabase Auth, Socket.IO |
| `apps/api` | API REST Fastify: auth (Supabase), contexto de organización, RBAC, módulos, webhooks, OAuth, realtime |
| `apps/worker` | BullMQ: eventos de proveedor, pipeline de procesamiento, notificaciones, polling |
| `packages/types` | Enums espejo de la DB, DTOs, `NormalizedEmail`, matriz de permisos |
| `packages/validation` | Esquemas Zod compartidos (API, worker y web) |
| `packages/rules-engine` | Motor de reglas independiente de HTTP/DB |
| `packages/shared` | Solo servidor: cifrado AES‑256‑GCM, estado OAuth firmado, colas, logging seguro, clientes OAuth |
| `packages/database` | Tests que ejecutan las migraciones reales sobre PostgreSQL embebido (PGlite) para verificar RLS |
| `supabase/` | Migraciones y `config.toml` |

Más detalle en [`docs/`](docs/):
- [`architecture.md`](docs/architecture.md): flujo de datos, multi-tenant y seguridad.
- [`api.md`](docs/api.md): endpoints REST y eventos realtime.
- [`frontend.md`](docs/frontend.md): estructura del frontend, autenticación y realtime.
- [`development.md`](docs/development.md): entorno local, variables y validación.
- [`security-audit.md`](docs/security-audit.md): auditoría de seguridad y preparación para producción.

## Requisitos

- Node.js ≥ 22 (probado con 24) y pnpm 12 (`packageManager` en `package.json`)
- Docker (para Supabase local con `pnpm supabase start`)
- Redis 7+ (API y worker)

## Inicio rápido

```bash
pnpm install
cp .env.example .env          # completar valores (ver docs/development.md)
pnpm supabase start           # Supabase local (requiere Docker)
pnpm supabase db reset        # SOLO en local: aplica migraciones desde cero
pnpm dev                      # api (3000) + worker + web (5173)
```

Abrir http://localhost:5173, crear una cuenta, crear la organización y conectar un buzón.

## Scripts

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Todos los servicios en modo desarrollo (turbo) |
| `pnpm build` | Compila paquetes, API, worker y web |
| `pnpm typecheck` | TypeScript estricto en todo el monorepo |
| `pnpm lint` | Verificación TypeScript (incluye `noUnusedLocals` / `noUnusedParameters`) |
| `pnpm test` | Vitest en todos los paquetes (incluye tests de RLS con PGlite) |
| `pnpm --filter @emailbot/web dev` | Solo el frontend |

## Seguridad (resumen)

- Aislamiento por organización con **RLS** en todas las tablas; la API consulta PostgREST con el JWT del usuario y además filtra por la organización activa (`X-Organization-Id`).
- Roles `OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`. La UI oculta acciones no permitidas, pero la autorización real ocurre en la API y en la base de datos.
- Tokens OAuth y contraseñas IMAP cifrados (AES‑256‑GCM); nunca se exponen al navegador ni a los logs.
- La service role key solo existe en API y worker. El frontend solo usa variables `VITE_*` públicas.
- El HTML de los correos se muestra en un iframe aislado (sin scripts, CSP que bloquea recursos remotos por defecto).
- Las regex de las reglas se ejecutan con límite de tiempo; hay rate limiting por IP y los sockets se revalidan periódicamente.
- Auditoría de seguridad y checklist de producción: [`docs/security-audit.md`](docs/security-audit.md).

## Estado

Funcional: autenticación, organizaciones, miembros y roles, cuentas de correo (OAuth Gmail/Microsoft), categorías, reglas (editor, prueba contra el motor real), bandeja con filtros/búsqueda/paginación, adjuntos, auditoría, realtime.

Pendiente: ver la sección *Pendientes* en [`docs/architecture.md`](docs/architecture.md#pendientes).
