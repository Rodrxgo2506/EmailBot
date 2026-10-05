import { Mail, ShieldCheck } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { NAV_SECTIONS } from "./navigation";
import { OrganizationSwitcher } from "./organization-switcher";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
    isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
  );

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, isPlatformAdmin } = useOrganization();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Mail className="size-4" />
        </div>
        <span className="font-semibold tracking-tight">EmailBot</span>
      </div>

      <div className="border-b p-3">
        <OrganizationSwitcher />
      </div>

      <nav aria-label="Navegación principal" className="flex-1 space-y-5 overflow-y-auto p-3">
        {NAV_SECTIONS.map((section) => {
          const items = section.items.filter((item) => can(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={section.title}>
              <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} onClick={onNavigate} className={linkClass}>
                      <item.icon className="size-4" />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {/* Rendered only for platform admins (from GET /api/me); /api/admin re-checks every request. */}
        {isPlatformAdmin ? (
          <div>
            <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Plataforma</p>
            <ul className="space-y-0.5">
              <li>
                <NavLink to="/admin" onClick={onNavigate} className={linkClass}>
                  <ShieldCheck className="size-4" />
                  Administración
                </NavLink>
              </li>
            </ul>
          </div>
        ) : null}
      </nav>
    </div>
  );
}
