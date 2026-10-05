import {
  ADMIN_ORGANIZATION_SORTS,
  ORGANIZATION_PLANS,
  ORGANIZATION_STATUSES,
  type AdminOrganizationSort,
  type OrganizationPlan,
  type OrganizationStatus
} from "@emailbot/types";
import { Building2, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Pagination, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { ORGANIZATION_STATUS_LABELS } from "@/lib/labels";
import { formatShortDate } from "@/lib/utils";
import type { AdminOrganizationListParams } from "./admin-api";
import { DEFAULT_ORGANIZATION_PARAMS, formatCount, PLAN_LABELS, SORT_LABELS, STATUS_BADGE, statusChange, type StatusTarget } from "./admin-model";
import { useAdminOrganizations } from "./admin-queries";
import { CreateOrganizationDialog, OrganizationPlanDialog, OrganizationStatusDialog, type OrganizationRef } from "./organization-dialogs";

export function AdminOrganizationsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useState<AdminOrganizationListParams>(DEFAULT_ORGANIZATION_PARAMS);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<StatusTarget<OrganizationRef> | null>(null);
  const [planTarget, setPlanTarget] = useState<OrganizationRef | null>(null);
  const organizations = useAdminOrganizations(params);

  // Debounced search (name, slug or owner e-mail).
  useEffect(() => {
    if (search === params.search) return;
    const timer = setTimeout(() => setParams((current) => ({ ...current, search, page: 1 })), 350);
    return () => clearTimeout(timer);
  }, [search, params.search]);

  const filtered = Boolean(params.search || params.status || params.plan);

  return (
    <div>
      <PageHeader
        title="Organizaciones"
        description="Empresas de la plataforma, su plan, su estado y su actividad."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Nueva organización
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Buscar organizaciones"
            placeholder="Buscar por nombre, slug o correo del propietario"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          aria-label="Estado"
          className="w-auto"
          value={params.status}
          onChange={(event) => setParams((current) => ({ ...current, status: event.target.value as OrganizationStatus | "", page: 1 }))}
        >
          <option value="">Todos los estados</option>
          {ORGANIZATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ORGANIZATION_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Plan"
          className="w-auto"
          value={params.plan}
          onChange={(event) => setParams((current) => ({ ...current, plan: event.target.value as OrganizationPlan | "", page: 1 }))}
        >
          <option value="">Todos los planes</option>
          {ORGANIZATION_PLANS.map((plan) => (
            <option key={plan} value={plan}>
              {PLAN_LABELS[plan]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Orden"
          className="w-auto"
          value={params.sort}
          onChange={(event) => setParams((current) => ({ ...current, sort: event.target.value as AdminOrganizationSort, page: 1 }))}
        >
          {ADMIN_ORGANIZATION_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>
      </div>

      {organizations.isPending ? (
        <SkeletonRows rows={6} />
      ) : organizations.error ? (
        <ErrorMessage error={new Error(getErrorMessage(organizations.error))} />
      ) : organizations.data.items.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title={filtered ? "Sin resultados" : "Sin organizaciones"}
          description={filtered ? "Ninguna organización coincide con los filtros." : "Crea la primera organización de la plataforma."}
          action={!filtered ? <Button onClick={() => setCreateOpen(true)}>Crear organización</Button> : undefined}
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Empresa</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 text-right font-medium">Miembros</th>
                <th className="px-3 py-2 text-right font-medium">Bots</th>
                <th className="px-3 py-2 text-right font-medium">Clientes</th>
                <th className="px-3 py-2 text-right font-medium">Cuentas</th>
                <th className="px-3 py-2 text-right font-medium">Correos</th>
                <th className="px-3 py-2 font-medium">Creada</th>
                <th className="px-4 py-2 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {organizations.data.items.map((organization) => {
                const change = statusChange(organization.status, organization.name);
                const ref: OrganizationRef = { id: organization.id, name: organization.name, status: organization.status, plan: organization.plan };
                return (
                  <tr key={organization.id} className="hover:bg-accent/40">
                    <td className="px-4 py-2.5">
                      <Link to={`/admin/organizations/${organization.id}`} className="font-medium hover:underline">
                        {organization.name}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">{organization.slug}</p>
                    </td>
                    <td className="px-3 py-2.5">{PLAN_LABELS[organization.plan]}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_BADGE[organization.status]}>{ORGANIZATION_STATUS_LABELS[organization.status]}</Badge>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5" title={organization.owner?.email ?? undefined}>
                      {organization.owner?.email ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(organization.membersCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(organization.botsCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(organization.customersCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(organization.emailAccountsCount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(organization.processedEmailsCount)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{formatShortDate(organization.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/admin/organizations/${organization.id}`} aria-label={`Ver ${organization.name}`}>
                            Ver
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" aria-label={`Editar plan de ${organization.name}`} onClick={() => setPlanTarget(ref)}>
                          Editar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={change.destructive ? "text-destructive" : undefined}
                          aria-label={`${change.action} ${organization.name}`}
                          onClick={() => setStatusTarget({ organization: ref, change })}
                        >
                          {change.action}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {organizations.data && organizations.data.total > params.pageSize ? (
        <div className="mt-3">
          <Pagination
            page={params.page}
            pageSize={params.pageSize}
            total={organizations.data.total}
            onPageChange={(page) => setParams((current) => ({ ...current, page }))}
          />
        </div>
      ) : null}

      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(organization) => navigate(`/admin/organizations/${organization.id}`)} />
      <OrganizationStatusDialog target={statusTarget} onOpenChange={(open) => (open ? undefined : setStatusTarget(null))} />
      <OrganizationPlanDialog organization={planTarget} onOpenChange={(open) => (open ? undefined : setPlanTarget(null))} />
    </div>
  );
}
