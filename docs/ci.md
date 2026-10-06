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
| E2E de aislamiento (`apps/api/e2e/isolation.e2e.ts`) y de `/health/sync` (`apps/api/e2e/sync-health.e2e.ts`), ambos con `pnpm --filter @emailbot/api e2e` | Necesitan un stack local de Supabase (Docker: Postgres, Auth, PostgREST); el de `/health/sync` crea sus datos con `psql` dentro del contenedor local (`docker exec`) | En local, con `supabase start` y las variables del stack local |

## Protección de `main` (aprobada, se configura a mano)

Decisión F8-B: proteger `main` con PR y CI obligatorios. **No se activa desde el código ni desde el CI**: la
configura a mano un administrador del repositorio en GitHub → Settings → Branches → *Add branch protection
rule* (o *Rulesets*) para `main`. Hasta que se haga, `main` sigue sin protección. Ajustes:

- **Require a pull request before merging** (sin pushes directos a `main`).
- **Require status checks to pass before merging**, con el check `typecheck, lint, test, build` del workflow CI
  y *Require branches to be up to date before merging*.
- **Block force pushes** (no permitir *force push*).
- **Restrict deletions** (no permitir borrar `main`).
- **Do not allow bypassing the above settings**: sin esta opción, los administradores (el propietario del
  repositorio) quedan exentos y la protección no se aplicaría a quien hoy hace los merges.

El check solo aparece en la lista después de que el workflow se haya ejecutado al menos una vez en el repo
(ya se ha ejecutado: PR #1 y el merge en `main`).

Comprobación después de configurarla: un `git push` directo a `main` es rechazado y un PR no se puede fusionar
mientras el check `typecheck, lint, test, build` no esté en verde.
