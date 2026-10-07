import type {
  AuditAction,
  BotStatus,
  CustomerIdentifierType,
  CustomerResolutionSource,
  CustomerStatus,
  EmailAccountStatus,
  EmailProvider,
  MultipleMatchPolicy,
  OrganizationPlan,
  OrganizationRole,
  OrganizationStatus,
  BillingPeriod,
  PaymentMethod,
  PlanFeatureKey,
  PlanLimitKey,
  SubscriptionStatus
} from "@emailbot/types";

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  OWNER: "Propietario",
  ADMIN: "Administrador",
  OPERATOR: "Operador",
  VIEWER: "Lector"
};

export const ROLE_DESCRIPTIONS: Record<OrganizationRole, string> = {
  OWNER: "Control total, incluida la transferencia de propiedad.",
  ADMIN: "Gestiona cuentas, reglas, categorías, miembros y configuración.",
  OPERATOR: "Gestiona correos (leído, importante, categoría) y sincroniza cuentas.",
  VIEWER: "Solo lectura."
};

export const PROVIDER_LABELS: Record<EmailProvider, string> = {
  GMAIL: "Gmail",
  MICROSOFT: "Microsoft (Outlook / 365)",
  IMAP: "IMAP"
};

export const ACCOUNT_STATUS_LABELS: Record<EmailAccountStatus, string> = {
  ACTIVE: "Activa",
  PAUSED: "Pausada",
  ERROR: "Error",
  DISCONNECTED: "Desconectada"
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: "Creación",
  UPDATE: "Actualización",
  DELETE: "Eliminación",
  CONNECT: "Conexión",
  DISCONNECT: "Desconexión",
  LOGIN: "Inicio de sesión",
  LOGOUT: "Cierre de sesión",
  PROCESS: "Procesamiento",
  FAIL: "Fallo",
  READ: "Lectura",
  ARCHIVE: "Archivado",
  UNARCHIVE: "Desarchivado",
  MARK_READ: "Marcado como leído",
  MARK_UNREAD: "Marcado como no leído",
  MARK_IMPORTANT: "Marcado como importante",
  MARK_NOT_IMPORTANT: "Quitado de importantes",
  ROLE_CHANGE: "Cambio de rol",
  OWNERSHIP_TRANSFER: "Transferencia de propiedad"
};

export const ENTITY_LABELS: Record<string, string> = {
  organization: "Organización",
  organization_settings: "Configuración",
  organization_member: "Miembro",
  email_account: "Cuenta de correo",
  category: "Categoría",
  bot: "Bot",
  customer: "Cliente",
  customer_identifier: "Identificador de cliente",
  bot_customer_assignment: "Bot de cliente",
  email_rule: "Regla",
  email: "Correo",
  user: "Usuario"
};

/** Known email_accounts.last_error_code values (set by the API/worker). */
export const ACCOUNT_ERROR_LABELS: Record<string, string> = {
  AUTH_REVOKED: "La autorización del buzón ya no es válida. Reconecta la cuenta.",
  PROVIDER_UNAUTHORIZED: "El proveedor rechazó las credenciales. Reconecta la cuenta.",
  MISSING_REFRESH_TOKEN: "Falta el token de renovación. Reconecta la cuenta.",
  PROVIDER_NOT_CONFIGURED: "El proveedor no está configurado en el servidor.",
  IMAP_SYNC_NOT_IMPLEMENTED: "La sincronización IMAP aún no está disponible. Las credenciales se guardaron cifradas.",
  PROVIDER_NOT_IMPLEMENTED: "Esta integración todavía no está disponible."
};

export const BOT_STATUS_LABELS: Record<BotStatus, string> = {
  ACTIVE: "Activo",
  PAUSED: "Pausado"
};

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  ACTIVE: "Activo",
  SUSPENDED: "Suspendido"
};

export const IDENTIFIER_TYPE_LABELS: Record<CustomerIdentifierType, string> = {
  EMAIL: "Correo",
  PHONE: "Teléfono",
  USERNAME: "Usuario",
  EXTERNAL_ID: "ID externo",
  CUSTOM: "Personalizado"
};

export const CUSTOMER_RESOLUTION_SOURCE_LABELS: Record<CustomerResolutionSource, string> = {
  NONE: "No entregar (desactivado)",
  RECIPIENT: "Destinatario del correo (Para y CC)",
  SENDER: "Remitente del correo",
  EXTRACTED_FIELD: "Dato extraído por una regla del bot"
};

export const MULTIPLE_MATCH_POLICY_LABELS: Record<MultipleMatchPolicy, string> = {
  LEAVE_UNASSIGNED: "No entregarlo a ninguno",
  DELIVER_ALL: "Entregarlo a todos"
};

export const ORGANIZATION_STATUS_LABELS: Record<OrganizationStatus, string> = {
  ACTIVE: "Activa",
  SUSPENDED: "Suspendida",
  CANCELLED: "Cancelada"
};

/** Commercial V1. FREE only exists in organizations created before it (entitled as Básico). EmailBot has no free plan. */
export const PLAN_LABELS: Record<OrganizationPlan, string> = {
  FREE: "Free (legado)",
  BASIC: "Básico",
  PRO: "Pro",
  BUSINESS: "Business"
};

export const PLAN_LIMIT_LABELS: Record<PlanLimitKey, string> = {
  EMAIL_ACCOUNTS: "Cuentas de correo",
  RULES: "Reglas",
  BOTS: "Bots activos",
  MONTHLY_EMAILS: "Correos este mes",
  MEMBERS: "Miembros",
  CUSTOMERS: "Clientes activos",
  STORAGE_BYTES: "Almacenamiento de adjuntos",
  RETENTION_DAYS: "Retención de correos"
};

export const PLAN_FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  GMAIL: "Gmail",
  MICROSOFT: "Microsoft (Outlook / 365)",
  ADVANCED_STATS: "Estadísticas avanzadas",
  PORTAL: "Portal de clientes",
  API: "API",
  PRIORITY_SUPPORT: "Soporte prioritario"
};

/** organizations.plan is null until a subscription is activated (Commercial V1.1). */
export function planLabel(plan: OrganizationPlan | null | undefined): string {
  return plan ? PLAN_LABELS[plan] : "Sin plan";
}

export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  MONTHLY: "Mensual",
  YEARLY: "Anual"
};

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  PAST_DUE: "Pago pendiente",
  SUSPENDED: "Suspendida",
  CANCELED: "Cancelada",
  EXPIRED: "Vencida"
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CULQI: "Tarjeta (Culqi)",
  YAPE: "Yape",
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  MANUAL: "Otro pago manual"
};

/** Prices are in PEN and include IGV (commercial decision; no tax logic in the product yet). */
export function formatPen(amount: string): string {
  return `S/ ${amount}`;
}
