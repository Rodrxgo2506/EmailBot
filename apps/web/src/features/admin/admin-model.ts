import type { AdminActivityItem, AdminAuditEntry, AdminOrganizationSort, OrganizationStatus } from "@emailbot/types";
import type { AdminOrganizationListParams } from "./admin-api";

export const ADMIN_PAGE_SIZE = 25;
export const ADMIN_LOG_PAGE_SIZE = 25;
export const ADMIN_RECENT_ACTIVITY = 8;

export { PLAN_LABELS } from "@/lib/labels";

export const SORT_LABELS: Record<AdminOrganizationSort, string> = {
  created_desc: "Más recientes",
  created_asc: "Más antiguas",
  name_asc: "Nombre (A-Z)",
  name_desc: "Nombre (Z-A)"
};

export const STATUS_BADGE: Record<OrganizationStatus, "success" | "warning" | "destructive"> = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  CANCELLED: "destructive"
};

export const DEFAULT_ORGANIZATION_PARAMS: AdminOrganizationListParams = {
  search: "",
  status: "",
  plan: "",
  sort: "created_desc",
  page: 1,
  pageSize: ADMIN_PAGE_SIZE
};

export interface StatusChange {
  target: OrganizationStatus;
  action: string;
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  success: string;
}

/**
 * Suspend / reactivate copy. Describes only what the backend really does
 * (organizations.status, EmailBot V2 phase 1): the API answers
 * ORGANIZATION_INACTIVE to its members, the worker stops syncing and
 * processing its mailboxes, and portal sessions stop working; nothing is
 * deleted and it can be reactivated.
 */
export function statusChange(status: OrganizationStatus, name: string): StatusChange {
  if (status === "ACTIVE") {
    return {
      target: "SUSPENDED",
      action: "Suspender",
      title: "¿Suspender organización?",
      description:
        `${name} dejará de procesar correos nuevos: no se sincronizarán sus buzones, sus miembros no podrán operar el panel y el portal de sus clientes quedará inaccesible. ` +
        "No se elimina ningún dato (correos, bots, clientes, reglas y cuentas se conservan) y puedes reactivarla después.",
      confirmLabel: "Suspender",
      destructive: true,
      success: "Organización suspendida"
    };
  }
  return {
    target: "ACTIVE",
    action: "Reactivar",
    title: "¿Reactivar organización?",
    description: `${name} volverá a estar activa: sus miembros podrán operar el panel, sus buzones se sincronizarán de nuevo y el portal volverá a estar disponible para sus clientes.`,
    confirmLabel: "Reactivar",
    destructive: false,
    success: "Organización reactivada"
  };
}

/**
 * Cancel (from ACTIVE or SUSPENDED). The project has not made CANCELLED
 * terminal: today the backend treats it exactly like SUSPENDED (every check
 * is organizations.status <> 'ACTIVE'), nothing is deleted and it can be
 * reactivated. The copy says only that; null when already cancelled.
 */
export function cancelChange(status: OrganizationStatus, name: string): StatusChange | null {
  if (status === "CANCELLED") return null;
  return {
    target: "CANCELLED",
    action: "Cancelar organización",
    title: "¿Cancelar organización?",
    description:
      `${name} quedará marcada como cancelada. Hoy tiene los mismos efectos que una suspensión: no se sincronizarán sus buzones, sus miembros no podrán operar el panel y el portal de sus clientes quedará inaccesible. ` +
      "No se elimina ningún dato y, por ahora, puedes reactivarla después.",
    confirmLabel: "Cancelar organización",
    destructive: true,
    success: "Organización cancelada"
  };
}

/** Status change the dialog confirms: the organization and the copy of the chosen transition. */
export interface StatusTarget<T> {
  organization: T;
  change: StatusChange;
}

const PLATFORM_ACTIONS: Record<string, string> = {
  "organization.created": "Organización creada",
  "organization.plan_changed": "Plan cambiado",
  "organization.suspended": "Organización suspendida",
  "organization.reactivated": "Organización reactivada",
  "organization.cancelled": "Organización cancelada",
  // Commercial V1.1
  "subscription.activated": "Suscripción activada",
  "subscription.renewed": "Suscripción renovada",
  "subscription.plan_changed": "Plan de la suscripción cambiado",
  "subscription.suspended": "Suscripción suspendida",
  "subscription.reactivated": "Suscripción reactivada",
  "subscription.past_due": "Suscripción con pago pendiente",
  "subscription.canceled": "Suscripción cancelada",
  "subscription.expired": "Suscripción vencida",
  "payment.recorded": "Pago registrado",
  // Libro de Reclamaciones
  "complaint_book.response_sent": "Reclamo respondido",
  "complaint_book.response_failed": "Respuesta a reclamo no enviada",
  "complaint_book.response_uncertain": "Respuesta a reclamo con resultado incierto",
  "complaint_book.confirmation_resent": "Constancia de reclamo reenviada",
  "complaint_book.confirmation_failed": "Constancia de reclamo no enviada",
  "complaint_book.confirmation_uncertain": "Constancia de reclamo con resultado incierto"
};

export function platformActionLabel(action: string): string {
  return PLATFORM_ACTIONS[action] ?? action;
}

/** "from → to" for status / plan changes, the plan for creations and activations, method and amount for payments; nothing else. */
export function platformAuditDetail(entry: AdminAuditEntry): string | null {
  const { from, to, plan, fromPlan, billingPeriod, paymentMethod, amount, code, errorCode } = entry.metadata as Record<string, unknown>;
  if (entry.targetType === "complaint_book_entry" && typeof code === "string") return typeof errorCode === "string" ? `${code} · ${errorCode}` : code;
  if (typeof fromPlan === "string" && typeof plan === "string") return `${fromPlan} → ${plan}`;
  if (typeof from === "string" && typeof to === "string") return `${from} → ${to}`;
  if (typeof paymentMethod === "string" && (typeof amount === "number" || typeof amount === "string")) {
    return `${paymentMethod} · S/ ${Number(amount).toFixed(2)}`;
  }
  if (typeof plan === "string") return typeof billingPeriod === "string" ? `Plan ${plan} · ${billingPeriod}` : `Plan ${plan}`;
  return null;
}

/**
 * Organization column of a platform audit entry. organization_id becomes NULL
 * when the organization is deleted (ON DELETE SET NULL; the record itself is
 * immutable), while target_id keeps the id: an organization-targeted entry
 * without organization is therefore a deleted organization.
 */
export function auditOrganizationLabel(entry: AdminAuditEntry): { id: string; name: string } | { deleted: true } | null {
  if (entry.organization) return { id: entry.organization.id, name: entry.organization.name ?? "Organización eliminada" };
  if (entry.targetType === "organization" && entry.targetId) return { deleted: true };
  return null;
}

/** Activity line: the recorded event name, otherwise action + entity type. */
export function activityLabel(item: AdminActivityItem): string {
  if (item.event) return item.event;
  return [item.action, item.entityType].filter(Boolean).join(" · ");
}

const numberFormatter = new Intl.NumberFormat("es");

export function formatCount(value: number): string {
  return numberFormatter.format(value);
}
