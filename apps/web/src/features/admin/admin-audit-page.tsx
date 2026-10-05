import type { AdminAuditEntry } from "@emailbot/types";
import { History } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { getErrorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/utils";
import { ADMIN_LOG_PAGE_SIZE, auditOrganizationLabel, platformActionLabel, platformAuditDetail } from "./admin-model";
import { useAdminAudit } from "./admin-queries";

/** Link to the organization, "Organización eliminada" when it no longer exists, or "Sin organización". */
function AuditOrganization({ entry }: { entry: AdminAuditEntry }) {
  const organization = auditOrganizationLabel(entry);
  if (!organization) return <>Sin organización</>;
  if ("deleted" in organization) return <span className="italic">Organización eliminada</span>;
  return (
    <Link to={`/admin/organizations/${organization.id}`} className="hover:underline">
      {organization.name}
    </Link>
  );
}

/** Platform administration audit trail (platform_audit_logs, immutable). */
export function AdminAuditPage() {
  const [page, setPage] = useState(1);
  const audit = useAdminAudit({ page, pageSize: ADMIN_LOG_PAGE_SIZE });

  return (
    <div>
      <PageHeader title="Auditoría de plataforma" description="Acciones de los administradores de la plataforma. Los registros no se pueden modificar ni eliminar." />

      {audit.isPending ? (
        <SkeletonRows rows={6} />
      ) : audit.error ? (
        <ErrorMessage error={new Error(getErrorMessage(audit.error))} />
      ) : audit.data.items.length === 0 ? (
        <EmptyState icon={<History />} title="Sin registros" description="Todavía no hay acciones administrativas." />
      ) : (
        <Card className="divide-y">
          {audit.data.items.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{platformActionLabel(entry.action)}</p>
                <p className="text-xs text-muted-foreground">
                  <AuditOrganization entry={entry} />
                  {platformAuditDetail(entry) ? ` · ${platformAuditDetail(entry)}` : ""}
                </p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p>{entry.actor.email ?? "usuario eliminado"}</p>
                <p>{formatDate(entry.createdAt)}</p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
          Anterior
        </Button>
        <Button variant="outline" size="sm" disabled={!audit.data?.hasMore} onClick={() => setPage((current) => current + 1)}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}
