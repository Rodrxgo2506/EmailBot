# Desarrollo local

## 1. Dependencias

```bash
pnpm install
```

## 2. Variables de entorno

Copia `.env.example` a `.env` en la raíz (nunca lo subas al repositorio). API, worker y web leen ese archivo.

| Variable | Usada por | Notas |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | API, worker | `pnpm supabase status` muestra los valores locales |
| `SUPABASE_SERVICE_ROLE_KEY` | API, worker | **Solo servidor** |
| `REDIS_URL` | API, worker | `redis://localhost:6379` |
| `TOKEN_ENCRYPTION_KEY` | API, worker | 32 bytes en base64 |
| `OAUTH_STATE_SECRET` | API | ≥ 32 caracteres |
| `GOOGLE_*`, `MICROSOFT_*` | API, worker | Opcionales; sin ellas, "Conectar" responde "no configurado" |
| `CORS_ORIGINS` | API | Obligatoria en producción (lista separada por comas) |
| `TRUST_PROXY` | API | Detrás de un balanceador: `true`, número de saltos o IPs/CIDRs (IP real para el rate limit) |
| `RATE_LIMIT_MAX` | API | Peticiones por minuto e IP (global; las rutas sensibles tienen límites propios) |
| `WEB_APP_URL` | API | Destino de las redirecciones OAuth (`http://localhost:5173`) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` | web | Valores públicos |

Generar secretos:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### OAuth

- Google: credencial de tipo *Web application* con redirect `http://localhost:3000/api/oauth/gmail/callback` y scope `gmail.readonly`.
- Microsoft: app registration con redirect `http://localhost:3000/api/oauth/microsoft/callback` y permisos `Mail.Read`, `User.Read` y `offline_access`.

## 3. Supabase local

```bash
pnpm supabase start
pnpm supabase db reset     # solo local: recrea la base y aplica supabase/migrations
pnpm supabase db diff      # debe quedar vacío (sin cambios de esquema pendientes)
```

`supabase/config.toml` define `site_url = http://localhost:5173` para que los enlaces de confirmación y
recuperación de contraseña vuelvan al frontend. La confirmación de email está activada: en local, los
correos de confirmación se ven en Mailpit (http://127.0.0.1:54324).

En producción hay que replicar estos ajustes en el dashboard (*Auth*): *Confirm email*, contraseña mínima de 8
con letras y dígitos, *Secure password change*, rate limits y Site/Redirect URLs.
Ver [`security-audit.md`](security-audit.md).

> No ejecutes `db reset` contra proyectos remotos. Las migraciones nuevas se agregan como archivos nuevos;
> las históricas no se editan.

## 4. Ejecutar

```bash
redis-server               # o un contenedor de Redis
pnpm dev                   # API :3000, worker y web :5173
```

## 5. Validación

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

`packages/database` ejecuta las migraciones reales sobre PostgreSQL embebido (PGlite) para probar RLS,
aislamiento entre organizaciones, RBAC, deduplicación e inmutabilidad de auditoría sin necesidad de Docker.
