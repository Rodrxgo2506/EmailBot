import { ArrowLeft, Building2, History, LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import { AdminApiContext, type AdminApi } from "./admin-api";
import { AdminAuditPage } from "./admin-audit-page";
import { AdminDashboardPage } from "./admin-dashboard-page";
import { AdminOrganizationDetailPage } from "./admin-organization-detail-page";
import { AdminOrganizationsPage } from "./admin-organizations-page";

const NAV = [
  { to: "/admin", label: "Resumen", icon: LayoutDashboard, end: true },
  { to: "/admin/organizations", label: "Organizaciones", icon: Building2, end: false },
  { to: "/admin/audit", label: "Auditoría", icon: History, end: false }
];

/**
 * Platform administration console (/admin/*, EmailBot V2 phase 6). Same SPA,
 * session and design system as the panel; no organization context. Mounted
 * only behind RequirePlatformAdmin, and every request is authorized again by
 * the API (the UI is never the protection).
 */
export function AdminApp({
  api,
  userEmail,
  panelAvailable,
  onSignOut
}: {
  api: AdminApi;
  userEmail: string | null;
  /** The user also belongs to an organization (link back to the panel). */
  panelAvailable: boolean;
  onSignOut(): void;
}) {
  return (
    <AdminApiContext.Provider value={api}>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ShieldCheck className="size-4" />
              </div>
              <span className="font-semibold tracking-tight">EmailBot · Administración</span>
            </div>
            <nav aria-label="Administración" className="order-last flex w-full gap-1 overflow-x-auto md:order-none md:w-auto">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    )
                  }
                >
                  <item.icon className="size-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {panelAvailable ? (
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/">
                    <ArrowLeft /> Volver al panel
                  </Link>
                </Button>
              ) : null}
              {userEmail ? <span className="hidden max-w-48 truncate text-sm text-muted-foreground lg:inline">{userEmail}</span> : null}
              <Button variant="ghost" size="icon" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={onSignOut}>
                <LogOut />
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
          <Suspense fallback={<SkeletonRows rows={6} />}>
            <Routes>
              <Route index element={<AdminDashboardPage />} />
              <Route path="organizations" element={<AdminOrganizationsPage />} />
              <Route path="organizations/:organizationId" element={<AdminOrganizationDetailPage />} />
              <Route path="audit" element={<AdminAuditPage />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </AdminApiContext.Provider>
  );
}
