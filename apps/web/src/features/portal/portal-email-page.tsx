import type { PortalAttachmentSummary } from "@emailbot/types";
import { ArrowLeft, Download, FileText, Star } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/display";
import { Skeleton } from "@/components/ui/feedback";
import { EmailBody } from "@/features/inbox/email-body";
import { formatDate } from "@/lib/utils";
import { portalErrorMessage } from "./portal-api";
import { usePortalApi } from "./portal-context";
import { usePortalEmail } from "./portal-queries";

/*
 * Email detail by DELIVERY id (never an email id). What is shown is exactly
 * what the API returns for the bot's portal settings: no body / attachments /
 * fields when they are null or absent, and nothing is fetched from elsewhere.
 * The body HTML is untrusted: it is rendered by EmailBody in a sandboxed
 * iframe (no scripts, no same-origin, remote images blocked by default).
 */

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Attachments({ deliveryId, attachments }: { deliveryId: string; attachments: PortalAttachmentSummary[] }) {
  const api = usePortalApi();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (attachment: PortalAttachmentSummary) => {
    setError(null);
    setPending(attachment.id);
    try {
      // Short-lived signed URL from the API (bucket stays private). It is a forced download
      // (Content-Disposition), so the portal page stays open; never a popup after an await.
      const { url } = await api.attachmentUrl(deliveryId, attachment.id);
      const link = document.createElement("a");
      link.href = url;
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (downloadError) {
      setError(portalErrorMessage(downloadError, "download"));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="space-y-2" aria-label="Archivos adjuntos">
      <h2 className="text-sm font-semibold">Archivos adjuntos</h2>
      {attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Este correo no tiene archivos adjuntos disponibles.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-3 rounded-md border bg-background p-3">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{attachment.filename}</p>
                <p className="text-xs text-muted-foreground">{attachment.available ? formatSize(attachment.size) : "Aún no disponible"}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!attachment.available || pending === attachment.id}
                onClick={() => void download(attachment)}
                aria-label={`Descargar ${attachment.filename}`}
              >
                <Download /> <span className="hidden sm:inline">Descargar</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4 rounded-lg border bg-background p-6" aria-busy="true" aria-label="Cargando correo">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function PortalEmailPage() {
  const { deliveryId = "" } = useParams();
  const email = usePortalEmail(deliveryId);

  return (
    <div className="space-y-4">
      <Link to="/portal" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Volver a la bandeja
      </Link>

      {email.isPending ? (
        <DetailSkeleton />
      ) : email.isError ? (
        <div className="rounded-lg border bg-background p-10 text-center">
          <p role="alert" className="text-sm">
            {portalErrorMessage(email.error, "email")}
          </p>
        </div>
      ) : (
        <article className="space-y-6 rounded-lg border bg-background p-4 sm:p-6">
          <header className="space-y-3">
            <div className="flex items-start gap-2">
              {email.data.important ? <Star className="mt-1 size-4 shrink-0 fill-amber-400 text-amber-500" aria-label="Importante" /> : null}
              <h1 className="break-words text-lg font-semibold sm:text-xl">{email.data.subject || "(sin asunto)"}</h1>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">{email.data.sender.name ?? email.data.sender.email}</span>
              {email.data.sender.name ? <span className="text-muted-foreground">&lt;{email.data.sender.email}&gt;</span> : null}
              <time className="text-muted-foreground sm:ml-auto" dateTime={email.data.receivedAt}>
                {formatDate(email.data.receivedAt)}
              </time>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{email.data.bot.name}</Badge>
              {email.data.category ? <Badge variant="secondary">{email.data.category.name}</Badge> : null}
              <Badge variant="secondary">{email.data.read ? "Leído" : "No leído"}</Badge>
            </div>
          </header>

          {email.data.fields.length > 0 ? (
            <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-2">
              {email.data.fields.map((field) => (
                <div key={field.key}>
                  <dt className="text-xs text-muted-foreground">{field.label}</dt>
                  <dd className="break-words font-mono text-base font-semibold">{field.value ?? <span className="font-sans text-sm font-normal text-muted-foreground">No disponible</span>}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {email.data.body ? <EmailBody html={email.data.body.html} text={email.data.body.text} /> : null}

          {email.data.attachments ? <Attachments deliveryId={deliveryId} attachments={email.data.attachments} /> : null}
        </article>
      )}
    </div>
  );
}
