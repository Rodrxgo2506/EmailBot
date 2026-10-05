import { Inbox, LogOut, Mail } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api-client";
import { PORTAL_LOGIN_PATH } from "./portal-context";
import { usePortalInboxRealtime, usePortalLogout, usePortalMe } from "./portal-queries";

/**
 * Customer portal shell: header with the customer's name and logout. Its
 * presence requires a valid session (GET /api/portal/me); a 401 is handled
 * by PortalProvider (redirect to login).
 */
export function PortalLayout() {
  const navigate = useNavigate();
  const me = usePortalMe();
  const logout = usePortalLogout();
  usePortalInboxRealtime(me.data !== undefined);

  const signOut = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // The local state is cleared anyway (onSettled); the server session expires on its own.
    }
    navigate(PORTAL_LOGIN_PATH, { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/20">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link to="/portal" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Mail className="size-4" />
            </span>
            <span>EmailBot</span>
          </Link>
          <nav className="ml-2 hidden sm:block" aria-label="Portal">
            <NavLink
              to="/portal"
              end
              className={({ isActive }) =>
                `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm ${isActive ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              <Inbox className="size-4" /> Bandeja
            </NavLink>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {me.isPending ? (
              <Skeleton className="h-4 w-24" />
            ) : me.data ? (
              <span className="truncate text-sm text-muted-foreground" data-testid="portal-customer-name">
                {me.data.customer.displayName}
              </span>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void signOut()} disabled={logout.isPending}>
              <LogOut /> <span className="hidden sm:inline">Cerrar sesión</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {me.isError && !(me.error instanceof ApiError && me.error.status === 401) ? (
          <p role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            No pudimos cargar tu sesión. Inténtalo nuevamente.
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
