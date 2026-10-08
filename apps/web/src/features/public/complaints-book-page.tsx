import { zodResolver } from "@hookform/resolvers/zod";
import type { ComplaintBookReceipt } from "@emailbot/types";
import { complaintBookSubmissionSchema, type ComplaintBookSubmission, type ComplaintBookSubmissionInput } from "@emailbot/validation";
import { BookOpenText, CheckCircle2, Printer } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/display";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/form-controls";
import { LEGAL_CONTACT_EMAIL, SERVICE_OPERATOR, SERVICE_OPERATOR_RUC, SERVICE_PUBLIC_ADDRESS_LINE } from "@/features/legal/legal-info";
import { getErrorMessage } from "@/lib/errors";
import { usePageMeta } from "@/lib/page-meta";
import { newSubmissionId, useSubmitComplaint } from "./complaints-api";
import { PublicLayout } from "./public-layout";

/*
 * Libro de Reclamaciones virtual (/libro-de-reclamaciones), own form of emailbot.app (no external form).
 * Fields follow the "Hoja de Reclamación" of the Reglamento del Libro de Reclamaciones (D.S. 011-2011-PCM
 * and amendments): provider, correlative number and date, consumer, contracted good, RECLAMO / QUEJA, detail
 * and request. Validated with the same schema as the API.
 */

const LIMA_DATE = new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeStyle: "short", timeZone: "America/Lima" });
const LIMA_DAY = new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeZone: "America/Lima" });

const DEFAULTS: ComplaintBookSubmissionInput = {
  kind: "RECLAMO",
  firstNames: "",
  lastNames: "",
  documentType: "DNI",
  documentNumber: "",
  email: "",
  phone: "",
  address: "",
  isMinor: false,
  guardianName: "",
  goodType: "SERVICIO",
  goodDescription: "",
  claimedAmount: "",
  detail: "",
  consumerRequest: "",
  confirmTruth: false as unknown as true,
  website: ""
};

function FormSection({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-2xl border border-border/70 bg-card p-5 sm:p-6 dark:border-border">
      <legend className="px-1 text-sm font-semibold text-foreground">
        <span className="mr-1.5 text-muted-foreground">{number}.</span>
        {title}
      </legend>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Receipt({ receipt, onAnother }: { receipt: ComplaintBookReceipt; onAnother(): void }) {
  return (
    <section aria-labelledby="receipt-title" className="rounded-2xl border border-emerald-500/40 bg-card p-6 text-center shadow-sm sm:p-8">
      <CheckCircle2 aria-hidden className="mx-auto size-10 text-emerald-600 dark:text-emerald-400" />
      <h2 id="receipt-title" className="mt-4 text-xl font-semibold tracking-tight">
        Recibimos tu {receipt.kind === "QUEJA" ? "queja" : "reclamo"}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">Tu hoja de reclamación quedó registrada en el Libro de Reclamaciones de EmailBot.</p>
      <dl className="mx-auto mt-6 grid max-w-sm gap-3 text-left text-sm">
        <div className="flex justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3">
          <dt className="text-muted-foreground">Número</dt>
          <dd className="font-mono font-semibold" data-testid="complaint-code">
            {receipt.code}
          </dd>
        </div>
        <div className="flex justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3">
          <dt className="text-muted-foreground">Fecha</dt>
          <dd className="text-right font-medium">{LIMA_DATE.format(new Date(receipt.createdAt))}</dd>
        </div>
      </dl>
      <p className="mx-auto mt-6 max-w-md text-sm text-muted-foreground">
        <strong className="text-foreground">Conserva este número</strong>: lo necesitarás para cualquier consulta sobre tu reclamación. Te
        responderemos al correo que indicaste en un plazo no mayor a quince (15) días hábiles.
      </p>
      {receipt.confirmationEmail === "SENT" ? (
        <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground" data-testid="complaint-copy-status">
          Te enviamos una copia de tu hoja de reclamación al correo que indicaste.
        </p>
      ) : (
        <p
          role="status"
          className="mx-auto mt-3 max-w-md rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
          data-testid="complaint-copy-status"
        >
          Tu reclamación quedó registrada, pero todavía no pudimos confirmar el envío de la copia por correo. Imprime o guarda esta
          constancia; si no recibes la copia, escríbenos indicando tu número.
        </p>
      )}
      <div className="mt-6 flex flex-col justify-center gap-3 print:hidden sm:flex-row">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer aria-hidden />
          Imprimir constancia
        </Button>
        <Button variant="ghost" onClick={onAnother}>
          Registrar otra hoja
        </Button>
      </div>
    </section>
  );
}

export function ComplaintsBookPage() {
  usePageMeta(
    "Libro de Reclamaciones · EmailBot",
    "Libro de Reclamaciones virtual de EmailBot: registra una queja o un reclamo sobre nuestros productos o servicios."
  );
  const submit = useSubmitComplaint();
  const [receipt, setReceipt] = useState<ComplaintBookReceipt | null>(null);
  // Same id while this form is being sent (and retried); a new one for the next sheet.
  const submissionId = useRef(newSubmissionId());
  const form = useForm<ComplaintBookSubmissionInput, unknown, ComplaintBookSubmission>({
    resolver: zodResolver(complaintBookSubmissionSchema),
    defaultValues: DEFAULTS
  });
  const errors = form.formState.errors;
  const isMinor = form.watch("isMinor");

  // The API error (validation, rate limit...) is shown from submit.error; the form keeps what was typed.
  const onSubmit = form.handleSubmit((values) =>
    submit.mutateAsync({ ...values, ...(submissionId.current ? { submissionId: submissionId.current } : {}) }).then(
      (result) => {
        setReceipt(result);
        submissionId.current = newSubmissionId();
        form.reset(DEFAULTS);
        window.scrollTo({ top: 0 });
      },
      () => undefined
    )
  );

  return (
    <PublicLayout>
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <header>
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BookOpenText className="size-5" />
            </span>
            <h1 className="text-3xl font-semibold tracking-tight">Libro de Reclamaciones</h1>
          </div>
          <p className="mt-4 text-base text-muted-foreground">
            Este formulario permite registrar una queja o reclamo relacionado con los productos o servicios de EmailBot.
          </p>
          <dl className="mt-6 grid gap-x-6 gap-y-2 rounded-2xl border border-border/70 bg-muted/40 p-5 text-sm sm:grid-cols-2 dark:border-border">
            <div>
              <dt className="text-muted-foreground">Proveedor</dt>
              <dd className="font-medium">{SERVICE_OPERATOR ? `${SERVICE_OPERATOR} (EmailBot)` : "EmailBot"}</dd>
            </div>
            {SERVICE_OPERATOR_RUC ? (
              <div>
                <dt className="text-muted-foreground">RUC</dt>
                <dd className="font-medium">{SERVICE_OPERATOR_RUC}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted-foreground">Dirección</dt>
              <dd className="font-medium">{SERVICE_PUBLIC_ADDRESS_LINE}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Fecha</dt>
              <dd className="font-medium">{LIMA_DAY.format(new Date())}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Hoja de reclamación N.º</dt>
              <dd className="font-medium">Se asigna automáticamente al registrarla.</dd>
            </div>
          </dl>
        </header>

        <div className="mt-8">
          {receipt ? (
            <Receipt receipt={receipt} onAnother={() => setReceipt(null)} />
          ) : (
            <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6" aria-label="Hoja de reclamación">
              <FormSection number={1} title="Identificación del consumidor reclamante">
                <Field label="Nombres" htmlFor="cb-first" error={errors.firstNames?.message}>
                  <Input id="cb-first" autoComplete="given-name" {...form.register("firstNames")} />
                </Field>
                <Field label="Apellidos" htmlFor="cb-last" error={errors.lastNames?.message}>
                  <Input id="cb-last" autoComplete="family-name" {...form.register("lastNames")} />
                </Field>
                <Field label="Tipo de documento" htmlFor="cb-doc-type" error={errors.documentType?.message}>
                  <Select id="cb-doc-type" {...form.register("documentType")}>
                    <option value="DNI">DNI</option>
                    <option value="CE">Carné de extranjería</option>
                    <option value="PASAPORTE">Pasaporte</option>
                    <option value="RUC">RUC</option>
                  </Select>
                </Field>
                <Field label="Número de documento" htmlFor="cb-doc" error={errors.documentNumber?.message}>
                  <Input id="cb-doc" inputMode="text" autoComplete="off" {...form.register("documentNumber")} />
                </Field>
                <Field label="Correo electrónico" htmlFor="cb-email" error={errors.email?.message} hint="Aquí te enviaremos la respuesta.">
                  <Input id="cb-email" type="email" autoComplete="email" {...form.register("email")} />
                </Field>
                <Field label="Teléfono" htmlFor="cb-phone" error={errors.phone?.message}>
                  <Input id="cb-phone" type="tel" autoComplete="tel" {...form.register("phone")} />
                </Field>
                <Field label="Domicilio" htmlFor="cb-address" error={errors.address?.message} className="sm:col-span-2">
                  <Input id="cb-address" autoComplete="street-address" {...form.register("address")} />
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register("isMinor")} />
                  Soy menor de edad
                </label>
                {isMinor ? (
                  <Field label="Nombre del padre, madre o apoderado" htmlFor="cb-guardian" error={errors.guardianName?.message} className="sm:col-span-2">
                    <Input id="cb-guardian" {...form.register("guardianName")} />
                  </Field>
                ) : null}
              </FormSection>

              <FormSection number={2} title="Identificación del bien contratado">
                <Field label="Tipo" htmlFor="cb-good-type" error={errors.goodType?.message}>
                  <Select id="cb-good-type" {...form.register("goodType")}>
                    <option value="SERVICIO">Servicio</option>
                    <option value="PRODUCTO">Producto</option>
                  </Select>
                </Field>
                <Field label="Monto reclamado (S/, opcional)" htmlFor="cb-amount" error={errors.claimedAmount?.message}>
                  <Input id="cb-amount" inputMode="decimal" placeholder="0.00" {...form.register("claimedAmount")} />
                </Field>
                <Field
                  label="Descripción"
                  htmlFor="cb-good"
                  error={errors.goodDescription?.message}
                  hint="Por ejemplo: el plan contratado y su periodicidad."
                  className="sm:col-span-2"
                >
                  <Input id="cb-good" {...form.register("goodDescription")} />
                </Field>
              </FormSection>

              <FormSection number={3} title="Detalle de la reclamación y pedido del consumidor">
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm font-medium">Tipo</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" value="RECLAMO" className="mt-1 accent-[var(--primary)]" {...form.register("kind")} />
                    <span>
                      <strong className="font-semibold">Reclamo</strong>: disconformidad relacionada con los productos o servicios.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="radio" value="QUEJA" className="mt-1 accent-[var(--primary)]" {...form.register("kind")} />
                    <span>
                      <strong className="font-semibold">Queja</strong>: disconformidad no relacionada con los productos o servicios, o malestar o
                      descontento respecto a la atención al público.
                    </span>
                  </label>
                  {errors.kind?.message ? <p role="alert" className="text-xs text-destructive">{errors.kind.message}</p> : null}
                </fieldset>
                <Field label="Detalle" htmlFor="cb-detail" error={errors.detail?.message} className="sm:col-span-2">
                  <Textarea id="cb-detail" rows={6} {...form.register("detail")} />
                </Field>
                <Field label="Pedido" htmlFor="cb-request" error={errors.consumerRequest?.message} hint="Qué solución esperas." className="sm:col-span-2">
                  <Textarea id="cb-request" rows={4} {...form.register("consumerRequest")} />
                </Field>
              </FormSection>

              {/* Honeypot: invisible to people and to assistive technology; bots that fill it are refused. */}
              <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
                <label htmlFor="cb-website">No completar</label>
                <input id="cb-website" tabIndex={-1} autoComplete="off" {...form.register("website")} />
              </div>

              <div className="grid gap-1.5">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" {...form.register("confirmTruth")} />
                  <span>
                    Declaro que la información es verdadera y acepto que EmailBot la use para atender esta reclamación, según la{" "}
                    <Link to="/privacy" className="font-medium text-primary hover:underline">
                      Política de privacidad
                    </Link>
                    .
                  </span>
                </label>
                {errors.confirmTruth?.message ? <p role="alert" className="text-xs text-destructive">{errors.confirmTruth.message}</p> : null}
              </div>

              {submit.error ? <ErrorMessage error={new Error(getErrorMessage(submit.error))} /> : null}

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <Button type="submit" className="h-11 rounded-xl px-6" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? "Enviando…" : "Enviar hoja de reclamación"}
                </Button>
                {LEGAL_CONTACT_EMAIL ? (
                  <p className="text-xs text-muted-foreground">
                    ¿Dudas? Escríbenos a{" "}
                    <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium text-primary hover:underline">
                      {LEGAL_CONTACT_EMAIL}
                    </a>
                  </p>
                ) : null}
              </div>
            </form>
          )}
        </div>

        <aside className="mt-8 grid gap-2 rounded-2xl border border-border/70 p-5 text-xs leading-relaxed text-muted-foreground dark:border-border">
          <p>
            La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una
            denuncia ante el INDECOPI.
          </p>
          <p>El proveedor deberá dar respuesta al reclamo o queja en un plazo no mayor a quince (15) días hábiles.</p>
        </aside>
      </div>
    </PublicLayout>
  );
}
