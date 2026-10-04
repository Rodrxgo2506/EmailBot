import { ApiError } from "./api-client";

/** Friendly Spanish messages for stable API error codes. */
const MESSAGES: Record<string, string> = {
  NETWORK_ERROR: "No se pudo conectar con la API. Verifica que esté en ejecución.",
  UNAUTHORIZED: "Tu sesión expiró. Inicia sesión nuevamente.",
  INSUFFICIENT_ROLE: "Tu rol no permite realizar esta acción.",
  NOT_A_MEMBER: "No perteneces a esta organización.",
  NO_ORGANIZATION: "Todavía no perteneces a ninguna organización.",
  ORGANIZATION_REQUIRED: "Selecciona una organización.",
  PROVIDER_NOT_CONFIGURED: "Este proveedor todavía no está configurado en el servidor.",
  RECONNECT_REQUIRED: "La cuenta está desconectada. Conéctala nuevamente.",
  ACCOUNT_NOT_DISCONNECTED: "Desconecta la cuenta antes de eliminarla.",
  ACCOUNT_NOT_ACTIVE: "Solo se pueden sincronizar cuentas activas.",
  IMAP_SYNC_NOT_IMPLEMENTED: "La sincronización IMAP todavía no está disponible.",
  CANNOT_MODIFY_OWNER: "El rol OWNER solo cambia mediante transferencia de propiedad.",
  CANNOT_REMOVE_OWNER: "El OWNER no puede ser eliminado. Transfiere la propiedad primero.",
  CANNOT_CHANGE_OWN_ROLE: "No puedes cambiar tu propio rol.",
  SYSTEM_CATEGORY: "Las categorías del sistema no se pueden eliminar.",
  INVALID_CATEGORY: "La categoría no pertenece a esta organización.",
  INVALID_BOT: "El bot no pertenece a esta organización.",
  INVALID_CUSTOMER: "El cliente no pertenece a esta organización.",
  INVALID_IDENTIFIER: "El identificador no tiene un formato válido.",
  BOT_IN_USE: "Quita los clientes asociados y los identificadores de este bot antes de eliminarlo.",
  BOT_HAS_EMAILS: "Este bot ya tiene correos procesados. Páusalo para conservar su historial.",
  ORGANIZATION_INACTIVE: "Esta organización no está activa. Sus datos se conservan, pero no se puede operar.",
  ALREADY_EXISTS: "Ya existe un recurso con esos datos (por ejemplo, el mismo slug o correo).",
  ATTACHMENT_NOT_STORED: "El contenido de este adjunto no fue almacenado.",
  ALREADY_OWNER: "Ya eres el propietario de esta organización.",
  VALIDATION_ERROR: "Revisa los datos del formulario."
};

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "NOT_FOUND") return error.message;
    if (error.code === "BUSINESS_RULE_VIOLATION") return error.message;
    return MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return "Ocurrió un error inesperado";
}

const AUTH_MESSAGES: Record<string, string> = {
  "Invalid login credentials": "Correo o contraseña incorrectos.",
  "Email not confirmed": "Confirma tu correo antes de iniciar sesión.",
  "User already registered": "Ya existe una cuenta con este correo.",
  "Password should be at least 6 characters.": "La contraseña es demasiado corta."
};

/** Supabase Auth errors -> friendly messages (network failures included). */
export function getAuthErrorMessage(error: { message: string; name?: string } | null | undefined): string {
  if (!error) return "Ocurrió un error inesperado";
  if (error.name === "AuthRetryableFetchError" || error.message === "Failed to fetch") {
    return "No se pudo conectar con el servicio de autenticación. Inténtalo nuevamente.";
  }
  // secure_password_change: password changes require a recent sign-in.
  if (/reauthenticat/i.test(error.message)) {
    return "Por seguridad, cierra sesión e inicia sesión de nuevo antes de cambiar la contraseña.";
  }
  return AUTH_MESSAGES[error.message] ?? error.message;
}
