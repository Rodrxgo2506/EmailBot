import type { PlanCatalogEntry } from "@emailbot/types";
import { Building2, Check, Crown, Mail, Minus, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/display";
import { cn } from "@/lib/utils";
import { formatPrice, monthlyPrice, planHighlights, yearlyPrice, type PlanCta } from "./plans-model";

/* Presentation only: a decorative icon per plan; every text, price and limit comes from the catalog. */
const PLAN_ICONS: Record<string, { icon: LucideIcon; tile: string }> = {
  BASIC: { icon: Mail, tile: "bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/20" },
  PRO: { icon: Crown, tile: "bg-primary text-primary-foreground ring-primary/30 shadow-sm shadow-primary/30 dark:bg-[color-mix(in_oklab,var(--primary)_78%,black)] dark:text-white" },
  BUSINESS: { icon: Building2, tile: "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/20" }
};

const CARD = cn(
  "relative flex h-full flex-col gap-0 rounded-2xl border-border/70 bg-card transition-shadow duration-300",
  "shadow-[0_1px_2px_rgb(15_23_42/0.04),0_16px_40px_-24px_rgb(15_23_42/0.18)] hover:shadow-[0_1px_2px_rgb(15_23_42/0.05),0_20px_44px_-22px_rgb(15_23_42/0.24)]",
  "dark:border-border dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_24px_48px_-24px_rgb(0_0_0/0.65)]"
);

/** The highlighted plan (catalog badge): primary edge, a faint primary wash and a soft halo. */
const FEATURED = cn(
  "border-primary/50 bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--primary)_6%,var(--card)),var(--card)_45%)] ring-1 ring-primary/20",
  "shadow-[0_1px_2px_rgb(15_23_42/0.05),0_24px_56px_-24px_color-mix(in_oklab,var(--primary)_45%,transparent)]",
  "hover:shadow-[0_1px_2px_rgb(15_23_42/0.06),0_28px_60px_-22px_color-mix(in_oklab,var(--primary)_55%,transparent)]",
  "dark:border-primary/60 dark:bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--primary)_14%,var(--card)),var(--card)_55%)] dark:ring-primary/30",
  "dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_0_0_1px_color-mix(in_oklab,var(--primary)_25%,transparent),0_24px_60px_-20px_color-mix(in_oklab,var(--primary)_45%,transparent)]"
);

/** One plan of the catalog with its call to action (pricing page). */
export function PlanOfferCard({ plan, cta, onChoose }: { plan: PlanCatalogEntry; cta: PlanCta; onChoose(plan: PlanCatalogEntry): void }) {
  const monthly = monthlyPrice(plan);
  const yearly = yearlyPrice(plan);
  const featured = plan.badge !== null;
  const current = cta.kind === "CURRENT";
  const titleId = `plan-${plan.code.toLowerCase()}-title`;
  const visual = PLAN_ICONS[plan.code];
  const Icon = visual?.icon ?? Mail;
  const action = "h-11 w-full rounded-xl text-sm font-semibold";
  // Dark: a solid, deeper primary with white text (the default dark primary is light, with dark text).
  const primaryAction = cn(action, "shadow-md shadow-primary/25 dark:bg-[color-mix(in_oklab,var(--primary)_78%,black)] dark:text-white dark:shadow-primary/20 dark:hover:bg-[color-mix(in_oklab,var(--primary)_88%,black)]");

  return (
    <Card aria-labelledby={titleId} role="group" className={cn(CARD, featured && FEATURED, current && "border-emerald-500/60 dark:border-emerald-400/50")}>
      <CardHeader className="gap-0 p-6 pb-0 sm:p-7 sm:pb-0">
        <div className="flex items-start justify-between gap-3">
          <span aria-hidden className={cn("flex size-11 items-center justify-center rounded-xl ring-1", visual?.tile ?? "bg-muted text-muted-foreground ring-border")}>
            <Icon className="size-5" />
          </span>
          <div className="flex flex-wrap justify-end gap-1.5">
            {current ? <Badge variant="success">Plan actual</Badge> : null}
            {plan.badge ? (
              <Badge className="rounded-full border-transparent bg-primary px-2.5 py-1 text-primary-foreground shadow-sm shadow-primary/30 dark:bg-[color-mix(in_oklab,var(--primary)_78%,black)] dark:text-white">
                <Crown aria-hidden className="size-3.5" />
                {plan.badge}
              </Badge>
            ) : null}
          </div>
        </div>
        <CardTitle id={titleId} className="mt-5 text-xl tracking-tight">
          {plan.name}
        </CardTitle>
        {plan.description ? <CardDescription className="mt-2">{plan.description}</CardDescription> : null}
        {monthly ? (
          <div className="mt-5">
            <p className="flex items-baseline gap-1.5">
              <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">{formatPrice(monthly)}</span>
              <span className="text-sm font-medium text-muted-foreground">/ mes</span>
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              IGV incluido{yearly ? ` · o ${formatPrice(yearly)} al año` : null}
            </p>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col p-6 pt-0 sm:p-7 sm:pt-0">
        <div aria-hidden className="my-6 border-t border-border/70 dark:border-border" />
        <ul className="grid gap-3 text-sm" aria-label={`Qué incluye ${plan.name}`}>
          {planHighlights(plan).map((item) => (
            <li key={item.key} className={cn("flex items-start gap-2.5", item.included ? "text-foreground/90" : "text-muted-foreground")}>
              {item.included ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.5} aria-hidden />
              ) : (
                <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground/75 dark:text-muted-foreground/70" aria-hidden />
              )}
              <span>
                {item.label}
                {item.included ? null : <span className="sr-only"> (no incluido)</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-7">
          {cta.kind === "REGISTER" ? (
            <Button asChild className={featured ? primaryAction : action} variant={featured ? "default" : "outline"}>
              <Link to={cta.to}>{cta.label}</Link>
            </Button>
          ) : cta.kind === "CHOOSE" ? (
            <Button className={featured ? primaryAction : action} variant={featured ? "default" : "outline"} onClick={() => onChoose(plan)}>
              {cta.label}
            </Button>
          ) : (
            <Button className={action} variant="secondary" disabled aria-disabled>
              {cta.label}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
