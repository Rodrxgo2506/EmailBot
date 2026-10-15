import type { BillingPeriod, BillingSubscriptionSummary, CommercialPlan, PlanCatalogEntry } from "@emailbot/types";
import { billingCustomerSchema } from "@emailbot/validation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/form-controls";
import { formatPen } from "@/lib/labels";
import { getErrorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/query-keys";
import { useOrganization, useOrganizationId } from "@/providers/organization-provider";
import { createBillingSubscription, getCheckoutOptions, useCurrentBillingSubscription } from "./api";
import { requestCardToken } from "./culqi-checkout";

/*
 * Commercial V1 phase 2 (Culqi SANDBOX): card checkout of a plan.
 *   1. period + billing contact (Culqi requires it to create the customer) + explicit acceptance of the terms;
 *   2. the API resolves the price and hands the PUBLIC key; Culqi's checkout tokenizes the card;
 *   3. only the token goes to the API, which creates the Culqi subscription (PENDING);
 *   4. the plan changes only when the payment is confirmed (webhook / reconciliation): this dialog waits for it.
 */

const schema = billingCustomerSchema.safeExtend({
  billingPeriod: z.enum(["MONTHLY", "YEARLY"]),
  acceptTerms: z.boolean().refine((value) => value, "Debes aceptar los Términos para continuar")
});
type CheckoutValues = z.input<typeof schema>;

type Step = { kind: "form" } | { kind: "paying" } | { kind: "waiting"; billingId: string } | { kind: "done"; summary: BillingSubscriptionSummary };

const WAIT_NOTICE_MS = 90_000;

function priceOf(plan: PlanCatalogEntry, period: BillingPeriod): string | null {
  const price = plan.prices.find((item) => item.billingPeriod === period && item.currency === "PEN");
  return price ? formatPen(price.amount) : null;
}

export function CheckoutDialog({
  plan,
  sandbox,
  onOpenChange
}: {
  plan: PlanCatalogEntry;
  /** Culqi's integration environment: no real charge. */
  sandbox: boolean;
  onOpenChange(open: boolean): void;
}) {
  const queryClient = useQueryClient();
  const organizationId = useOrganizationId();
  const { refresh } = useOrganization();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<unknown>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const form = useForm<CheckoutValues>({
    resolver: zodResolver(schema),
    defaultValues: { billingPeriod: "MONTHLY", firstName: "", lastName: "", phoneNumber: "", address: "", addressCity: "", countryCode: "PE", acceptTerms: false }
  });

  const waiting = step.kind === "waiting";
  const current = useCurrentBillingSubscription(waiting);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => {
    if (step.kind !== "waiting" || !current.data || current.data.id !== step.billingId) return;
    if (current.data.status === "ACTIVE" || current.data.status === "FAILED") {
      setStep({ kind: "done", summary: current.data });
      if (current.data.status === "ACTIVE") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.org(organizationId) });
        void refresh();
      }
    }
  }, [current.data, step, queryClient, organizationId, refresh]);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setStep({ kind: "paying" });
    try {
      const billingPeriod = values.billingPeriod as BillingPeriod;
      const options = await getCheckoutOptions(plan.code, billingPeriod);
      const tokenId = await requestCardToken({ publicKey: options.publicKey, amountCents: options.amountCents, currency: options.currency, email: options.customerEmail });
      const customer = billingCustomerSchema.parse({
        firstName: values.firstName,
        lastName: values.lastName,
        phoneNumber: values.phoneNumber,
        address: values.address,
        addressCity: values.addressCity,
        countryCode: values.countryCode
      });
      const result = await createBillingSubscription({ plan: plan.code as CommercialPlan, billingPeriod, tokenId, acceptTerms: true, customer });
      setWaitingSince(Date.now());
      setStep({ kind: "waiting", billingId: result.billingSubscription.id });
    } catch (caught) {
      setError(caught);
      setStep({ kind: "form" });
    }
  });

  const monthly = priceOf(plan, "MONTHLY");
  const yearly = priceOf(plan, "YEARLY");
  const slow = waitingSince !== null && now - waitingSince > WAIT_NOTICE_MS;

  return (
    <Dialog open onOpenChange={(open) => step.kind !== "paying" && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Contratar el plan {plan.name}</DialogTitle>
          <DialogDescription>Pago con tarjeta mediante Culqi. Los precios incluyen IGV.</DialogDescription>
        </DialogHeader>

        {sandbox ? (
          <p role="note" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            Entorno de pruebas de Culqi: no se realizan cobros reales. Usa una tarjeta de prueba de Culqi.
          </p>
        ) : null}

        {step.kind === "waiting" ? (
          <div role="status" className="grid gap-3 py-2 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Esperando la confirmación del pago…
            </p>
            <p className="text-muted-foreground">
              Culqi confirma los cobros de las suscripciones de forma asíncrona. Tu plan cambiará cuando el pago esté confirmado.
            </p>
            {slow ? (
              <p className="text-muted-foreground">La confirmación está tardando. Puedes cerrar esta ventana: tu plan se activará cuando Culqi confirme el pago.</p>
            ) : null}
          </div>
        ) : step.kind === "done" ? (
          step.summary.status === "ACTIVE" ? (
            <p role="status" className="flex items-center gap-2 py-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> Pago confirmado. Tu plan {plan.name} ya está activo.
            </p>
          ) : (
            <ErrorMessage error={new Error(`El pago no se pudo completar${step.summary.failureMessage ? `: ${step.summary.failureMessage}` : ""}. No se activó ningún plan.`)} />
          )
        ) : (
          <form id="checkout-form" onSubmit={onSubmit} className="grid gap-4" noValidate>
            <ErrorMessage error={error ? new Error(getErrorMessage(error)) : null} />
            <Field label="Periodicidad" htmlFor="checkout-period">
              <Select id="checkout-period" {...form.register("billingPeriod")} disabled={step.kind === "paying"}>
                {monthly ? <option value="MONTHLY">Mensual · {monthly} / mes</option> : null}
                {yearly ? <option value="YEARLY">Anual · {yearly} / año</option> : null}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombres" htmlFor="checkout-first-name" error={form.formState.errors.firstName?.message}>
                <Input id="checkout-first-name" autoComplete="given-name" {...form.register("firstName")} />
              </Field>
              <Field label="Apellidos" htmlFor="checkout-last-name" error={form.formState.errors.lastName?.message}>
                <Input id="checkout-last-name" autoComplete="family-name" {...form.register("lastName")} />
              </Field>
              <Field label="Teléfono" htmlFor="checkout-phone" error={form.formState.errors.phoneNumber?.message}>
                <Input id="checkout-phone" type="tel" autoComplete="tel" {...form.register("phoneNumber")} />
              </Field>
              <Field label="País" htmlFor="checkout-country" error={form.formState.errors.countryCode?.message}>
                <Select id="checkout-country" {...form.register("countryCode")}>
                  <option value="PE">Perú</option>
                </Select>
              </Field>
              <Field label="Dirección" htmlFor="checkout-address" error={form.formState.errors.address?.message}>
                <Input id="checkout-address" autoComplete="street-address" {...form.register("address")} />
              </Field>
              <Field label="Ciudad" htmlFor="checkout-city" error={form.formState.errors.addressCity?.message}>
                <Input id="checkout-city" autoComplete="address-level2" {...form.register("addressCity")} />
              </Field>
            </div>
            <div className="grid gap-1.5">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" {...form.register("acceptTerms")} />
                <span>
                  Acepto los{" "}
                  <Link to="/terms" target="_blank" className="font-medium text-primary hover:underline">
                    Términos
                  </Link>{" "}
                  y que la suscripción se renueva automáticamente cada periodo con cargo a la tarjeta hasta que la canceles.
                </span>
              </label>
              {form.formState.errors.acceptTerms?.message ? <p role="alert" className="text-xs text-destructive">{form.formState.errors.acceptTerms.message}</p> : null}
            </div>
            <p className="text-xs text-muted-foreground">Los datos de tu tarjeta se ingresan en el formulario seguro de Culqi; EmailBot no los recibe ni los guarda.</p>
          </form>
        )}

        <DialogFooter>
          {step.kind === "form" || step.kind === "paying" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={step.kind === "paying"}>
                Cancelar
              </Button>
              <Button type="submit" form="checkout-form" disabled={step.kind === "paying"}>
                {step.kind === "paying" ? "Procesando…" : "Continuar al pago"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
