import type { PlanCatalogEntry } from "@emailbot/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LEGAL_CONTACT_EMAIL } from "@/features/legal/legal-info";

/**
 * What "choose / upgrade a plan" does until online payments exist: it only
 * informs. Nothing is charged, activated or recorded. The payments phase
 * replaces this dialog with the checkout.
 */
export function ComingSoonDialog({ plan, onOpenChange }: { plan: PlanCatalogEntry | null; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Contratación en línea próximamente</DialogTitle>
          <DialogDescription>
            Estamos preparando el sistema de suscripciones y pagos de EmailBot. Por ahora no se realiza ningún cobro desde esta página.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {plan ? `¿Te interesa el plan ${plan.name}? ` : null}
          Mientras tanto, el equipo de EmailBot puede activar o cambiar tu plan.
          {LEGAL_CONTACT_EMAIL ? (
            <>
              {" "}
              Escríbenos a{" "}
              <a className="font-medium text-primary hover:underline" href={`mailto:${LEGAL_CONTACT_EMAIL}?subject=${encodeURIComponent(`Plan ${plan?.name ?? ""} de EmailBot`)}`}>
                {LEGAL_CONTACT_EMAIL}
              </a>
              .
            </>
          ) : null}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
