import { Inbox, LogOut } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
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
    <div className="flex min-h-screen flex-col bg-background">
      <header data-floating-inset className="sticky top-0 z-30 border-b bg-card/90 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-5 sm:px-6">
          <Link
            to="/portal"
            className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            <BrandLogo className="h-11 sm:h-12" />
          </Link>
          <nav aria-label="Portal">
            <NavLink
              to="/portal"
              end
              className={({ isActive }) =>
                cn(
                  "inline-flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5",
                  isActive ? "bg-accent font-semibold text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )
              }
            >
              <Inbox aria-hidden className="size-4" /> <span className="sr-only sm:not-sr-only">Bandeja</span>
            </NavLink>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            {me.isPending ? (
              <Skeleton className="h-4 w-24" />
            ) : me.data ? (
              <span className="block min-w-0 max-w-[7rem] truncate text-sm text-muted-foreground sm:max-w-[14rem]" data-testid="portal-customer-name">
                {me.data.customer.displayName}
              </span>
            ) : null}
            <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />
            <Button variant="outline" onClick={() => void signOut()} disabled={logout.isPending} className="h-10 shrink-0 rounded-lg px-3 sm:px-4">
              <LogOut /> <span className="hidden sm:inline">Cerrar sesión</span>
              <span className="sr-only sm:hidden">Cerrar sesión</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {me.isError && !(me.error instanceof ApiError && me.error.status === 401) ? (
          <p role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            No pudimos cargar tu sesión. Inténtalo nuevamente.
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
