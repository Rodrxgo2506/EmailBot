import type { EmailAccount, EmailAccountStatus, EmailProviderAvailability } from "@emailbot/types";
import { AlertCircle, Mailbox, Pause, Play, Plug, PlugZap, RefreshCw, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { getErrorMessage } from "@/lib/errors";
import { ACCOUNT_ERROR_LABELS, ACCOUNT_STATUS_LABELS, PROVIDER_LABELS } from "@/lib/labels";
import { formatDate } from "@/lib/utils";
import { useOrganization } from "@/providers/organization-provider";
import { usePlanOverview } from "@/features/organization/api";
import { useEmailAccountMutations, useEmailAccounts, useEmailProviders, type OAuthProviderSlug } from "./api";
import { ImapDialog } from "./imap-dialog";

const STATUS_VARIANTS: Record<EmailAccountStatus, "success" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "success",
  PAUSED: "secondary",
  ERROR: "destructive",
  DISCONNECTED: "outline"
};

const OAUTH_ERRORS: Record<string, string> = {
  denied: "Cancelaste la autorización en el proveedor.",
  invalid_state: "La solicitud de conexión expiró o no es válida. Inténtalo de nuevo.",
  invalid_request: "Respuesta inválida del proveedor.",
  forbidden: "Tu rol ya no permite conectar cuentas en esta organización.",
  not_configured: "El proveedor no está configurado en el servidor.",
  connection_failed: "No se pudo completar la conexión con el proveedor.",
  plan_feature: "Tu plan no incluye este proveedor de correo. Microsoft está disponible en los planes Pro y Business.",
  plan_limit: "Alcanzaste el límite de cuentas de correo de tu plan. Para conectar otra se necesita un plan superior.",
  subscription_required: "Tu organización no tiene una suscripción activa. Contrata o renueva un plan para conectar cuentas."
};

const PROVIDER_SLUG: Record<"GMAIL" | "MICROSOFT", OAuthProviderSlug> = { GMAIL: "gmail", MICROSOFT: "microsoft" };

type PendingAction = { type: "disconnect" | "delete"; account: EmailAccount } | null;

/** Empty-state hint naming only the providers that can actually be connected. */
function connectHint(providers: EmailProviderAvailability | undefined): string {
  const names = [providers?.GMAIL ? "Gmail" : null, providers?.MICROSOFT ? "Microsoft" : null].filter((name) => name !== null);
  if (names.length === 0) return "Cuando haya un proveedor disponible podrás conectar tu buzón aquí.";
  return `Conecta ${names.join(" o ")} para empezar a procesar correos.`;
}

function AccountCard({
  account,
  providers,
  onConfirm,
  onReconnect
}: {
  account: EmailAccount;
  providers: EmailProviderAvailability | undefined;
  onConfirm(action: NonNullable<PendingAction>): void;
  onReconnect(provider: OAuthProviderSlug): void;
}) {
  const { can } = useOrganization();
  const canManage = can("email-accounts:manage");
  const { update, sync } = useEmailAccountMutations();
  // Reconnecting goes through the provider's OAuth: only offered while that provider is available.
  const oauthProvider = account.provider === "IMAP" || providers?.[account.provider] !== true ? null : PROVIDER_SLUG[account.provider];

  const run = (promise: Promise<unknown>, message: string) =>
    promise.then(() => toast.success(message)).catch((error: unknown) => toast.error(getErrorMessage(error)));

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {account.provider === "IMAP" ? <Server className="size-5" /> : <Mailbox className="size-5" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{account.emailAddress}</p>
              <Badge variant={STATUS_VARIANTS[account.status]}>{ACCOUNT_STATUS_LABELS[account.status]}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {PROVIDER_LABELS[account.provider]}
              {account.displayName ? ` · ${account.displayName}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">Última sincronización: {formatDate(account.lastSyncedAt)}</p>
            {account.lastErrorMessage ? (
              <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {(account.lastErrorCode && ACCOUNT_ERROR_LABELS[account.lastErrorCode]) ?? account.lastErrorMessage}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {account.status === "ACTIVE" && can("email-accounts:sync") ? (
            <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => void run(sync.mutateAsync(account.id), "Sincronización en cola")}>
              <RefreshCw /> Sincronizar
            </Button>
          ) : null}
          {canManage && account.status === "ACTIVE" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={update.isPending}
              onClick={() => void run(update.mutateAsync({ id: account.id, patch: { status: "PAUSED" } }), "Cuenta pausada")}
            >
              <Pause /> Pausar
            </Button>
          ) : null}
          {canManage && (account.status === "PAUSED" || account.status === "ERROR") && account.provider !== "IMAP" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={update.isPending}
              onClick={() => void run(update.mutateAsync({ id: account.id, patch: { status: "ACTIVE" } }), "Cuenta reanudada")}
            >
              <Play /> Reanudar
            </Button>
          ) : null}
          {canManage && oauthProvider && (account.status === "ERROR" || account.status === "DISCONNECTED") ? (
            <Button size="sm" onClick={() => onReconnect(oauthProvider)}>
              <PlugZap /> Reconectar
            </Button>
          ) : null}
          {canManage && account.status !== "DISCONNECTED" ? (
            <Button variant="outline" size="sm" onClick={() => onConfirm({ type: "disconnect", account })}>
              <Plug /> Desconectar
            </Button>
          ) : null}
          {canManage && account.status === "DISCONNECTED" ? (
            <Button variant="destructive" size="sm" onClick={() => onConfirm({ type: "delete", account })}>
              <Trash2 /> Eliminar
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function AccountsPage() {
  const { can } = useOrganization();
  const canManage = can("email-accounts:manage");
  const accounts = useEmailAccounts();
  const providers = useEmailProviders();
  // Commercial V1 / V1.1: connecting needs an active subscription and Microsoft needs PRO or BUSINESS
  // (the API refuses both anyway; an unknown plan lets the API decide).
  const plan = usePlanOverview();
  const noSubscription = plan.data?.entitlements?.access === "NONE";
  const microsoftInPlan = noSubscription || (plan.data?.entitlements?.features?.MICROSOFT ?? true);
  const { startOAuth, disconnect, remove } = useEmailAccountMutations();
  const [searchParams, setSearchParams] = useSearchParams();
  const [imapOpen, setImapOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);

  // Result of the OAuth callback redirect (/accounts?oauth=connected|error&reason=...).
  useEffect(() => {
    const outcome = searchParams.get("oauth");
    if (!outcome) return;
    if (outcome === "connected") toast.success("Cuenta conectada correctamente");
    else toast.error(OAUTH_ERRORS[searchParams.get("reason") ?? ""] ?? "No se pudo conectar la cuenta");
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  function connect(provider: OAuthProviderSlug) {
    startOAuth.mutate(provider, {
      // Full-page redirect to Google/Microsoft consent; the API callback returns here.
      onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
      onError: (error) => toast.error(getErrorMessage(error))
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Cuentas de correo" description="Conecta los buzones que EmailBot debe vigilar. Los tokens nunca salen del servidor." />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Conectar una cuenta</CardTitle>
            <CardDescription>Serás redirigido al proveedor para autorizar acceso de solo lectura.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {providers.isPending ? (
              <SkeletonRows rows={1} className="w-64" />
            ) : providers.error ? (
              <ErrorMessage error={new Error(getErrorMessage(providers.error))} />
            ) : (
              <>
                {noSubscription ? (
                  <p role="status" className="w-full text-sm text-muted-foreground">
                    Tu organización no tiene una suscripción activa. EmailBot es un servicio de pago: contrata o renueva un plan para conectar cuentas.
                  </p>
                ) : null}
                {/* Only what the server can connect right now (GET /api/email-accounts/providers). */}
                {providers.data.GMAIL ? (
                  <Button onClick={() => connect("gmail")} disabled={startOAuth.isPending || noSubscription}>
                    <Mailbox /> Conectar Gmail
                  </Button>
                ) : null}
                {providers.data.MICROSOFT && microsoftInPlan ? (
                  <Button onClick={() => connect("microsoft")} disabled={startOAuth.isPending || noSubscription}>
                    <Mailbox /> Conectar Microsoft / Outlook
                  </Button>
                ) : null}
                {providers.data.MICROSOFT && !microsoftInPlan ? (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" disabled aria-describedby="microsoft-plan-hint">
                      <Mailbox /> Conectar Microsoft / Outlook
                    </Button>
                    <span id="microsoft-plan-hint" className="text-sm text-muted-foreground">
                      Disponible en los planes Pro y Business.
                    </span>
                  </div>
                ) : null}
                {providers.data.IMAP ? (
                  <Button variant="outline" onClick={() => setImapOpen(true)}>
                    <Server /> Agregar IMAP
                  </Button>
                ) : null}
                {!providers.data.GMAIL && !providers.data.MICROSOFT && !providers.data.IMAP ? (
                  <p className="text-sm text-muted-foreground">No hay proveedores de correo disponibles en este momento.</p>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {accounts.isPending ? (
        <SkeletonRows rows={3} />
      ) : accounts.error ? (
        <ErrorMessage error={new Error(getErrorMessage(accounts.error))} />
      ) : accounts.data.length === 0 ? (
        <EmptyState icon={<Mailbox />} title="No hay cuentas conectadas" description={connectHint(providers.data)} />
      ) : (
        <div className="space-y-3">
          {accounts.data.map((account) => (
            <AccountCard key={account.id} account={account} providers={providers.data} onConfirm={setPending} onReconnect={connect} />
          ))}
        </div>
      )}

      {providers.data?.IMAP ? <ImapDialog open={imapOpen} onOpenChange={setImapOpen} /> : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.type === "delete" ? "Eliminar cuenta" : "Desconectar cuenta"}
        description={
          pending?.type === "delete"
            ? `Se eliminará ${pending.account.emailAddress} y TODOS sus correos procesados. Esta acción no se puede deshacer.`
            : `Se borrarán las credenciales de ${pending?.account.emailAddress ?? ""} y se dejarán de procesar correos. Los correos ya guardados se conservan.`
        }
        confirmLabel={pending?.type === "delete" ? "Eliminar" : "Desconectar"}
        onConfirm={async () => {
          if (!pending) return;
          if (pending.type === "delete") {
            await remove.mutateAsync(pending.account.id);
            toast.success("Cuenta eliminada");
          } else {
            await disconnect.mutateAsync(pending.account.id);
            toast.success("Cuenta desconectada");
          }
        }}
      />
    </div>
  );
}
