import type { Customer, CustomerStatus } from "@emailbot/types";
import { Contact, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ActionsMenu } from "@/components/ui/actions-menu";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { ConfirmDialog, Pagination, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { CUSTOMER_STATUS_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";
import { useCustomerMutations, useCustomers } from "./api";
import { CustomerDialog } from "./customer-dialog";
import { CUSTOMER_PAGE_SIZE, toCustomerQuery, type CustomerListParams } from "./customer-form-model";

export function CustomersPage() {
  const { can } = useOrganization();
  const canManage = can("customers:manage");
  const canDelete = can("customers:delete");
  const navigate = useNavigate();
  const [params, setParams] = useState<CustomerListParams>({ search: "", status: "", page: 1 });
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  // The row's menu button (focused again by ActionsMenu before onSelect) and the search box as a fallback.
  const returnFocus = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const customers = useCustomers(toCustomerQuery(params));
  const { remove } = useCustomerMutations();

  // Debounced search (name, external reference or identifier, inside the organization).
  useEffect(() => {
    if (search === params.search) return;
    const timer = setTimeout(() => setParams((current) => ({ ...current, search, page: 1 })), 350);
    return () => clearTimeout(timer);
  }, [search, params.search]);

  const filtered = Boolean(params.search || params.status);

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Clientes finales de la organización. Se asocian a bots y se reconocen en los correos por sus identificadores."
        actions={
          canManage ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus /> Nuevo cliente
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            aria-label="Buscar clientes"
            placeholder="Buscar por nombre, referencia o identificador"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          aria-label="Estado"
          className="w-auto"
          value={params.status}
          onChange={(event) => setParams((current) => ({ ...current, status: event.target.value as CustomerStatus | "", page: 1 }))}
        >
          <option value="">Todos los estados</option>
          <option value="ACTIVE">{CUSTOMER_STATUS_LABELS.ACTIVE}</option>
          <option value="SUSPENDED">{CUSTOMER_STATUS_LABELS.SUSPENDED}</option>
        </Select>
      </div>

      {customers.isPending ? (
        <SkeletonRows rows={5} />
      ) : customers.error ? (
        <ErrorMessage error={new Error(getErrorMessage(customers.error))} />
      ) : customers.data.items.length === 0 ? (
        <EmptyState
          icon={<Contact />}
          title={filtered ? "Sin resultados" : "Sin clientes"}
          description={filtered ? "Ningún cliente coincide con la búsqueda." : "Crea tus clientes y asócialos a los bots que les corresponden."}
          action={!filtered && canManage ? <Button onClick={() => setDialogOpen(true)}>Crear cliente</Button> : undefined}
        />
      ) : (
        <Card className="divide-y">
          {customers.data.items.map((customer) => (
            <div key={customer.id} className="flex items-center hover:bg-accent/50">
              <Link to={`/customers/${customer.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{customer.displayName}</p>
                  {customer.externalRef ? <p className="font-mono text-xs text-muted-foreground">{customer.externalRef}</p> : null}
                </div>
                <Badge variant={customer.status === "ACTIVE" ? "success" : "secondary"}>{CUSTOMER_STATUS_LABELS[customer.status]}</Badge>
              </Link>
              {/* Outside the link: a menu inside it would also navigate. */}
              {canDelete ? (
                <ActionsMenu
                  label={`Acciones de ${customer.displayName}`}
                  className="mr-2"
                  items={[
                    {
                      label: "Eliminar cliente",
                      icon: <Trash2 />,
                      destructive: true,
                      onSelect: () => {
                        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                        setDeleting(customer);
                      }
                    }
                  ]}
                />
              ) : null}
            </div>
          ))}
        </Card>
      )}

      {customers.data && customers.data.total > CUSTOMER_PAGE_SIZE ? (
        <div className="mt-3">
          <Pagination
            page={params.page}
            pageSize={CUSTOMER_PAGE_SIZE}
            total={customers.data.total}
            onPageChange={(page) => setParams((current) => ({ ...current, page }))}
          />
        </div>
      ) : null}

      <CustomerDialog open={dialogOpen} onOpenChange={setDialogOpen} customer={null} onCreated={(customer) => navigate(`/customers/${customer.id}`)} />

      {/* Two steps (menu, then this dialog) and the focus starts on "Cancelar": one stray click or Enter deletes nothing. */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `¿Eliminar a «${deleting.displayName}»?` : "Eliminar cliente"}
        description="El cliente dejará de aparecer en Clientes y en las asignaciones de bots, no recibirá correos nuevos y perderá el acceso al portal (se revoca su Access ID). Se conservan sus correos entregados, su historial y la auditoría. Esta acción no se puede deshacer."
        confirmLabel="Eliminar cliente"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          // The row is about to leave the list: its menu button can no longer take the focus.
          returnFocus.current = null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Cancelled: back to the row's menu button. Deleted: back to the search box.
          const target = returnFocus.current?.isConnected ? returnFocus.current : searchRef.current;
          target?.focus();
          returnFocus.current = null;
        }}
      />
    </div>
  );
}
