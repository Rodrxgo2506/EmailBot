import { AUDIT_ACTIONS, type AuditAction, type AuditLogEntry, type OrganizationMember } from "@emailbot/types";
import { History } from "lucide-react";
import { useState } from "react";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Pagination, SkeletonRows } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { AUDIT_ACTION_LABELS, ENTITY_LABELS } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { useAuditLogs, useMembers } from "./api";

const PAGE_SIZE = 25;

function actorLabel(entry: AuditLogEntry, members: Map<string, OrganizationMember>): string {
  if (entry.actorType === "SYSTEM") return "Sistema";
  if (!entry.actorUserId) return "Usuario eliminado";
  const member = members.get(entry.actorUserId);
  return member?.profile?.fullName ?? member?.profile?.email ?? `Ex miembro (${entry.actorUserId.slice(0, 8)})`;
}

function Metadata({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <dl className="grid gap-0.5 text-xs">
      {entries.slice(0, 6).map(([key, inner]) => (
        <div key={key} className="flex gap-1">
          <dt className="text-muted-foreground">{key}:</dt>
          <dd className="break-all font-mono">{typeof inner === "string" ? inner : JSON.stringify(inner)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Read-only, immutable audit trail (OWNER/ADMIN; enforced by the API and RLS). */
export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AuditAction | "">("");
  const [entityType, setEntityType] = useState("");
  const logs = useAuditLogs({ page, pageSize: PAGE_SIZE, action: action || undefined, entityType: entityType || undefined });
  const members = useMembers();
  const memberByUser = new Map((members.data ?? []).map((member) => [member.userId, member]));

  return (
    <div>
      <PageHeader title="Auditoría" description="Historial inmutable de acciones relevantes en la organización." />

      <div className="mb-4 flex flex-wrap gap-2">
        <label htmlFor="audit-action" className="sr-only">
          Acción
        </label>
        <Select
          id="audit-action"
          className="w-auto"
          value={action}
          onChange={(event) => {
            setAction(event.target.value as AuditAction | "");
            setPage(1);
          }}
        >
          <option value="">Todas las acciones</option>
          {AUDIT_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {AUDIT_ACTION_LABELS[value]}
            </option>
          ))}
        </Select>
        <label htmlFor="audit-entity" className="sr-only">
          Recurso
        </label>
        <Select
          id="audit-entity"
          className="w-auto"
          value={entityType}
          onChange={(event) => {
            setEntityType(event.target.value);
            setPage(1);
          }}
        >
          <option value="">Todos los recursos</option>
          {Object.entries(ENTITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {logs.isPending ? (
        <SkeletonRows rows={8} />
      ) : logs.error ? (
        <ErrorMessage error={new Error(getErrorMessage(logs.error))} />
      ) : logs.data.items.length === 0 ? (
        <EmptyState icon={<History />} title="Sin eventos" description="No hay eventos para estos filtros." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Acción</th>
                  <th className="px-4 py-2 font-medium">Recurso</th>
                  <th className="px-4 py-2 font-medium">Detalles</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.data.items.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(entry.createdAt)}</td>
                    <td className="px-4 py-3">{actorLabel(entry, memberByUser)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{AUDIT_ACTION_LABELS[entry.action]}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <p>{entry.entityType ? (ENTITY_LABELS[entry.entityType] ?? entry.entityType) : "—"}</p>
                      {entry.entityId ? <p className="font-mono text-xs text-muted-foreground">{entry.entityId.slice(0, 8)}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <Metadata value={entry.metadata} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t px-4 py-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={logs.data.total} onPageChange={setPage} />
          </div>
        </Card>
      )}
    </div>
  );
}
