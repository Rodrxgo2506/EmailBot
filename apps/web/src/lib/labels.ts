import type {
  AuditAction,
  EmailAccountStatus,
  EmailProvider,
  OrganizationRole,
  OrganizationStatus
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

export const ORGANIZATION_STATUS_LABELS: Record<OrganizationStatus, string> = {
  ACTIVE: "Activa",
  SUSPENDED: "Suspendida",
  CANCELLED: "Cancelada"
};
