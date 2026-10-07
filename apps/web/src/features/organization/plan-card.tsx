import { Check, Minus } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { getErrorMessage } from "@/lib/errors";
import { PlanUpgradeCard } from "@/features/plans/plan-upgrade-card";
import { cn } from "@/lib/utils";
import { usePlanOverview } from "./api";
import { hasAccess, planDescription, planFeatures, planTitle, planUsageRows } from "./plan-model";

/** Settings > Mi plan: the current plan (usage, features) and the plans above it. */
export function MyPlanSection() {
  const overview = usePlanOverview();
  const currentPlan = overview.data && hasAccess(overview.data) ? overview.data.entitlements.effectivePlan : null;

  return (
    <section id="mi-plan" aria-labelledby="mi-plan-title" className="scroll-mt-20 space-y-4">
      <h2 id="mi-plan-title" className="text-lg font-semibold tracking-tight">
        Mi plan
      </h2>
      <PlanCard />
      {overview.data ? <PlanUpgradeCard currentPlan={currentPlan} /> : null}
    </section>
  );
}

/**
 * Commercial V1 / V1.1: subscription, plan, usage and features of the
 * organization (every member). Without an active subscription it only says so
 * (no limits, no features). No self-service purchase or change yet.
 */
export function PlanCard() {
  const overview = usePlanOverview();

  if (overview.isPending) return <SkeletonRows rows={3} />;
  if (overview.error) return <ErrorMessage error={new Error(getErrorMessage(overview.error))} />;

  const data = overview.data;
  const active = hasAccess(data);
  const rows = active ? planUsageRows(data) : [];
  const reached = rows.filter((row) => row.reached);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{planTitle(data)}</CardTitle>
        <CardDescription>{planDescription(data)}</CardDescription>
      </CardHeader>
      {active ? (
        <CardContent className="space-y-5">
          {reached.length > 0 ? (
            <p role="status" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              Alcanzaste el límite de tu plan en: {reached.map((row) => row.label.toLowerCase()).join(", ")}. Lo existente se conserva; para agregar
              más se necesita un plan superior.
            </p>
          ) : null}
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-baseline justify-between gap-3 border-b pb-2">
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className={cn("text-sm font-medium tabular-nums", row.reached && "text-destructive")}>
                  {row.value}
                  {row.reached ? <span className="sr-only"> (límite alcanzado)</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          <ul className="flex flex-wrap gap-2" aria-label="Funcionalidades del plan">
            {planFeatures(data).map((feature) => (
              <li key={feature.key}>
                <Badge variant={feature.enabled ? "secondary" : "outline"} className={cn(!feature.enabled && "text-muted-foreground")}>
                  {feature.enabled ? <Check className="size-3" aria-hidden /> : <Minus className="size-3" aria-hidden />}
                  {feature.label}
                  <span className="sr-only">{feature.enabled ? " (incluido)" : " (no incluido)"}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
