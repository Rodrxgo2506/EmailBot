import type { PlanCatalogEntry } from "@emailbot/types";
import { Info, Mail, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "@/components/layout/theme-toggle";
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

/**
 * Decorative only (aria-hidden, no pointer events): a faint primary halo, two soft blurs and two
 * mail glyphs behind the hero and the cards. Starts below the navbar; fades into the page.
 */
function PlansBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-14 -z-10 h-[46rem] overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(60rem_26rem_at_50%_-4rem,color-mix(in_oklab,var(--primary)_11%,transparent),transparent_70%)] dark:bg-[radial-gradient(60rem_26rem_at_50%_-4rem,color-mix(in_oklab,var(--primary)_17%,transparent),transparent_70%)]" />
      <div className="absolute -left-40 top-24 size-[26rem] rounded-full bg-primary/[0.06] blur-3xl dark:bg-primary/[0.08]" />
      <div className="absolute -right-40 top-52 size-[26rem] rounded-full bg-sky-400/[0.07] blur-3xl dark:bg-sky-400/[0.05]" />
      <Mail className="absolute left-[7%] top-16 hidden size-24 -rotate-12 text-primary/[0.07] lg:block dark:text-primary/[0.12]" strokeWidth={1.25} />
      <Send className="absolute right-[8%] top-32 hidden size-20 rotate-12 text-primary/[0.07] lg:block dark:text-primary/[0.12]" strokeWidth={1.25} />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
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
    // isolate: the decorative backdrop (-z-10) paints above this background and below the content.
    <div className="relative isolate flex min-h-screen flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mail className="size-4" />
            </span>
            <span className="font-semibold tracking-tight">EmailBot</span>
          </Link>
          <nav aria-label="Cuenta" className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
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

      <PlansBackdrop />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-14 pb-12 sm:px-6 sm:pt-20 sm:pb-16">
        <section aria-labelledby="plans-title" className="mx-auto max-w-4xl text-center">
          <h1 id="plans-title" className="text-4xl leading-[1.1] font-semibold tracking-tight text-foreground sm:text-5xl">
            Elige el plan que mejor se adapte a tu operación
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-base text-muted-foreground sm:text-lg">
            Automatiza tus correos, organiza a tus clientes y entrega cada mensaje en el lugar correcto.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">Precios en soles (PEN), IGV incluido.</p>
        </section>

        <section aria-label="Planes" className="mt-14 sm:mt-16">
          {catalog.isPending || viewer === undefined ? (
            <SkeletonRows rows={6} />
          ) : catalog.error ? (
            <ErrorMessage error={new Error(getErrorMessage(catalog.error))} />
          ) : (
            <div className="mx-auto grid max-w-md items-stretch gap-6 lg:max-w-none lg:grid-cols-3 lg:gap-7">
              {catalog.data.map((plan) => (
                <PlanOfferCard key={plan.code} plan={plan} cta={planCta(plan, viewer, catalog.data)} onChoose={setChoosing} />
              ))}
            </div>
          )}
        </section>

        {catalog.data && catalog.data.length > 0 ? (
          <section aria-labelledby="comparison-title" className="mx-auto mt-20 max-w-5xl sm:mt-24">
            <h2 id="comparison-title" className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground sm:mb-10 sm:text-3xl">
              Compara los planes
            </h2>
            <PlanComparison plans={catalog.data} />
            <p className="mx-auto mt-6 flex max-w-4xl items-start justify-center gap-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
              <span>
                La contratación en línea estará disponible próximamente. Mientras tanto, el equipo de EmailBot activa y cambia los planes.
              </span>
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
