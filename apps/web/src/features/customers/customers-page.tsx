import type { CustomerStatus } from "@emailbot/types";
import { Contact, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, ErrorMessage, PageHeader } from "@/components/ui/display";
import { Pagination, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form-controls";
import { getErrorMessage } from "@/lib/errors";
import { CUSTOMER_STATUS_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";
import { useCustomers } from "./api";
import { CustomerDialog } from "./customer-dialog";
import { CUSTOMER_PAGE_SIZE, toCustomerQuery, type CustomerListParams } from "./customer-form-model";

export function CustomersPage() {
  const { can } = useOrganization();
  const canManage = can("customers:manage");
  const navigate = useNavigate();
  const [params, setParams] = useState<CustomerListParams>({ search: "", status: "", page: 1 });
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const customers = useCustomers(toCustomerQuery(params));

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
            <Link key={customer.id} to={`/customers/${customer.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{customer.displayName}</p>
                {customer.externalRef ? <p className="font-mono text-xs text-muted-foreground">{customer.externalRef}</p> : null}
              </div>
              <Badge variant={customer.status === "ACTIVE" ? "success" : "secondary"}>{CUSTOMER_STATUS_LABELS[customer.status]}</Badge>
            </Link>
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
    </div>
  );
}
