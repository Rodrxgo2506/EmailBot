import {
  BILLING_PERIODS,
  COMMERCIAL_PLANS,
  MANUAL_PAYMENT_METHODS,
  type AdminSubscription,
  type BillingPeriod,
  type CommercialPlan,
  type ManualPaymentMethod,
  type SubscriptionAction
} from "@emailbot/types";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { BILLING_PERIOD_LABELS, formatPen, PAYMENT_METHOD_LABELS, PLAN_LABELS, SUBSCRIPTION_STATUS_LABELS } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { useActivateSubscription, useAdminPlanPrices, useAdminSubscription, useSubscriptionAction } from "./admin-queries";
import {
  ACTIVATION_OUTCOME_LABELS,
  activationProblem,
  addPeriod,
  availableActions,
  currentSubscription,
  defaultActivation,
  listPrice,
  periodEnded,
  SUBSCRIPTION_ACTION_COPY,
  toActivation,
  type ActivationForm
} from "./subscription-model";

/*
 * Commercial V1.1: the Super Admin manages the organization's subscription
 * after a manual payment (Yape, cash, transfer, other). Every operation goes
 * through the API to the single subscription core in the database (audited);
 * the payment provider (Culqi) will use the same core in the next phase.
 */

const STATUS_VARIANT = {
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "warning",
  CANCELED: "destructive",
  EXPIRED: "outline"
} as const;

function SubscriptionSummary({ subscription }: { subscription: AdminSubscription }) {
  const ended = periodEnded(subscription);
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <dt className="text-xs text-muted-foreground">Estado</dt>
        <dd className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[subscription.status]}>{SUBSCRIPTION_STATUS_LABELS[subscription.status]}</Badge>
          {ended && subscription.status === "ACTIVE" ? <span className="text-xs text-destructive">Periodo terminado: sin acceso</span> : null}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Plan</dt>
        <dd className="mt-1 font-medium">
          {PLAN_LABELS[subscription.plan]} · {BILLING_PERIOD_LABELS[subscription.billingPeriod]} · {formatPen(subscription.listAmount)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Periodo</dt>
        <dd className="mt-1 font-medium">
          {formatDate(subscription.currentPeriodStart)} → {formatDate(subscription.currentPeriodEnd)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Método</dt>
        <dd className="mt-1 font-medium">{PAYMENT_METHOD_LABELS[subscription.paymentMethod]}</dd>
      </div>
    </dl>
  );
}

export function ActivateSubscriptionDialog({
  organizationId,
  organizationName,
  current,
  open,
  onOpenChange
}: {
  organizationId: string;
  organizationName: string;
  current: AdminSubscription | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const prices = useAdminPlanPrices();
  const activate = useActivateSubscription();
  const [form, setForm] = useState<ActivationForm>(() => defaultActivation(current, []));
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(defaultActivation(current, prices.data ?? []));
      setProblem(null);
      activate.reset();
    }
    // Reset when the dialog opens or the prices arrive.
  }, [open, prices.data]);

  const set = (patch: Partial<ActivationForm>) => setForm((value) => ({ ...value, ...patch }));
  /** Plan or period changed: list price and end date follow (both stay editable). */
  const choose = (plan: CommercialPlan, billingPeriod: BillingPeriod) =>
    set({ plan, billingPeriod, amount: listPrice(prices.data ?? [], plan, billingPeriod), end: addPeriod(form.start, billingPeriod) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = activationProblem(form);
    if (invalid) return setProblem(invalid);
    setProblem(null);
    const result = await activate.mutateAsync({ id: organizationId, input: toActivation(form) });
    toast.success(ACTIVATION_OUTCOME_LABELS[result.outcome]);
    onOpenChange(false);
  }

  const error = problem ? new Error(problem) : activate.error ? new Error(getErrorMessage(activate.error)) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? "Registrar pago (renovar o cambiar plan)" : "Registrar pago y activar suscripción"}</DialogTitle>
          <DialogDescription>
            {organizationName}. Pago recibido fuera de Culqi. Los precios incluyen IGV. Las fechas son días en hora de Lima.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event).catch(() => undefined)} className="grid gap-4" noValidate>
          <ErrorMessage error={error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan" htmlFor="subscription-plan">
              <Select id="subscription-plan" value={form.plan} onChange={(event) => choose(event.target.value as CommercialPlan, form.billingPeriod)}>
                {COMMERCIAL_PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {PLAN_LABELS[plan]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Periodo" htmlFor="subscription-period">
              <Select id="subscription-period" value={form.billingPeriod} onChange={(event) => choose(form.plan, event.target.value as BillingPeriod)}>
                {BILLING_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {BILLING_PERIOD_LABELS[period]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Método de pago" htmlFor="subscription-method">
              <Select id="subscription-method" value={form.paymentMethod} onChange={(event) => set({ paymentMethod: event.target.value as ManualPaymentMethod })}>
                {MANUAL_PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Importe pagado (S/)" htmlFor="subscription-amount">
              <Input id="subscription-amount" inputMode="decimal" value={form.amount} onChange={(event) => set({ amount: event.target.value })} placeholder="39.90" />
            </Field>
            <Field label="Inicio" htmlFor="subscription-start">
              <Input
                id="subscription-start"
                type="date"
                value={form.start}
                onChange={(event) => set({ start: event.target.value, end: event.target.value ? addPeriod(event.target.value, form.billingPeriod) : form.end })}
              />
            </Field>
            <Field label="Vencimiento" htmlFor="subscription-end">
              <Input id="subscription-end" type="date" value={form.end} onChange={(event) => set({ end: event.target.value })} />
            </Field>
          </div>
          <Field label="Referencia del pago (opcional)" htmlFor="subscription-reference">
            <Input
              id="subscription-reference"
              value={form.reference}
              onChange={(event) => set({ reference: event.target.value })}
              placeholder="N.º de operación Yape / transferencia"
            />
          </Field>
          <Field label="Nota (opcional)" htmlFor="subscription-note">
            <Textarea id="subscription-note" rows={2} value={form.note} onChange={(event) => set({ note: event.target.value })} />
          </Field>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={activate.isPending || prices.isPending}>
              {activate.isPending ? "Registrando…" : current ? "Registrar pago" : "Activar suscripción"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SubscriptionSection({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const query = useAdminSubscription(organizationId);
  const action = useSubscriptionAction();
  const [activating, setActivating] = useState(false);
  const [pending, setPending] = useState<{ subscription: AdminSubscription; action: SubscriptionAction } | null>(null);

  const current = query.data ? currentSubscription(query.data.subscriptions) : null;
  const history = query.data?.subscriptions.filter((subscription) => subscription.id !== current?.id) ?? [];
  const copy = pending ? SUBSCRIPTION_ACTION_COPY[pending.action] : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Suscripción</CardTitle>
          <p className="text-sm text-muted-foreground">EmailBot es de pago: sin una suscripción activa la organización no puede usar el producto.</p>
        </div>
        <Button onClick={() => setActivating(true)} disabled={!query.data}>
          {current ? "Registrar pago" : "Activar suscripción"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {query.isPending ? (
          <SkeletonRows rows={3} />
        ) : query.error ? (
          <ErrorMessage error={new Error(getErrorMessage(query.error))} />
        ) : (
          <>
            {current ? (
              <div className="space-y-3">
                <SubscriptionSummary subscription={current} />
                <div className="flex flex-wrap gap-2">
                  {availableActions(current).map((name) => (
                    <Button
                      key={name}
                      size="sm"
                      variant={SUBSCRIPTION_ACTION_COPY[name].destructive ? "outline" : "default"}
                      className={SUBSCRIPTION_ACTION_COPY[name].destructive ? "text-destructive" : undefined}
                      onClick={() => setPending({ subscription: current, action: name })}
                    >
                      {SUBSCRIPTION_ACTION_COPY[name].label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sin suscripción activa. Registra el pago para activarla.</p>
            )}

            {query.data.paymentEvents.length > 0 ? (
              <div className="overflow-x-auto">
                <p className="mb-2 text-sm font-medium">Pagos registrados</p>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Fecha</th>
                      <th className="py-1 pr-3 font-medium">Método</th>
                      <th className="py-1 pr-3 text-right font-medium">Importe</th>
                      <th className="py-1 pr-3 font-medium">Referencia</th>
                      <th className="py-1 font-medium">Nota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {query.data.paymentEvents.map((payment) => (
                      <tr key={payment.id}>
                        <td className="py-1.5 pr-3">{formatDate(payment.occurredAt)}</td>
                        <td className="py-1.5 pr-3">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{payment.amount ? formatPen(payment.amount) : "—"}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{payment.reference ?? "—"}</td>
                        <td className="py-1.5 text-muted-foreground">{payment.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {history.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-medium">Suscripciones anteriores</p>
                <ul className="space-y-1 text-sm">
                  {history.map((subscription) => (
                    <li key={subscription.id} className="flex flex-wrap gap-2 text-muted-foreground">
                      <Badge variant={STATUS_VARIANT[subscription.status]}>{SUBSCRIPTION_STATUS_LABELS[subscription.status]}</Badge>
                      {PLAN_LABELS[subscription.plan]} · {BILLING_PERIOD_LABELS[subscription.billingPeriod]} · {formatDate(subscription.startedAt)} →{" "}
                      {formatDate(subscription.canceledAt ?? subscription.expiredAt ?? subscription.currentPeriodEnd)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      <ActivateSubscriptionDialog
        organizationId={organizationId}
        organizationName={organizationName}
        current={current}
        open={activating}
        onOpenChange={setActivating}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => (open ? undefined : setPending(null))}
        title={copy?.title ?? ""}
        description={copy?.description ?? ""}
        confirmLabel={copy?.label ?? "Confirmar"}
        destructive={copy?.destructive ?? true}
        onConfirm={async () => {
          if (!pending || !copy) return;
          await action.mutateAsync({ subscriptionId: pending.subscription.id, action: pending.action });
          toast.success(copy.success);
        }}
      />
    </Card>
  );
}
