# Integración continua (GitHub Actions)

Workflow: `.github/workflows/ci.yml` (F8-A B-3).

## Cuándo se ejecuta

- `push` a `main`.
- Todo `pull_request` (cualquier rama destino).

Ejecuciones anteriores de la misma rama/PR se cancelan al llegar un commit nuevo.

## Qué hace

Ubuntu, Node 22, pnpm 12.8.1 (tomado de `packageManager` en `package.json`), caché del store de pnpm.

| Paso | Comando | Equivale a |
|---|---|---|
| Instalación | `pnpm install --frozen-lockfile` | falla si `pnpm-lock.yaml` no está al día |
| Typecheck | `pnpm typecheck` | `turbo typecheck` en todos los paquetes |
| Lint | `pnpm lint` | `turbo lint` |
| Tests | `pnpm test` | `turbo test` (Vitest) |
| Build | `pnpm build` | `turbo build` (incluye la web con Vite) |

Para reproducirlo en local, los mismos comandos en la raíz del repo.

## Sin secretos ni infraestructura externa

- El workflow no usa ningún secreto de GitHub ni variables de entorno de producción. `permissions: contents: read`
  y `persist-credentials: false`: el token del job no puede escribir en el repo.
- Los tests de `packages/database` (migraciones, RLS, funciones) usan PGlite, un Postgres en proceso: no hace
  falta Docker ni Supabase.
- Los tests de API y worker usan dobles en memoria (sin Redis, Supabase, Google, Microsoft ni Resend).
- La build de la web sin `NODE_ENV=production` no exige las variables `VITE_*` (la validación estricta solo se
  aplica en la build de despliegue).

## Excluido del CI

| Prueba | Motivo | Cómo ejecutarla |
|---|---|---|
| E2E de aislamiento (`apps/api/e2e/isolation.e2e.ts`, `pnpm --filter @emailbot/api e2e`) | Necesita un stack local de Supabase (Docker: Postgres, Auth, PostgREST) y la API levantada contra él | En local, con `supabase start` y las variables del stack local |

## Protección de `main` (recomendado, no configurado)

La protección de rama **no está activada**: se configura a mano en GitHub → Settings → Branches → *Add branch
protection rule* (o *Rulesets*) para `main`:

- **Require a pull request before merging** (sin pushes directos a `main`).
- **Require status checks to pass before merging**, con el check `typecheck, lint, test, build` del workflow CI
  y *Require branches to be up to date before merging*.
- **Block force pushes** (no permitir *force push*).
- **Restrict deletions** (no permitir borrar `main`).
- Opcional: *Do not allow bypassing the above settings* para que también aplique a administradores.

El check solo aparece en la lista después de que el workflow se haya ejecutado al menos una vez en el repo.
