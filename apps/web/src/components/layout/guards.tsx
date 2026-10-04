import type { Permission } from "@emailbot/types";
import { Ban, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorMessage, Spinner } from "@/components/ui/display";
import { getErrorMessage } from "@/lib/errors";
import { ORGANIZATION_STATUS_LABELS } from "@/lib/labels";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";

export function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

/** Session required. Unauthenticated users go to /login and come back afterwards. */
export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoader />;
  if (!session) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <Outlet />;
}

/** Only for signed-out users (login, register...). */
export function RedirectIfAuthenticated() {
  const { session, loading, passwordRecovery } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (session && !passwordRecovery) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * SUSPENDED / CANCELLED organization: its data is kept but the API refuses
 * every operation (ORGANIZATION_INACTIVE), so the panel is not shown.
 */
function InactiveOrganization() {
  const { organization, memberships, switchOrganization } = useOrganization();
  const { signOut } = useAuth();
  const others = memberships.filter(
    (membership) => membership.organization.id !== organization?.id && membership.organization.status === "ACTIVE"
  );

  return (
    <div className="mx-auto mt-24 grid max-w-md gap-4 p-4">
      <EmptyState
        icon={<Ban />}
        title={`${organization?.name ?? "Organización"}: ${organization ? ORGANIZATION_STATUS_LABELS[organization.status].toLowerCase() : ""}`}
        description="Esta organización no está activa. Sus datos se conservan, pero no se puede operar mientras siga en este estado."
      />
      {others.length > 0 ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">Cambiar a otra organización:</p>
          {others.map((membership) => (
            <Button key={membership.organization.id} variant="outline" onClick={() => switchOrganization(membership.organization.id)}>
              {membership.organization.name}
            </Button>
          ))}
        </div>
      ) : null}
      <Button variant="ghost" onClick={() => void signOut()}>
        Cerrar sesión
      </Button>
    </div>
  );
}

/** Active organization required; users without one are sent to onboarding. */
export function RequireOrganization() {
  const { loading, organization, error } = useOrganization();
  if (loading) return <FullScreenLoader />;
  if (error) {
    return (
      <div className="mx-auto mt-24 max-w-md p-4">
        <ErrorMessage error={new Error(getErrorMessage(error))} />
      </div>
    );
  }
  if (!organization) return <Navigate to="/onboarding" replace />;
  if (organization.status !== "ACTIVE") return <InactiveOrganization />;
  return <Outlet />;
}

/**
 * Hides a page from roles that cannot use it. This is UX only: the API
 * still rejects the requests (RBAC + RLS).
 */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useOrganization();
  if (!can(permission)) {
    return (
      <EmptyState
        icon={<ShieldAlert />}
        title="Acceso restringido"
        description="Tu rol en esta organización no permite ver esta sección."
      />
    );
  }
  return <>{children}</>;
}
