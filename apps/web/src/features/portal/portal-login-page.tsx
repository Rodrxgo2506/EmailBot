import { AlertCircle, ArrowRight, Info, KeyRound, Loader2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BrandLogo } from "@/components/brand-logo";
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
  const pending = login.isPending;
  const inputRef = useRef<HTMLInputElement>(null);
  // Set synchronously, so a second Enter before the next render cannot send the Access ID twice.
  const submitting = useRef(false);

  /** The field keeps (or gets back) the focus with the message, ready to be corrected and sent again. */
  const fail = (message: string) => {
    setError(message);
    inputRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError(null);
    if (!accessId.trim()) {
      fail("Ingresa tu Access ID.");
      return;
    }
    submitting.current = true;
    try {
      await login.mutateAsync(accessId.trim());
      setAccessId("");
      navigate("/portal", { replace: true });
    } catch (loginError) {
      fail(portalErrorMessage(loginError, "login"));
    } finally {
      submitting.current = false;
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background bg-[radial-gradient(60rem_32rem_at_50%_-10%,color-mix(in_oklch,var(--primary)_9%,transparent),transparent)] px-4 py-10 sm:py-14">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <BrandLogo className="h-20 sm:h-24" />
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground sm:text-base">Gestiona y automatiza tus correos de forma simple y segura.</p>
        </div>

        <form onSubmit={(event) => void submit(event)} className="rounded-2xl border bg-card p-6 shadow-card sm:p-8" noValidate aria-busy={pending}>
          <div className="space-y-1.5 text-center">
            <h1 className="text-2xl font-bold tracking-tight">Accede a tus correos</h1>
            <p className="text-sm text-muted-foreground">Ingresa el Access ID que te entregaron para continuar.</p>
          </div>

          {expired && !error ? (
            <p role="status" className="mt-6 flex items-start gap-3 rounded-xl border border-primary/20 bg-accent px-4 py-3 text-sm text-foreground">
              <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              <span>Tu sesión terminó. Vuelve a ingresar con tu Access ID.</span>
            </p>
          ) : null}

          <div className="mt-6 space-y-2">
            <Label htmlFor="portal-access-id" className="font-semibold">
              Access ID
            </Label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute inset-y-1.5 left-1.5 flex w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <KeyRound className="size-4" />
              </span>
              <Input
                ref={inputRef}
                id="portal-access-id"
                name="accessId"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="SP-XXXXXXXXXXXX"
                className="h-12 rounded-xl bg-card pl-13 font-mono text-base tracking-wider shadow-xs transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/20 aria-invalid:focus-visible:ring-destructive/20"
                value={accessId}
                onChange={(event) => setAccessId(event.target.value)}
                // Read-only (not disabled) while signing in: the field keeps the keyboard focus.
                readOnly={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "portal-access-id-error" : undefined}
              />
            </div>
          </div>

          {error ? (
            <p
              id="portal-access-id-error"
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}

          <Button type="submit" className="relative mt-5 h-12 w-full rounded-xl text-base font-semibold shadow-sm [&_svg]:size-5" disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" /> Ingresando…
              </>
            ) : (
              <>
                Ingresar <ArrowRight aria-hidden className="absolute right-5" />
              </>
            )}
          </Button>

          <div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-border" />
            <span>¿No tienes un Access ID?</span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
          <p className="mt-3 text-center text-sm text-muted-foreground">Solicítalo a quien te dio acceso.</p>
        </form>

        <footer className="mt-6 space-y-2 text-center">
          <p className="text-xs text-muted-foreground">Al ingresar aceptas los Términos de Servicio y la Política de Privacidad.</p>
          <LegalLinks className="justify-center text-xs" />
        </footer>
      </div>
    </main>
  );
}
