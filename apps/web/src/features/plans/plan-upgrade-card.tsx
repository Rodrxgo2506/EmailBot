import type { CommercialPlan, PlanCatalogEntry } from "@emailbot/types";
import { Check } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { getErrorMessage } from "@/lib/errors";
import { usePlanCatalog } from "./api";
import { ComingSoonDialog } from "./coming-soon-dialog";
import { formatPrice, monthlyPrice, upgradeBenefits, upgradeOptions } from "./plans-model";

/**
 * Settings > Mi plan: the plans above the organization's current one and what
 * each adds. Choosing one only shows the "Próximamente" notice (no payment).
 * currentPlan null = no commercial access (every plan is offered).
 */
export function PlanUpgradeCard({ currentPlan }: { currentPlan: CommercialPlan | null }) {
  const catalog = usePlanCatalog();
  const [choosing, setChoosing] = useState<PlanCatalogEntry | null>(null);

  if (catalog.isPending) return <SkeletonRows rows={2} />;
  if (catalog.error) return <ErrorMessage error={new Error(getErrorMessage(catalog.error))} />;

  const current = catalog.data.find((plan) => plan.code === currentPlan) ?? null;
  const options = upgradeOptions(catalog.data, currentPlan);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>{current ? "Mejorar plan" : "Planes disponibles"}</CardTitle>
          <CardDescription>
            {options.length === 0 ? "Actualmente tienes el plan más completo." : "Lo que obtienes al cambiar de plan. Precios mensuales, IGV incluido."}
          </CardDescription>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/planes">Comparar planes</Link>
        </Button>
      </CardHeader>
      {options.length > 0 ? (
        <CardContent className="grid gap-4 md:grid-cols-2">
          {options.map((plan) => {
            const price = monthlyPrice(plan);
            return (
              <div key={plan.code} role="group" aria-label={`Plan ${plan.name}`} className="flex flex-col gap-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{plan.name}</span>
                  {plan.badge ? <Badge>{plan.badge}</Badge> : null}
                </div>
                {price ? (
                  <p className="text-sm">
                    <span className="text-lg font-semibold tabular-nums">{formatPrice(price)}</span> <span className="text-muted-foreground">/ mes</span>
                  </p>
                ) : null}
                <ul className="grid gap-1.5 text-sm" aria-label={`Qué obtienes con ${plan.name}`}>
                  {upgradeBenefits(current, plan).map((benefit) => (
                    <li key={benefit} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      {benefit}
                    </li>
                  ))}
                </ul>
                <Button className="mt-auto" variant={plan.badge ? "default" : "outline"} onClick={() => setChoosing(plan)}>
                  {current ? `Mejorar a ${plan.name}` : `Elegir ${plan.name}`}
                </Button>
              </div>
            );
          })}
        </CardContent>
      ) : null}
      <ComingSoonDialog plan={choosing} onOpenChange={(open) => !open && setChoosing(null)} />
    </Card>
  );
}
