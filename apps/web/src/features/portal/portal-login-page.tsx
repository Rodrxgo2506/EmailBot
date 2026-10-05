import { KeyRound, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/form-controls";
import { LegalLinks } from "@/features/legal/legal-layout";
import { portalErrorMessage } from "./portal-api";
import { usePortalLogin } from "./portal-queries";

/** Customer portal sign-in with an Access ID. The session cookie is set by the API (httpOnly). */
export function PortalLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const login = usePortalLogin();
  const [accessId, setAccessId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const expired = params.get("expired") === "1";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!accessId.trim()) {
      setError("Ingresa tu Access ID.");
      return;
    }
    try {
      await login.mutateAsync(accessId.trim());
      setAccessId("");
      navigate("/portal", { replace: true });
    } catch (loginError) {
      setError(portalErrorMessage(loginError, "login"));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mail className="size-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">EmailBot</span>
        </div>
        <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-xl border bg-background p-6 shadow-sm" noValidate>
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold">Accede a tus correos</h1>
            <p className="text-sm text-muted-foreground">Ingresa el Access ID que te entregaron.</p>
          </div>
          {expired && !error ? (
            <p role="status" className="rounded-md border bg-muted px-3 py-2 text-sm">
              Tu sesión terminó. Vuelve a ingresar con tu Access ID.
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="portal-access-id">Access ID</Label>
            <Input
              id="portal-access-id"
              name="accessId"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="SP-XXXXXXXXXXXX"
              className="font-mono tracking-wider"
              value={accessId}
              onChange={(event) => setAccessId(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={login.isPending}>
            <KeyRound /> {login.isPending ? "Ingresando…" : "Ingresar"}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">Si no tienes un Access ID, solicítalo a quien te dio acceso.</p>
        <p className="mt-2 text-center text-xs text-muted-foreground">Al ingresar aceptas los Términos de Servicio y la Política de Privacidad.</p>
        <LegalLinks className="mt-2 justify-center text-xs" />
      </div>
    </main>
  );
}
