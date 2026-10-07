import type { PlanCatalogEntry } from "@emailbot/types";
import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { LegalLinks } from "@/features/legal/legal-layout";
import { usePlanOverview } from "@/features/organization/api";
import { getErrorMessage } from "@/lib/errors";
import { useAuth } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";
import { usePlanCatalog } from "./api";
import { ComingSoonDialog } from "./coming-soon-dialog";
import { PlanComparison } from "./plan-comparison";
import { PlanOfferCard } from "./plan-offer-card";
import { planCta, type Viewer } from "./plans-model";

/**
 * Who is looking: anonymous, or a member of the active organization with its
 * current plan (the effective plan of GET /api/organizations/current/plan;
 * null without commercial access). undefined while it is being resolved.
 */
function useViewer(): Viewer | undefined {
  const { session, loading } = useAuth();
  const { organization, loading: organizationLoading } = useOrganization();
  const overview = usePlanOverview({ enabled: Boolean(session && organization) });

  if (loading) return undefined;
  if (!session) return { authenticated: false };
  if (organizationLoading) return undefined;
  if (!organization) return { authenticated: true, currentPlan: null };
  if (overview.isPending) return undefined;
  const entitlements = overview.data?.entitlements;
  return { authenticated: true, currentPlan: entitlements && entitlements.access !== "NONE" ? entitlements.effectivePlan : null };
}

/** Public pricing page (/planes): works with or without a session; never charges anything. */
export function PlansPage() {
  const catalog = usePlanCatalog();
  const viewer = useViewer();
  const [choosing, setChoosing] = useState<PlanCatalogEntry | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = "Planes y precios · EmailBot";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mail className="size-4" />
            </span>
            <span className="font-semibold tracking-tight">EmailBot</span>
          </Link>
          <nav aria-label="Cuenta" className="flex items-center gap-2">
            {viewer?.authenticated ? (
              <Button asChild size="sm">
                <Link to="/">Ir al panel</Link>
              </Button>
            ) : (
              <>
                <Button asChild size="sm" variant="ghost">
                  <Link to="/login">Iniciar sesión</Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/register">Crear cuenta</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <section aria-labelledby="plans-title" className="mx-auto max-w-2xl text-center">
          <h1 id="plans-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Elige el plan que mejor se adapte a tu operación
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            Automatiza tus correos, organiza a tus clientes y entrega cada mensaje en el lugar correcto.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">Precios en soles (PEN), IGV incluido.</p>
        </section>

        <section aria-label="Planes" className="mt-12">
          {catalog.isPending || viewer === undefined ? (
            <SkeletonRows rows={6} />
          ) : catalog.error ? (
            <ErrorMessage error={new Error(getErrorMessage(catalog.error))} />
          ) : (
            <div className="mx-auto grid max-w-md gap-6 lg:max-w-none lg:grid-cols-3">
              {catalog.data.map((plan) => (
                <PlanOfferCard key={plan.code} plan={plan} cta={planCta(plan, viewer, catalog.data)} onChoose={setChoosing} />
              ))}
            </div>
          )}
        </section>

        {catalog.data && catalog.data.length > 0 ? (
          <section aria-labelledby="comparison-title" className="mt-16">
            <h2 id="comparison-title" className="mb-6 text-xl font-semibold tracking-tight">
              Compara los planes
            </h2>
            <PlanComparison plans={catalog.data} />
            <p className="mt-4 text-sm text-muted-foreground">
              La contratación en línea estará disponible próximamente. Mientras tanto, el equipo de EmailBot activa y cambia los planes.
            </p>
          </section>
        ) : null}
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>EmailBot</span>
          <LegalLinks />
        </div>
      </footer>

      <ComingSoonDialog plan={choosing} onOpenChange={(open) => !open && setChoosing(null)} />
    </div>
  );
}
