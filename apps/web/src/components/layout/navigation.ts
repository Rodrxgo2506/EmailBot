import type { Permission } from "@emailbot/types";
import {
  Bot,
  Building2,
  Contact,
  FolderTree,
  History,
  Inbox,
  LayoutDashboard,
  Mailbox,
  type LucideIcon,
  Users,
  Workflow
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  end?: boolean;
}

export const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Correo",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, permission: "emails:read", end: true },
      { to: "/inbox", label: "Bandeja", icon: Inbox, permission: "emails:read" },
      { to: "/bots", label: "Bots", icon: Bot, permission: "bots:read" },
      { to: "/customers", label: "Clientes", icon: Contact, permission: "customers:read" },
      { to: "/rules", label: "Reglas", icon: Workflow, permission: "rules:read" },
      { to: "/categories", label: "Categorías", icon: FolderTree, permission: "categories:read" },
      { to: "/accounts", label: "Cuentas de correo", icon: Mailbox, permission: "email-accounts:read" }
    ]
  },
  {
    title: "Organización",
    items: [
      { to: "/members", label: "Miembros", icon: Users, permission: "members:read" },
      { to: "/settings", label: "Configuración", icon: Building2, permission: "organization:read" },
      { to: "/audit", label: "Auditoría", icon: History, permission: "audit:read" }
    ]
  }
];
