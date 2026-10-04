import { AlertTriangle, ArrowRight, Inbox, KeyRound, Mailbox, MailOpen, Star, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Skeleton } from "@/components/ui/feedback";
import { useEmailAccounts } from "@/features/accounts/api";
import { useCategories } from "@/features/categories/api";
import { EmailListItem } from "@/features/inbox/email-list-item";
import { primaryCode } from "@/features/inbox/extracted";
import { useInboxStats } from "@/features/inbox/stats";
import { useRules } from "@/features/rules/api";
import { getErrorMessage } from "@/lib/errors";
import { formatShortDate } from "@/lib/utils";
import { useUserDisplayName } from "@/providers/auth-provider";
import { useOrganization } from "@/providers/organization-provider";

function StatCard({
  label,
  value,
  icon,
  to,
  loading
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  to: string;
  loading: boolean;
}) {
  return (
    <Link to={to} className="group">
      <Card className="transition-colors group-hover:border-primary/40">
        <CardContent className="flex items-center gap-4 p-5">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-5">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            {loading ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-semibold tabular-nums">{value}</p>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function DashboardPage() {
  const name = useUserDisplayName();
  const { organization, can } = useOrganization();
  const stats = useInboxStats();
  const accounts = useEmailAccounts();
  const rules = useRules();
  const categories = useCategories();

  const activeAccounts = accounts.data?.filter((account) => account.status === "ACTIVE").length ?? 0;
  const failingAccounts = accounts.data?.filter((account) => account.status === "ERROR") ?? [];
  const enabledRules = rules.data?.filter((rule) => rule.enabled).length ?? 0;
  const categoryById = new Map((categories.data ?? []).map((category) => [category.id, category]));
  const codes = (stats.data?.recent ?? [])
    .map((email) => ({ email, code: primaryCode(email.extractedData) }))
    .filter((entry): entry is { email: typeof entry.email; code: string } => entry.code !== null)
    .slice(0, 4);

  return (
    <div className="space-y-6">
      <PageHeader title={`Hola${name ? `, ${name.split(" ")[0]}` : ""}`} description={`Resumen de ${organization?.name ?? "tu organización"}`} />

      {failingAccounts.length > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="font-medium">
              {failingAccounts.length === 1 ? "Una cuenta necesita atención" : `${failingAccounts.length} cuentas necesitan atención`}
            </p>
            <p className="text-muted-foreground">{failingAccounts.map((account) => account.emailAddress).join(", ")}</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/accounts">Revisar</Link>
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="No leídos" value={stats.data?.unread ?? 0} icon={<MailOpen />} to="/inbox?view=unread" loading={stats.isPending} />
        <StatCard label="Importantes" value={stats.data?.important ?? 0} icon={<Star />} to="/inbox?view=important" loading={stats.isPending} />
        <StatCard label="Cuentas activas" value={activeAccounts} icon={<Mailbox />} to="/accounts" loading={accounts.isPending} />
        <StatCard label="Reglas activas" value={enabledRules} icon={<Workflow />} to="/rules" loading={rules.isPending} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Últimos correos procesados</CardTitle>
              <CardDescription>{stats.data ? `${stats.data.total} en la bandeja` : " "}</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/inbox">
                Ver bandeja <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {stats.isPending ? (
              <div className="space-y-3 p-5">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : stats.error ? (
              <div className="p-5">
                <ErrorMessage error={new Error(getErrorMessage(stats.error))} />
              </div>
            ) : stats.data.recent.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<Inbox />}
                  title="Todavía no hay correos procesados"
                  description={
                    activeAccounts === 0
                      ? "Conecta una cuenta de correo y crea una regla para empezar."
                      : "Los correos que coincidan con tus reglas aparecerán aquí en tiempo real."
                  }
                  action={
                    activeAccounts === 0 && can("email-accounts:manage") ? (
                      <Button asChild size="sm">
                        <Link to="/accounts">Conectar cuenta</Link>
                      </Button>
                    ) : can("rules:manage") && enabledRules === 0 ? (
                      <Button asChild size="sm">
                        <Link to="/rules/new">Crear regla</Link>
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <ul className="border-t">
                {stats.data.recent.map((email) => (
                  <li key={email.id}>
                    <EmailListItem
                      email={email}
                      category={email.categoryId ? categoryById.get(email.categoryId) : undefined}
                      to={`/inbox/${email.id}`}
                      selected={false}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Códigos recientes
            </CardTitle>
            <CardDescription>Extraídos automáticamente por tus reglas</CardDescription>
          </CardHeader>
          <CardContent>
            {codes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay códigos recientes.</p>
            ) : (
              <ul className="space-y-3">
                {codes.map(({ email, code }) => (
                  <li key={email.id} className="flex items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-lg font-semibold tracking-widest">{code}</p>
                      <Link to={`/inbox/${email.id}`} className="block truncate text-xs text-muted-foreground hover:underline">
                        {email.senderName ?? email.senderEmail} · {formatShortDate(email.receivedAt)}
                      </Link>
                    </div>
                    <CopyButton value={code} label="Copiar" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
