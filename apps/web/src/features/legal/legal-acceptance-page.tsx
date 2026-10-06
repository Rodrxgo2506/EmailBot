import type { LegalAcceptanceStatus } from "@emailbot/types";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { FieldError } from "@/components/ui/form-controls";
import { AuthLayout } from "@/features/auth/auth-layout";
import { api, ApiError } from "@/lib/api";
import { getErrorMessage } from "@/lib/errors";
import { useAuth } from "@/providers/auth-provider";
import { meQueryKey, useOrganization, type MeResponse } from "@/providers/organization-provider";
import { PRIVACY_VERSION, TERMS_VERSION } from "./legal-info";

const OUTDATED_MESSAGE = "Los documentos se actualizaron mientras tenías esta página abierta. Recarga la página para ver la versión vigente.";

/**
 * EmailBot V2 phase 7: acceptance of the CURRENT Terms and Privacy Policy by a signed-in user who has not accepted
 * them (RequireLegalAcceptance sends them here). The API records the acceptance for the authenticated user with
 * the server's versions and the database time; this page only sends the versions it displayed, so a page opened
 * before a new version was published cannot accept a text the user has not seen.
 */
export function LegalAcceptancePage() {
  const { loading, legalAcceptanceRequired } = useOrganization();
  const { session, signOut } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [accepted, setAccepted] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from;
  const destination = from?.startsWith("/") && !from.startsWith("/legal/accept") ? from : "/";

  // Already accepted, or just accepted: continue once the provider reports it, so the gate never sees stale data.
  if (!loading && !legalAcceptanceRequired) return <Navigate to={destination} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!accepted) {
      setShowRequired(true);
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<{ legal: LegalAcceptanceStatus }>("/api/me/legal-acceptance", {
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      });
      if (!result.legal.accepted) throw new Error("No se pudo registrar la aceptación. Inténtalo de nuevo.");
      // The API's answer updates /api/me; the redirect above then continues to the page the user wanted.
      queryClient.setQueryData<MeResponse>(meQueryKey(session?.user.id), (old) => (old ? { ...old, legal: result.legal } : old));
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "LEGAL_VERSION_OUTDATED" ? OUTDATED_MESSAGE : getErrorMessage(caught));
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Términos y privacidad"
      description="Para seguir usando EmailBot debes aceptar la versión vigente de nuestros documentos legales."
      footer={
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>
          Cerrar sesión
        </Button>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="grid gap-4" noValidate>
        <ErrorMessage error={error ? new Error(error) : null} />
        <ul className="grid gap-1 text-sm">
          <li>
            <Link to="/terms" target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
              Términos y Condiciones
            </Link>{" "}
            <span className="text-muted-foreground">· versión {TERMS_VERSION}</span>
          </li>
          <li>
            <Link to="/privacy" target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
              Política de Privacidad
            </Link>{" "}
            <span className="text-muted-foreground">· versión {PRIVACY_VERSION}</span>
          </li>
        </ul>
        <div className="grid gap-1.5">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
              checked={accepted}
              aria-invalid={showRequired && !accepted ? true : undefined}
              onChange={(event) => {
                setAccepted(event.target.checked);
                if (event.target.checked) setShowRequired(false);
              }}
            />
            <span>He leído y acepto los Términos y Condiciones y la Política de Privacidad.</span>
          </label>
          <FieldError message={showRequired && !accepted ? "Debes aceptar los Términos y Condiciones y la Política de Privacidad" : undefined} />
        </div>
        <Button type="submit" disabled={submitting || loading}>
          {submitting ? "Guardando…" : "Aceptar y continuar"}
        </Button>
      </form>
    </AuthLayout>
  );
}
