import type { Category, EmailAttachment } from "@emailbot/types";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Download,
  KeyRound,
  Mail,
  MailOpen,
  Paperclip,
  Star,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge, EmptyState, ErrorMessage } from "@/components/ui/display";
import { ConfirmDialog, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { getAttachmentDownloadUrl, useDeleteEmail, useEmail, useUpdateEmail, type EmailPatch } from "./api";
import { EmailBody } from "./email-body";
import { extractedEntries, primaryCode } from "./extracted";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentRow({ attachment }: { attachment: EmailAttachment }) {
  const [pending, setPending] = useState(false);

  async function download() {
    setPending(true);
    try {
      const url = await getAttachmentDownloadUrl(attachment.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatSize(attachment.fileSize)}</span>
      {attachment.storageUploaded ? (
        <Button variant="ghost" size="sm" onClick={() => void download()} disabled={pending}>
          <Download /> Descargar
        </Button>
      ) : (
        <Badge variant="secondary" title="El contenido no se almacenó (tamaño, adjunto en línea o configuración)">
          Solo metadatos
        </Badge>
      )}
    </li>
  );
}

export function EmailDetailPanel({
  emailId,
  categories,
  backTo
}: {
  emailId: string;
  categories: Category[];
  backTo: string;
}) {
  const navigate = useNavigate();
  const { can } = useOrganization();
  const canUpdate = can("emails:update");
  const { data: email, isPending, error } = useEmail(emailId);
  const update = useUpdateEmail();
  const remove = useDeleteEmail();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const markedRead = useRef<string | null>(null);

  // Opening an unread email marks it as read (only for roles that can update).
  useEffect(() => {
    if (email && !email.isRead && canUpdate && markedRead.current !== email.id) {
      markedRead.current = email.id;
      update.mutate({ id: email.id, patch: { isRead: true } });
    }
  }, [email, canUpdate, update]);

  function patch(change: EmailPatch, message: string) {
    update.mutate(
      { id: emailId, patch: change },
      { onSuccess: () => toast.success(message), onError: (mutationError) => toast.error(getErrorMessage(mutationError)) }
    );
  }

  if (isPending) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !email) {
    return (
      <div className="p-6">
        <ErrorMessage error={new Error(getErrorMessage(error ?? new Error("Correo no encontrado")))} />
      </div>
    );
  }

  const code = primaryCode(email.extractedData);
  const extracted = extractedEntries(email.extractedData);

  return (
    <article className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
        <Button asChild variant="ghost" size="icon" className="xl:hidden" aria-label="Volver a la bandeja">
          <Link to={backTo}>
            <ArrowLeft />
          </Link>
        </Button>
        {canUpdate ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch({ isImportant: !email.isImportant }, email.isImportant ? "Quitado de importantes" : "Marcado como importante")}
            >
              <Star className={email.isImportant ? "fill-amber-400 text-amber-400" : undefined} />
              <span className="hidden sm:inline">{email.isImportant ? "Importante" : "Marcar importante"}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => patch({ isRead: !email.isRead }, email.isRead ? "Marcado como no leído" : "Marcado como leído")}>
              {email.isRead ? <Mail /> : <MailOpen />}
              <span className="hidden sm:inline">{email.isRead ? "No leído" : "Leído"}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => patch({ isArchived: !email.isArchived }, email.isArchived ? "Movido a la bandeja" : "Archivado")}>
              {email.isArchived ? <ArchiveRestore /> : <Archive />}
              <span className="hidden sm:inline">{email.isArchived ? "Desarchivar" : "Archivar"}</span>
            </Button>
            <label htmlFor="email-category" className="sr-only">
              Categoría
            </label>
            <Select
              id="email-category"
              className="ml-auto h-8 w-auto max-w-48 text-xs"
              value={email.categoryId ?? ""}
              onChange={(event) => patch({ categoryId: event.target.value || null }, "Categoría actualizada")}
            >
              <option value="">Sin categoría</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        {can("emails:delete") ? (
          <Button variant="ghost" size="icon" aria-label="Eliminar correo" onClick={() => setConfirmDelete(true)}>
            <Trash2 />
          </Button>
        ) : null}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
        <header className="space-y-2">
          <h2 className="text-lg font-semibold leading-snug">{email.subject || "(sin asunto)"}</h2>
          <div className="grid gap-1 text-sm">
            <p>
              <span className="font-medium">{email.senderName ?? email.senderEmail}</span>{" "}
              {email.senderName ? <span className="text-muted-foreground">&lt;{email.senderEmail}&gt;</span> : null}
            </p>
            <p className="text-muted-foreground">
              Para: {email.toEmails.join(", ") || "—"}
              {email.ccEmails.length > 0 ? ` · CC: ${email.ccEmails.join(", ")}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Recibido {formatDate(email.receivedAt)}
              {email.processedAt ? ` · Procesado ${formatDate(email.processedAt)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {email.isImportant ? <Badge variant="warning">Importante</Badge> : null}
            {email.isArchived ? <Badge variant="secondary">Archivado</Badge> : null}
            {email.matchedRuleId ? (
              <Link to={`/rules/${email.matchedRuleId}`}>
                <Badge variant="outline">Regla aplicada</Badge>
              </Link>
            ) : null}
          </div>
        </header>

        {code ? (
          <section
            aria-label="Código extraído"
            className="flex flex-wrap items-center gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4"
          >
            <KeyRound className="size-6 text-emerald-600 dark:text-emerald-300" />
            <div className="flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Código detectado
              </p>
              <p className="font-mono text-3xl font-semibold tracking-[0.2em]">{code}</p>
            </div>
            <CopyButton value={code} label="Copiar código" />
          </section>
        ) : null}

        {extracted.length > (code ? 1 : 0) ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Datos extraídos por reglas</h3>
            <dl className="grid gap-2 sm:grid-cols-2">
              {extracted.map(([key, value]) => (
                <div key={key} className="rounded-md border px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{key}</dt>
                  <dd className="break-all font-mono text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {email.attachments.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Adjuntos ({email.attachments.length})</h3>
            <ul className="grid gap-2">
              {email.attachments.map((attachment) => (
                <AttachmentRow key={attachment.id} attachment={attachment} />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Contenido</h3>
          <EmailBody html={email.htmlBody} text={email.textBody} />
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Eliminar correo"
        description="El correo procesado y sus adjuntos se eliminarán de EmailBot. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        onConfirm={async () => {
          await remove.mutateAsync(email.id);
          toast.success("Correo eliminado");
          navigate(backTo);
        }}
      />
    </article>
  );
}

export function NoEmailSelected() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState icon={<Mail />} title="Selecciona un correo" description="El detalle aparecerá aquí." />
    </div>
  );
}
