import type { PlanCatalogEntry } from "@emailbot/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SkeletonRows } from "@/components/ui/feedback";
import { ComingSoonDialog } from "@/features/plans/coming-soon-dialog";
import { useBillingConfig } from "./api";
import { CheckoutDialog } from "./checkout-dialog";

/**
 * What "choose / upgrade a plan" opens: Culqi's card checkout when the API
 * has it configured (sandbox in this phase), otherwise the "Próximamente"
 * notice. Asked only when a plan is chosen.
 */
export function ChoosePlanDialog({ plan, onOpenChange }: { plan: PlanCatalogEntry | null; onOpenChange(open: boolean): void }) {
  const config = useBillingConfig(plan !== null);

  if (!plan) return null;
  if (config.isPending) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan {plan.name}</DialogTitle>
            <DialogDescription>Preparando el pago…</DialogDescription>
          </DialogHeader>
          <SkeletonRows rows={2} />
        </DialogContent>
      </Dialog>
    );
  }
  if (config.data?.enabled === true) return <CheckoutDialog plan={plan} sandbox={config.data.environment === "test"} onOpenChange={onOpenChange} />;
  return <ComingSoonDialog plan={plan} onOpenChange={onOpenChange} />;
}
