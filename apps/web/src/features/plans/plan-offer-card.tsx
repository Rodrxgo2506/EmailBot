import type { PlanCatalogEntry } from "@emailbot/types";
import { Check, Minus } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/display";
import { cn } from "@/lib/utils";
import { formatPrice, monthlyPrice, planHighlights, yearlyPrice, type PlanCta } from "./plans-model";

/** One plan of the catalog with its call to action (pricing page). */
export function PlanOfferCard({ plan, cta, onChoose }: { plan: PlanCatalogEntry; cta: PlanCta; onChoose(plan: PlanCatalogEntry): void }) {
  const monthly = monthlyPrice(plan);
  const yearly = yearlyPrice(plan);
  const featured = plan.badge !== null;
  const current = cta.kind === "CURRENT";
  const titleId = `plan-${plan.code.toLowerCase()}-title`;

  return (
    <Card
      aria-labelledby={titleId}
      role="group"
      className={cn("relative flex flex-col", featured && "border-primary/60 shadow-md ring-1 ring-primary/30", current && "border-emerald-500/60")}
    >
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id={titleId} className="text-lg">
            {plan.name}
          </CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {current ? <Badge variant="success">Plan actual</Badge> : null}
            {plan.badge ? <Badge>{plan.badge}</Badge> : null}
          </div>
        </div>
        {plan.description ? <CardDescription>{plan.description}</CardDescription> : null}
        {monthly ? (
          <div>
            <p className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">{formatPrice(monthly)}</span>
              <span className="text-sm text-muted-foreground">/ mes</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              IGV incluido{yearly ? ` · o ${formatPrice(yearly)} al año` : null}
            </p>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <ul className="grid gap-2 text-sm" aria-label={`Qué incluye ${plan.name}`}>
          {planHighlights(plan).map((item) => (
            <li key={item.key} className={cn("flex items-start gap-2", !item.included && "text-muted-foreground")}>
              {item.included ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />}
              <span>
                {item.label}
                {item.included ? null : <span className="sr-only"> (no incluido)</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-auto">
          {cta.kind === "REGISTER" ? (
            <Button asChild className="w-full" variant={featured ? "default" : "outline"}>
              <Link to={cta.to}>{cta.label}</Link>
            </Button>
          ) : cta.kind === "CHOOSE" ? (
            <Button className="w-full" variant={featured ? "default" : "outline"} onClick={() => onChoose(plan)}>
              {cta.label}
            </Button>
          ) : (
            <Button className="w-full" variant="secondary" disabled aria-disabled>
              {cta.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
