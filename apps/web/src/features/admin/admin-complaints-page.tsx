import {
  COMPLAINT_EMAIL_IDEMPOTENCY_WINDOW_HOURS,
  COMPLAINT_RESPONSE_MAX_LENGTH,
  type ComplaintBookEntry,
  type ComplaintEmailStatus,
  type ComplaintStatus
} from "@emailbot/types";
import { complaintEmailConfirmationSchema, complaintResponseSchema } from "@emailbot/validation";
import { BookOpenText, MailCheck, Send } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Input, Textarea } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/utils";
import { useAdminComplaints, useConfirmComplaintEmail, useResendComplaintCopy, useRespondToComplaint } from "./admin-queries";

/*
 * Libro de Reclamaciones (platform administrators only: RequirePlatformAdmin + the API + the database).
 * Administrators read the sheets, answer them by e-mail (the case becomes Respondido only when the e-mail
 * provider accepted the answer) and send the consumer's copy again when it was not delivered. Every value
 * typed by the consumer is rendered as text.
 *
 * An e-mail whose outcome is unknown past the provider's idempotency window is never resent automatically:
 * the administrator records it as sent (with the Resend id) or resends it on purpose, knowing it may arrive
 * twice. Both decisions are audited by the database.
 */

const PAGE_SIZE = 25;

const STATUS_LABELS: Record<ComplaintStatus, string> = {
  PENDING: "Pendiente",
  RESPONDED: "Respondido"
};

const COPY_LABELS: Record<ComplaintEmailStatus, string> = {
  PENDING: "Constancia pendiente de envío",
  SENDING: "Constancia enviándose",
  SENT: "Constancia enviada",
  FAILED: "Constancia no enviada"
};

/** SENDING with an error code: the provider did not confirm the last attempt (it may have been sent). */
const uncertain = (status: ComplaintEmailStatus | null, errorCode: string | null) => status === "SENDING" && errorCode !== null;

const copyLabel = (copy: ComplaintBookEntry["confirmationEmail"]) =>
  uncertain(copy.status, copy.errorCode) ? "Constancia con resultado incierto" : COPY_LABELS[copy.status];

const amount = (cents: number | null) => (cents === null ? "No indicado" : `S/ ${(cents / 100).toFixed(2)}`);

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm whitespace-pre-wrap break-words">{children}</dd>
    </div>
  );
}

function ResendCopy({ entry, force = false }: { entry: ComplaintBookEntry; force?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const resend = useResendComplaintCopy();
  const label = force ? "Reenviar constancia de todos modos" : "Reenviar constancia";
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <MailCheck aria-hidden />
        {label}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`¿Reenviar la constancia de ${entry.code}?`}
        description={
          force
            ? `No se pudo confirmar si la constancia anterior llegó a Resend. Si se envió, ${entry.consumer.email} recibirá la copia dos veces.`
            : `Se enviará la copia de la hoja de reclamación a ${entry.consumer.email}.`
        }
        confirmLabel={label}
        destructive={force}
        onConfirm={async () => {
          await resend.mutateAsync({ id: entry.id, forceResend: force });
          toast.success("Constancia enviada");
        }}
      />
    </>
  );
}

/** Records an e-mail with an unknown outcome as sent, with the Resend id the administrator found (audited). */
function ConfirmSent({ entry, kind }: { entry: ComplaintBookEntry; kind: "response" | "copy" }) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [providerMessageId, setProviderMessageId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirmComplaintEmail();
  const what = kind === "response" ? "la respuesta" : "la constancia";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = complaintEmailConfirmationSchema.safeParse({ providerMessageId });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisa el ID");
      return;
    }
    setError(null);
    try {
      await confirm.mutateAsync({ id: entry.id, kind, providerMessageId: parsed.data.providerMessageId });
      toast.success(kind === "response" ? "Respuesta registrada como enviada" : "Constancia registrada como enviada");
      setOpen(false);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!confirm.isPending) {
          setError(null);
          setOpen(next);
        }
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MailCheck aria-hidden />
        {kind === "response" ? "Registrar respuesta como enviada" : "Registrar constancia como enviada"}
      </Button>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{`¿Registrar ${what} de ${entry.code} como enviada?`}</DialogTitle>
            <DialogDescription>
              Hazlo solo si encontraste el correo en el panel de Resend (destinatario {entry.consumer.email}, asunto con {entry.code}) o en
              los registros de la API. Indica su ID: no se enviará ningún correo.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              ID del correo en Resend
            </label>
            <Input
              id={fieldId}
              value={providerMessageId}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              onChange={(event) => setProviderMessageId(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={confirm.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={confirm.isPending}>
              {confirm.isPending ? "Procesando…" : "Registrar como enviada"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResponseForm({ entry, onDone, force = false }: { entry: ComplaintBookEntry; onDone(): void; force?: boolean }) {
  const fieldId = useId();
  // After a rejected or uncertain e-mail the last text is offered again (an uncertain one can only be resent as is).
  const [text, setText] = useState(entry.response.emailStatus === "FAILED" || entry.response.emailStatus === "SENDING" ? (entry.response.text ?? "") : "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const respond = useRespondToComplaint();

  function review() {
    const parsed = complaintResponseSchema.safeParse({ response: text });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisa la respuesta");
      return;
    }
    setError(null);
    setConfirming(true);
  }

  return (
    <div className="grid gap-2 rounded-xl border bg-muted/30 p-4">
      <label htmlFor={fieldId} className="text-sm font-medium">
        Respuesta al consumidor
      </label>
      <Textarea
        id={fieldId}
        rows={6}
        value={text}
        maxLength={COMPLAINT_RESPONSE_MAX_LENGTH}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${fieldId}-help`}
        onChange={(event) => setText(event.target.value)}
      />
      <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">
        Texto plano. Se enviará por correo a {entry.consumer.email} con el número {entry.code}. {text.trim().length}/{COMPLAINT_RESPONSE_MAX_LENGTH}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancelar
        </Button>
        <Button size="sm" onClick={review}>
          <Send aria-hidden />
          Revisar y enviar
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`¿Enviar la respuesta a ${entry.code}?`}
        description={
          force
            ? `No se pudo confirmar si la respuesta anterior llegó a Resend. Si se envió, ${entry.consumer.email} recibirá dos respuestas. El caso quedará como Respondido solo si el proveedor de correo acepta este envío.`
            : `Se enviará por correo a ${entry.consumer.email}. El caso quedará como Respondido solo si el proveedor de correo acepta el envío.`
        }
        confirmLabel={force ? "Reenviar de todos modos" : "Enviar respuesta"}
        destructive={force}
        onConfirm={async () => {
          await respond.mutateAsync({ id: entry.id, response: text, forceResend: force });
          toast.success("Respuesta enviada");
          onDone();
        }}
      />
    </div>
  );
}

function ResponseSection({ entry }: { entry: ComplaintBookEntry }) {
  const [answering, setAnswering] = useState(false);
  const { response } = entry;

  if (entry.status !== "RESPONDED" && response.decisionRequired) {
    return (
      <section aria-label="Respuesta" className="grid gap-3">
        <div role="status" className="grid gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <p>
            No se pudo confirmar si la última respuesta se envió{response.errorCode ? ` (${response.errorCode})` : ""} y ya pasaron más de{" "}
            {COMPLAINT_EMAIL_IDEMPOTENCY_WINDOW_HOURS} horas, el plazo en que el proveedor evita duplicados. EmailBot no la reenviará
            automáticamente.
          </p>
          <p>
            Busca en el panel de Resend un correo a {entry.consumer.email} con el asunto que incluye {entry.code}. Si existe, regístrala como
            enviada con su ID; si no existe, puedes reenviarla de todos modos.
          </p>
        </div>
        {answering ? (
          <ResponseForm entry={entry} force onDone={() => setAnswering(false)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <ConfirmSent entry={entry} kind="response" />
            <Button variant="outline" size="sm" onClick={() => setAnswering(true)}>
              <Send aria-hidden />
              Reenviar de todos modos
            </Button>
          </div>
        )}
      </section>
    );
  }

  if (entry.status === "RESPONDED") {
    return (
      <section aria-label="Respuesta" className="grid gap-2 rounded-xl border border-emerald-500/30 p-4">
        <Detail label={`Respuesta enviada${response.respondedAt ? ` el ${formatDate(response.respondedAt)}` : ""}${response.respondedByEmail ? ` por ${response.respondedByEmail}` : ""}`}>
          {response.text}
        </Detail>
      </section>
    );
  }

  return (
    <section aria-label="Respuesta" className="grid gap-3">
      {response.emailStatus === "FAILED" ? (
        <p role="status" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          El último intento de respuesta no se envió{response.errorCode ? ` (${response.errorCode})` : ""}. El caso sigue pendiente.
        </p>
      ) : null}
      {response.emailStatus === "SENDING" && response.errorCode ? (
        <p role="status" className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          El proveedor de correo no confirmó el último envío ({response.errorCode}): pudo haberse enviado. El caso sigue pendiente. En dos
          minutos vuelve a enviar exactamente el mismo texto; no se enviará dos veces.
        </p>
      ) : null}
      {response.emailStatus === "SENDING" && !response.errorCode ? (
        <p role="status" className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          Se está enviando una respuesta. Actualiza la lista en unos minutos.
        </p>
      ) : null}
      {answering ? (
        <ResponseForm entry={entry} onDone={() => setAnswering(false)} />
      ) : (
        <div>
          <Button size="sm" onClick={() => setAnswering(true)}>
            <Send aria-hidden />
            Responder
          </Button>
        </div>
      )}
    </section>
  );
}

function ComplaintRow({ entry }: { entry: ComplaintBookEntry }) {
  const copy = entry.confirmationEmail;
  return (
    <details className="group px-4 py-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-sm focus-visible:outline-2 focus-visible:outline-ring">
        <span className="font-mono font-semibold">{entry.code}</span>
        <Badge variant={entry.kind === "RECLAMO" ? "warning" : "secondary"}>{entry.kind === "RECLAMO" ? "Reclamo" : "Queja"}</Badge>
        <span className="min-w-0 flex-1 truncate">
          {entry.consumer.firstNames} {entry.consumer.lastNames}
        </span>
        <Badge variant={entry.status === "RESPONDED" ? "success" : "outline"}>{STATUS_LABELS[entry.status]}</Badge>
        {copy.status !== "SENT" ? <Badge variant={copy.status === "FAILED" ? "destructive" : "secondary"}>{copyLabel(copy)}</Badge> : null}
        <span className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span>
      </summary>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <Detail label="Documento">
          {entry.consumer.documentType} {entry.consumer.documentNumber}
        </Detail>
        <Detail label="Correo">{entry.consumer.email}</Detail>
        <Detail label="Teléfono">{entry.consumer.phone}</Detail>
        <Detail label="Domicilio">{entry.consumer.address}</Detail>
        {entry.consumer.isMinor ? <Detail label="Padre, madre o apoderado (menor de edad)">{entry.consumer.guardianName}</Detail> : null}
        <Detail label="Bien contratado">
          {entry.good.type === "SERVICIO" ? "Servicio" : "Producto"}: {entry.good.description}
        </Detail>
        <Detail label="Monto reclamado">{amount(entry.good.claimedAmountCents)}</Detail>
        <div className="sm:col-span-2">
          <Detail label="Detalle">{entry.detail}</Detail>
        </div>
        <div className="sm:col-span-2">
          <Detail label="Pedido del consumidor">{entry.consumerRequest}</Detail>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Detail label="Constancia al consumidor">
            {copyLabel(copy)}
            {copy.status === "SENT" && copy.sentAt ? ` el ${formatDate(copy.sentAt)}` : ""}
            {copy.status !== "SENT" && copy.errorCode ? ` (${copy.errorCode})` : ""}
          </Detail>
          {copy.decisionRequired ? (
            <>
              <ConfirmSent entry={entry} kind="copy" />
              <ResendCopy entry={entry} force />
            </>
          ) : copy.status === "PENDING" || copy.status === "FAILED" || uncertain(copy.status, copy.errorCode) ? (
            <ResendCopy entry={entry} />
          ) : null}
        </div>
        {copy.decisionRequired ? (
          <p role="status" className="text-xs text-amber-900 sm:col-span-2 dark:text-amber-200">
            No se pudo confirmar si la constancia se envió y ya pasaron más de {COMPLAINT_EMAIL_IDEMPOTENCY_WINDOW_HOURS} horas: EmailBot no
            la reenviará automáticamente. Revisa el panel de Resend antes de decidir.
          </p>
        ) : null}
      </dl>
      <div className="mt-4">
        <ResponseSection entry={entry} />
      </div>
    </details>
  );
}

export function AdminComplaintsPage() {
  const [page, setPage] = useState(1);
  const complaints = useAdminComplaints(page, PAGE_SIZE);

  return (
    <div>
      <PageHeader
        title="Libro de reclamaciones"
        description="Hojas registradas desde emailbot.app/libro-de-reclamaciones. Deben responderse en un plazo no mayor a 15 días hábiles."
      />

      {complaints.isPending ? (
        <SkeletonRows rows={6} />
      ) : complaints.error ? (
        <ErrorMessage error={new Error(getErrorMessage(complaints.error))} />
      ) : complaints.data.items.length === 0 ? (
        <EmptyState icon={<BookOpenText />} title="Sin hojas de reclamación" description="Todavía no se ha registrado ninguna queja ni reclamo." />
      ) : (
        <Card className="divide-y">
          {complaints.data.items.map((entry) => (
            <ComplaintRow key={entry.id} entry={entry} />
          ))}
        </Card>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
          Anterior
        </Button>
        <Button variant="outline" size="sm" disabled={!complaints.data?.hasMore} onClick={() => setPage((current) => current + 1)}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}
