import { Plus, Search, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorMessage } from "@/components/ui/display";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, SkeletonRows } from "@/components/ui/feedback";
import { Input, Switch } from "@/components/ui/form-controls";
import { useAssignmentMutations, useBotCustomers, useCustomers } from "@/features/customers/api";
import { getErrorMessage } from "@/lib/errors";
import { CUSTOMER_STATUS_LABELS } from "@/lib/labels";

function AssignDialog({
  open,
  onOpenChange,
  botId,
  assigned
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  botId: string;
  assigned: ReadonlySet<string>;
}) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const customers = useCustomers({ page: 1, pageSize: 10, search: term || undefined });
  const { assign } = useAssignmentMutations(botId);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const candidates = (customers.data?.items ?? []).filter((customer) => !assigned.has(customer.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Asociar cliente</DialogTitle>
          <DialogDescription>El cliente podrá recibir los correos de este bot si la entrega al portal está activa y uno de sus identificadores coincide.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Buscar cliente" placeholder="Nombre, referencia o identificador" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {customers.error ? <ErrorMessage error={new Error(getErrorMessage(customers.error))} /> : null}
        <ul className="max-h-72 divide-y overflow-y-auto">
          {candidates.map((customer) => (
            <li key={customer.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">{customer.displayName}</span>
              {customer.status !== "ACTIVE" ? <Badge variant="secondary">{CUSTOMER_STATUS_LABELS[customer.status]}</Badge> : null}
              <Button
                size="sm"
                disabled={assign.isPending}
                onClick={() =>
                  assign.mutate(customer.id, {
                    onSuccess: () => toast.success(`${customer.displayName} asociado`),
                    onError: (error) => toast.error(getErrorMessage(error))
                  })
                }
              >
                Asociar
              </Button>
            </li>
          ))}
          {customers.data && candidates.length === 0 ? <li className="py-2 text-sm text-muted-foreground">Sin clientes para asociar.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Customers of a bot (bot <-> customer assignments). */
export function BotCustomersCard({ botId, canManage }: { botId: string; canManage: boolean }) {
  const assignments = useBotCustomers(botId);
  const { setActive, unassign } = useAssignmentMutations(botId);
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<{ customerId: string; name: string } | null>(null);
  const assigned = new Set((assignments.data ?? []).map((assignment) => assignment.customerId));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Clientes</CardTitle>
          <CardDescription>Clientes que pueden recibir los correos de este bot (según la entrega al portal).</CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setAssigning(true)}>
            <Plus /> Asociar
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {assignments.isPending ? (
          <SkeletonRows rows={3} />
        ) : assignments.error ? (
          <ErrorMessage error={new Error(getErrorMessage(assignments.error))} />
        ) : assignments.data.length === 0 ? (
          <EmptyState icon={<Users />} title="Sin clientes" description="Asocia los clientes que deben recibir los correos de este bot." />
        ) : (
          <ul className="divide-y">
            {assignments.data.map((assignment) => {
              const name = assignment.customer?.displayName ?? "Cliente";
              return (
                <li key={assignment.customerId} className={assignment.active ? "flex items-center gap-3 py-2" : "flex items-center gap-3 py-2 opacity-60"}>
                  <Link to={`/customers/${assignment.customerId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                    {name}
                  </Link>
                  {assignment.customer && assignment.customer.status !== "ACTIVE" ? (
                    <Badge variant="secondary">{CUSTOMER_STATUS_LABELS[assignment.customer.status]}</Badge>
                  ) : null}
                  <Switch
                    label={assignment.active ? `Desactivar ${name}` : `Activar ${name}`}
                    checked={assignment.active}
                    disabled={!canManage || setActive.isPending}
                    onCheckedChange={(active) =>
                      setActive.mutate({ customerId: assignment.customerId, active }, { onError: (error) => toast.error(getErrorMessage(error)) })
                    }
                  />
                  {canManage ? (
                    <Button variant="ghost" size="icon" aria-label={`Quitar ${name}`} onClick={() => setRemoving({ customerId: assignment.customerId, name })}>
                      <Trash2 />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <AssignDialog open={assigning} onOpenChange={setAssigning} botId={botId} assigned={assigned} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Quitar "${removing?.name ?? ""}"`}
        description="El cliente dejará de estar asociado a este bot. El cliente y sus identificadores se conservan."
        confirmLabel="Quitar"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await unassign.mutateAsync(removing.customerId);
            toast.success("Asociación eliminada");
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        }}
      />
    </Card>
  );
}
