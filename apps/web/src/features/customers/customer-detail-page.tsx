import { CUSTOMER_IDENTIFIER_TYPES, type CustomerIdentifierType } from "@emailbot/types";
import { ArrowLeft, Ban, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select, Switch } from "@/components/ui/form-controls";
import { useBots } from "@/features/bots/api";
import { getErrorMessage } from "@/lib/errors";
import { BOT_STATUS_LABELS, CUSTOMER_STATUS_LABELS, IDENTIFIER_TYPE_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";
import { useCustomer, useCustomerBots, useCustomerIdentifiers, useCustomerMutations, useIdentifierMutations } from "./api";
import { CustomerDialog } from "./customer-dialog";
import { identifierPreview } from "./customer-form-model";

function IdentifiersCard({ customerId, canManage }: { customerId: string; canManage: boolean }) {
  const identifiers = useCustomerIdentifiers(customerId);
  const bots = useBots();
  const { create, update, remove } = useIdentifierMutations(customerId);
  const [type, setType] = useState<CustomerIdentifierType>("EMAIL");
  const [value, setValue] = useState("");
  const [botId, setBotId] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const preview = identifierPreview(type, value);
  const botName = (id: string | null) => (id ? (bots.data?.find((bot) => bot.id === id)?.name ?? "Bot") : null);

  const add = async () => {
    try {
      await create.mutateAsync({ type, value, botId: botId || null });
      setValue("");
      toast.success("Identificador agregado");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identificadores</CardTitle>
        <CardDescription>Datos que permiten reconocer a este cliente en los correos (no son contraseñas).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {identifiers.isPending ? (
          <SkeletonRows rows={2} />
        ) : identifiers.error ? (
          <ErrorMessage error={new Error(getErrorMessage(identifiers.error))} />
        ) : identifiers.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin identificadores.</p>
        ) : (
          <ul className="divide-y">
            {identifiers.data.map((identifier) => (
              <li key={identifier.id} className={identifier.active ? "flex items-center gap-3 py-2" : "flex items-center gap-3 py-2 opacity-60"}>
                <Badge variant="outline">{IDENTIFIER_TYPE_LABELS[identifier.type]}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{identifier.value}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {identifier.normalizedValue} · {botName(identifier.botId) ?? "Todos sus bots"}
                  </p>
                </div>
                <Switch
                  label={identifier.active ? "Desactivar identificador" : "Activar identificador"}
                  checked={identifier.active}
                  disabled={!canManage || update.isPending}
                  onCheckedChange={(active) =>
                    update.mutate({ id: identifier.id, input: { active } }, { onError: (error) => toast.error(getErrorMessage(error)) })
                  }
                />
                {canManage ? (
                  <Button variant="ghost" size="icon" aria-label={`Eliminar ${identifier.value}`} onClick={() => setDeleting(identifier.id)}>
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Tipo de identificador" className="w-auto" value={type} onChange={(event) => setType(event.target.value as CustomerIdentifierType)}>
                {CUSTOMER_IDENTIFIER_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {IDENTIFIER_TYPE_LABELS[option]}
                  </option>
                ))}
              </Select>
              <Input aria-label="Valor" placeholder="cliente@example.com" className="min-w-48 flex-1" value={value} onChange={(event) => setValue(event.target.value)} />
              <Select aria-label="Alcance" className="w-auto" value={botId} onChange={(event) => setBotId(event.target.value)}>
                <option value="">Todos sus bots</option>
                {(bots.data ?? []).map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    Solo {bot.name}
                  </option>
                ))}
              </Select>
              <Button onClick={() => void add()} disabled={!preview.ok || create.isPending}>
                <Plus /> Agregar
              </Button>
            </div>
            <p className={preview.ok ? "font-mono text-xs text-muted-foreground" : "text-xs text-destructive"} aria-live="polite">
              {preview.ok ? `Se reconocerá como: ${preview.normalized}` : preview.message}
            </p>
          </div>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Eliminar identificador"
        description="El cliente dejará de reconocerse por este valor."
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting);
            toast.success("Identificador eliminado");
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        }}
      />
    </Card>
  );
}

function CustomerBotsCard({ customerId }: { customerId: string }) {
  const assignments = useCustomerBots(customerId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bots asociados</CardTitle>
        <CardDescription>Bots cuyos correos podrá recibir este cliente. Se gestionan desde cada bot.</CardDescription>
      </CardHeader>
      <CardContent>
        {assignments.isPending ? (
          <SkeletonRows rows={2} />
        ) : assignments.error ? (
          <ErrorMessage error={new Error(getErrorMessage(assignments.error))} />
        ) : assignments.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin bots asociados.</p>
        ) : (
          <ul className="divide-y">
            {assignments.data.map((assignment) => (
              <li key={assignment.botId} className="flex items-center gap-2 py-2">
                <Link to={`/bots/${assignment.botId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                  {assignment.bot?.name ?? "Bot"}
                </Link>
                {assignment.bot && assignment.bot.status !== "ACTIVE" ? <Badge variant="secondary">{BOT_STATUS_LABELS[assignment.bot.status]}</Badge> : null}
                {!assignment.active ? <Badge variant="secondary">Asociación inactiva</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function CustomerDetailPage() {
  const { customerId } = useParams();
  const { can } = useOrganization();
  const canManage = can("customers:manage");
  const customer = useCustomer(customerId);
  const { update } = useCustomerMutations();
  const [editing, setEditing] = useState(false);

  if (customer.isPending) return <SkeletonRows rows={5} />;
  if (customer.error) return <ErrorMessage error={new Error(getErrorMessage(customer.error))} />;

  const current = customer.data;
  const suspended = current.status === "SUSPENDED";

  const toggleStatus = async () => {
    try {
      await update.mutateAsync({ id: current.id, input: { status: suspended ? "ACTIVE" : "SUSPENDED" } });
      toast.success(suspended ? "Cliente reactivado" : "Cliente suspendido");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div>
      <Link to="/customers" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Clientes
      </Link>
      <PageHeader
        title={current.displayName}
        description={current.notes ?? undefined}
        actions={
          canManage ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Editar
              </Button>
              <Button variant="outline" onClick={() => void toggleStatus()} disabled={update.isPending}>
                {suspended ? <Play /> : <Ban />} {suspended ? "Reactivar" : "Suspender"}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={suspended ? "secondary" : "success"}>{CUSTOMER_STATUS_LABELS[current.status]}</Badge>
        {current.externalRef ? <span className="font-mono text-xs text-muted-foreground">{current.externalRef}</span> : null}
        {suspended ? <span className="text-muted-foreground">No recibirá nuevos correos. Su historial, identificadores y bots se conservan.</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <IdentifiersCard customerId={current.id} canManage={canManage} />
        <CustomerBotsCard customerId={current.id} />
      </div>

      <CustomerDialog open={editing} onOpenChange={setEditing} customer={current} />
    </div>
  );
}
