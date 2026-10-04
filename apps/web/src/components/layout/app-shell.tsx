import { LogOut, Menu, UserRound } from "lucide-react";
import { useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle, SheetContent } from "@/components/ui/dialog";
import { cn, initials } from "@/lib/utils";
import { useAuth, useUserDisplayName } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";
import { useRealtime, type RealtimeStatus } from "@/providers/realtime";
import { Sidebar } from "./sidebar";

const STATUS_STYLES: Record<RealtimeStatus, { label: string; dot: string }> = {
  connected: { label: "Tiempo real activo", dot: "bg-emerald-500" },
  connecting: { label: "Conectando…", dot: "bg-amber-500" },
  disconnected: { label: "Sin tiempo real", dot: "bg-muted-foreground" }
};

function RealtimeIndicator({ status }: { status: RealtimeStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" title={style.label}>
      <span className={cn("size-2 rounded-full", style.dot)} aria-hidden />
      {style.label}
    </span>
  );
}

/** Sidebar (drawer on small screens) + header + routed page. */
export function AppShell() {
  const { user, signOut } = useAuth();
  const displayName = useUserDisplayName();
  const { organization } = useOrganization();
  const [menuOpen, setMenuOpen] = useState(false);
  const realtime = useRealtime(organization?.id ?? null, user?.id ?? null);

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r bg-card lg:block">
        <Sidebar />
      </aside>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent>
          <DialogTitle className="sr-only">Navegación</DialogTitle>
          <DialogDescription className="sr-only">Menú principal de EmailBot</DialogDescription>
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Dialog>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Abrir menú" onClick={() => setMenuOpen(true)}>
            <Menu />
          </Button>
          <p className="truncate text-sm font-medium">{organization?.name}</p>
          <div className="ml-auto flex items-center gap-3">
            <RealtimeIndicator status={realtime} />
            <Link
              to="/profile"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
              aria-label="Perfil"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {initials(displayName) || <UserRound className="size-4" />}
              </span>
              <span className="hidden max-w-40 truncate md:inline">{displayName}</span>
            </Link>
            <Button variant="ghost" size="icon" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={() => void signOut()}>
              <LogOut />
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
