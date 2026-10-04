# Frontend (`apps/web`)

React 19 + TypeScript + Vite 8, Tailwind CSS 4 con componentes estilo **shadcn/ui** (en `src/components/ui`,
sobre Radix Dialog/Slot y `class-variance-authority`), Lucide, TanStack Query, React Hook Form + Zod,
Supabase Auth, Socket.IO y Sonner (toasts).

## Ejecutar

```bash
pnpm install
# .env en la raíz con VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y VITE_API_URL
pnpm --filter @emailbot/web dev        # http://localhost:5173
pnpm --filter @emailbot/web build      # typecheck + build de producción en apps/web/dist
pnpm --filter @emailbot/web test
```

Vite lee el `.env` de la raíz (`envDir: "../../"`). Solo las variables `VITE_*` llegan al navegador.
Nunca pongas secretos en ellas. Si falta configuración, la app muestra una pantalla explicativa.

## Estructura

```
src/
├── app.tsx                    # Router (rutas con lazy loading) + providers
├── main.tsx
├── components/
│   ├── layout/                # AppShell (sidebar/drawer + header), guards, selector de organización
│   └── ui/                    # Button, Input/Select/Switch/CheckboxCard, Card/Badge, Dialog/Sheet,
│                              # Skeleton, ConfirmDialog, Pagination, Field, CopyButton
├── features/
│   ├── auth/                  # Login, registro, recuperación y nueva contraseña
│   ├── onboarding/            # Crear organización
│   ├── dashboard/             # Resumen, códigos recientes, alertas de cuentas
│   ├── inbox/                 # Bandeja, filtros (URL), detalle, cuerpo aislado, adjuntos
│   ├── rules/                 # Lista, editor visual, prueba contra el backend
│   ├── categories/
│   ├── accounts/              # Gmail/Microsoft (OAuth), IMAP, estados y acciones
│   ├── organization/          # Miembros/roles, configuración, transferencia, auditoría
│   └── profile/
├── lib/                       # Cliente API, Supabase, claves de query, errores, etiquetas
└── providers/                 # Auth, organización activa, realtime
```

## Autenticación y organización activa

1. Supabase Auth en el navegador (email + contraseña, registro, recuperación).
2. `AuthProvider` expone la sesión. `RequireAuth` protege las rutas.
3. `OrganizationProvider` llama a `GET /api/me` y elige la organización activa. La guarda en
   `localStorage` (`lib/organization-storage.ts`), y el cliente API la envía como `X-Organization-Id`.
4. Sin organizaciones, el usuario va a `/onboarding`.
5. Al cambiar de organización se elimina toda la caché `["org", …]`; ningún dato de otro tenant se reutiliza.

El rol solo adapta la interfaz (`can(permission)` con la misma matriz de `@emailbot/types`).
La API y RLS siguen siendo la autorización real.

## Datos

- Todas las queries de organización usan claves `["org", organizationId, …]` (`lib/query-keys.ts`).
- Sin polling: el realtime invalida las queries de correos al llegar `email.processed`.
- Los filtros de la bandeja viven en la URL (`?view=&category=&account=&q=&page=`).
- El editor de reglas convierte su estado a exactamente el payload del backend
  (`features/rules/rule-form-model.ts`) y lo valida con el mismo `ruleCreateSchema`.
  La evaluación se hace siempre en el backend (`POST /api/rules/test`).

## Realtime

`providers/realtime.ts` conecta Socket.IO (`path: /realtime`) con `{ token, organizationId }`.
El token se obtiene en cada reconexión. Los eventos se deduplican por id. El indicador del header
muestra el estado de la conexión.

## Seguridad en el cliente

- HTML de correos en `<iframe sandbox>` sin `allow-scripts` ni `allow-same-origin`, con CSP
  `default-src 'none'`. Las imágenes remotas (píxeles de rastreo) se bloquean hasta que el usuario las permite.
- Descarga de adjuntos mediante URLs firmadas de corta duración emitidas por la API.
- Tokens OAuth: nunca llegan al navegador; el flujo OAuth es una redirección completa al proveedor y vuelta a la API.

## Pruebas

`pnpm --filter @emailbot/web test` cubre funciones puras: cliente API, filtros de bandeja ↔ esquema de la API
y el mapeo formulario ↔ payload de reglas, validado con los esquemas del backend.
