import { Activity, Bot, Building2, Contact, History, Mail, Mailbox, Plus, ShieldAlert, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { SkeletonRows } from "@/components/ui/feedback";
import { getErrorMessage } from "@/lib/errors";
import { formatShortDate } from "@/lib/utils";
import { ADMIN_RECENT_ACTIVITY, activityLabel, formatCount } from "./admin-model";
import { useAdminActivity, useAdminStats } from "./admin-queries";
import { CreateOrganizationDialog } from "./organization-dialogs";

function StatCard({ label, value, hint, icon }: { label: string; value: number; hint?: string; icon: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`stat-${label}`}>
            {formatCount(value)}
          </p>
          {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <div className="rounded-md bg-primary/10 p-2 text-primary [&_svg]:size-4">{icon}</div>
      </CardContent>
    </Card>
  );
}

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const stats = useAdminStats();
  const activity = useAdminActivity({ page: 1, pageSize: ADMIN_RECENT_ACTIVITY });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div>
      <PageHeader
        title="Plataforma"
        description="Estado general de EmailBot. Solo metadatos y estadísticas: el contenido de los correos no es visible aquí."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Nueva organización
          </Button>
        }
      />

      {stats.isPending ? (
        <SkeletonRows rows={3} />
      ) : stats.error ? (
        <ErrorMessage error={new Error(getErrorMessage(stats.error))} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Organizaciones" value={stats.data.totalOrganizations} icon={<Building2 />} />
          <StatCard label="Organizaciones activas" value={stats.data.activeOrganizations} icon={<Activity />} />
          <StatCard
            label="Suspendidas"
            value={stats.data.suspendedOrganizations}
            hint={stats.data.cancelledOrganizations > 0 ? `${formatCount(stats.data.cancelledOrganizations)} canceladas` : undefined}
            icon={<ShieldAlert />}
          />
          <StatCard label="Miembros" value={stats.data.totalMembers} icon={<Users />} />
          <StatCard label="Clientes" value={stats.data.totalCustomers} icon={<Contact />} />
          <StatCard label="Bots" value={stats.data.totalBots} icon={<Bot />} />
          <StatCard
            label="Cuentas de correo"
            value={stats.data.totalEmailAccounts}
            hint={`${formatCount(stats.data.activeEmailAccounts)} activas`}
            icon={<Mailbox />}
          />
          <StatCard
            label="Correos procesados"
            value={stats.data.totalProcessedEmails}
            hint={`${formatCount(stats.data.totalDeliveries)} entregas a clientes`}
            icon={<Mail />}
          />
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Actividad reciente</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.isPending ? (
              <SkeletonRows rows={4} />
            ) : activity.error ? (
              <ErrorMessage error={new Error(getErrorMessage(activity.error))} />
            ) : activity.data.items.length === 0 ? (
              <EmptyState icon={<History />} title="Sin actividad" description="Todavía no hay eventos registrados." />
            ) : (
              <ul className="divide-y" aria-label="Actividad reciente">
                {activity.data.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      <Link to={`/admin/organizations/${item.organization.id}`} className="font-medium hover:underline">
                        {item.organization.name}
                      </Link>
                      <span className="text-muted-foreground"> · {activityLabel(item)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatShortDate(item.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accesos rápidos</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Button variant="outline" className="justify-start" onClick={() => setCreateOpen(true)}>
              <Plus /> Nueva organización
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <Link to="/admin/organizations">
                <Building2 /> Ver organizaciones
              </Link>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <Link to="/admin/audit">
                <History /> Auditoría
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(organization) => navigate(`/admin/organizations/${organization.id}`)} />
    </div>
  );
}
