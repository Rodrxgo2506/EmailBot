import { Mail } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { NAV_SECTIONS } from "./navigation";
import { OrganizationSwitcher } from "./organization-switcher";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useOrganization();

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
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                          isActive
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        )
                      }
                    >
                      <item.icon className="size-4" />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
