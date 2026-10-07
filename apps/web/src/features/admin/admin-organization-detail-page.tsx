import { ArrowLeft, Building2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Pagination, SkeletonRows } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/errors";
import {
  ACCOUNT_ERROR_LABELS,
  ACCOUNT_STATUS_LABELS,
  BOT_STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  ORGANIZATION_STATUS_LABELS,
  planLabel,
  PROVIDER_LABELS,
  ROLE_LABELS
} from "@/lib/labels";
import { formatDate, formatShortDate } from "@/lib/utils";
import { ADMIN_LOG_PAGE_SIZE, ADMIN_PAGE_SIZE, activityLabel, cancelChange, formatCount, platformActionLabel, platformAuditDetail, STATUS_BADGE, statusChange, type StatusTarget } from "./admin-model";
import {
  useAdminActivity,
  useAdminAudit,
  useAdminBots,
  useAdminCustomers,
  useAdminEmailAccounts,
  useAdminMembers,
  useAdminOrganization
} from "./admin-queries";
import { OrganizationStatusDialog, type OrganizationRef } from "./organization-dialogs";
import { SubscriptionSection } from "./subscription-section";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Loading / error / empty states shared by every section. */
function QueryState<T>({ query, empty, children }: { query: { isPending: boolean; error: unknown; data: T[] | undefined }; empty: string; children(items: T[]): ReactNode }) {
  if (query.isPending) return <SkeletonRows rows={3} />;
  if (query.error) return <ErrorMessage error={new Error(getErrorMessage(query.error))} />;
  if (!query.data || query.data.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <>{children(query.data)}</>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatCount(value)}</p>
    </div>
  );
}

export function AdminOrganizationDetailPage() {
  const { organizationId = "" } = useParams();
  const organization = useAdminOrganization(organizationId);
  const members = useAdminMembers(organizationId);
  const bots = useAdminBots(organizationId);
  const accounts = useAdminEmailAccounts(organizationId);
  const [customerPage, setCustomerPage] = useState(1);
  const customers = useAdminCustomers(organizationId, customerPage, ADMIN_PAGE_SIZE);
  const [activityPage, setActivityPage] = useState(1);
  const activity = useAdminActivity({ organizationId, page: activityPage, pageSize: ADMIN_LOG_PAGE_SIZE });
  const audit = useAdminAudit({ organizationId, page: 1, pageSize: ADMIN_LOG_PAGE_SIZE });
  const [statusTarget, setStatusTarget] = useState<StatusTarget<OrganizationRef> | null>(null);

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/admin/organizations">
        <ArrowLeft /> Organizaciones
      </Link>
    </Button>
  );

  if (organization.isPending) return <SkeletonRows rows={6} />;
  if (organization.error) {
    const missing = organization.error instanceof ApiError && organization.error.status === 404;
    return (
      <div className="grid gap-4">
        <div>{back}</div>
        {missing ? (
          <EmptyState icon={<Building2 />} title="Organización no encontrada" description="No existe o fue eliminada." />
        ) : (
          <ErrorMessage error={new Error(getErrorMessage(organization.error))} />
        )}
      </div>
    );
  }

  const data = organization.data;
  const ref: OrganizationRef = { id: data.id, name: data.name, status: data.status, plan: data.plan };
  const change = statusChange(data.status, data.name);
  const cancel = cancelChange(data.status, data.name);

  return (
    <div className="grid gap-4">
      <div>{back}</div>
      <PageHeader
        title={data.name}
        description={`/${data.slug} · creada el ${formatDate(data.createdAt)}`}
        actions={
          <>
            {cancel ? (
              <Button variant="outline" className="text-destructive" onClick={() => setStatusTarget({ organization: ref, change: cancel })}>
                {cancel.action}
              </Button>
            ) : null}
            <Button variant={change.destructive ? "destructive" : "default"} onClick={() => setStatusTarget({ organization: ref, change })}>
              {change.action}
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Estado</p>
            <Badge variant={STATUS_BADGE[data.status]} className="mt-1">
              {ORGANIZATION_STATUS_LABELS[data.status]}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Plan</p>
            <p className="mt-1 font-medium">{planLabel(data.plan)}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Owner</p>
            <p className="mt-1 truncate font-medium">{data.owner?.fullName ?? data.owner?.email ?? "—"}</p>
            {data.owner?.fullName && data.owner.email ? <p className="truncate text-xs text-muted-foreground">{data.owner.email}</p> : null}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Creada</p>
            <p className="mt-1 font-medium">{formatDate(data.createdAt)}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Miembros" value={data.membersCount} />
        <Metric label="Bots" value={data.botsCount} />
        <Metric label="Clientes" value={data.customersCount} />
        <Metric label="Cuentas de correo" value={data.emailAccountsCount} />
        <Metric label="Correos procesados" value={data.processedEmailsCount} />
        <Metric label="Entregas" value={data.deliveriesCount} />
      </div>

      <SubscriptionSection organizationId={data.id} organizationName={data.name} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Miembros">
          <QueryState query={members} empty="Sin miembros.">
            {(items) => (
              <ul className="divide-y text-sm">
                {items.map((member) => (
                  <li key={member.userId} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{member.fullName ?? member.email ?? "—"}</p>
                      {member.fullName ? <p className="truncate text-xs text-muted-foreground">{member.email}</p> : null}
                    </div>
                    <Badge variant="secondary">{ROLE_LABELS[member.role]}</Badge>
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatShortDate(member.joinedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Section>

        <Section title="Bots">
          <QueryState query={bots} empty="Sin bots.">
            {(items) => (
              <ul className="divide-y text-sm">
                {items.map((bot) => (
                  <li key={bot.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <p className="min-w-0 flex-1 truncate font-medium">{bot.name}</p>
                    <Badge variant={bot.status === "ACTIVE" ? "success" : "secondary"}>{BOT_STATUS_LABELS[bot.status]}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatCount(bot.rulesCount)} reglas · {formatCount(bot.activeCustomersCount)} clientes · {formatCount(bot.deliveriesCount)} entregas
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Section>

        <Section title="Clientes" description="Solo nombre, estado y bots asignados: sin identificadores ni Access IDs.">
          <QueryState query={{ ...customers, data: customers.data?.items }} empty="Sin clientes.">
            {(items) => (
              <>
                <ul className="divide-y text-sm">
                  {items.map((customer) => (
                    <li key={customer.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <p className="min-w-0 flex-1 truncate font-medium">{customer.displayName}</p>
                      <Badge variant={customer.status === "ACTIVE" ? "success" : "secondary"}>{CUSTOMER_STATUS_LABELS[customer.status]}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {customer.bots.length > 0 ? customer.bots.join(", ") : "Sin bots"} · {formatCount(customer.deliveriesCount)} entregas
                      </span>
                    </li>
                  ))}
                </ul>
                {customers.data && customers.data.total > ADMIN_PAGE_SIZE ? (
                  <div className="mt-3">
                    <Pagination page={customerPage} pageSize={ADMIN_PAGE_SIZE} total={customers.data.total} onPageChange={setCustomerPage} />
                  </div>
                ) : null}
              </>
            )}
          </QueryState>
        </Section>

        <Section title="Cuentas de correo" description="Estado de conexión y sincronización: sin credenciales.">
          <QueryState query={accounts} empty="Sin cuentas conectadas.">
            {(items) => (
              <ul className="divide-y text-sm">
                {items.map((account) => (
                  <li key={account.id} className="grid gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 truncate font-medium">{account.emailAddress}</p>
                      <Badge variant="outline">{PROVIDER_LABELS[account.provider]}</Badge>
                      <Badge variant={account.status === "ACTIVE" ? "success" : account.status === "ERROR" ? "destructive" : "secondary"}>
                        {ACCOUNT_STATUS_LABELS[account.status]}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Última sincronización: {formatDate(account.lastSyncedAt)}
                      {account.provider === "GMAIL" ? ` · Push: ${account.watchExpiresAt ? `hasta ${formatDate(account.watchExpiresAt)}` : "inactivo (polling)"}` : ""}
                      {account.lastErrorCode ? ` · ${ACCOUNT_ERROR_LABELS[account.lastErrorCode] ?? account.lastErrorCode}` : ""}
                      {account.watchErrorCode ? ` · Push: ${account.watchErrorCode}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Section>

        <Section title="Actividad" description="Eventos registrados por la organización (sin contenido de correos).">
          <QueryState query={{ ...activity, data: activity.data?.items }} empty="Sin actividad.">
            {(items) => (
              <>
                <ul className="divide-y text-sm">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate">{activityLabel(item)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatShortDate(item.createdAt)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={activityPage <= 1} onClick={() => setActivityPage((page) => page - 1)}>
                    Anterior
                  </Button>
                  <Button variant="outline" size="sm" disabled={!activity.data?.hasMore} onClick={() => setActivityPage((page) => page + 1)}>
                    Siguiente
                  </Button>
                </div>
              </>
            )}
          </QueryState>
        </Section>

        <Section title="Auditoría de plataforma" description="Acciones de administradores de la plataforma sobre esta organización.">
          <QueryState query={{ ...audit, data: audit.data?.items }} empty="Sin acciones administrativas.">
            {(items) => (
              <ul className="divide-y text-sm">
                {items.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{platformActionLabel(entry.action)}</span>
                      {platformAuditDetail(entry) ? <span className="text-muted-foreground"> · {platformAuditDetail(entry)}</span> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.actor.email ?? "usuario eliminado"} · {formatShortDate(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Section>
      </div>

      <OrganizationStatusDialog target={statusTarget} onOpenChange={(open) => (open ? undefined : setStatusTarget(null))} />
    </div>
  );
}
