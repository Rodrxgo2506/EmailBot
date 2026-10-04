import type { Category, EmailAccount } from "@emailbot/types";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form-controls";
import { cn } from "@/lib/utils";
import type { InboxFilters, InboxView } from "./filters";

const VIEW_LABELS: Record<InboxView, string> = {
  all: "Todos",
  unread: "No leídos",
  important: "Importantes",
  attachments: "Con adjuntos",
  archived: "Archivados"
};

export function InboxToolbar({
  filters,
  categories,
  accounts,
  onChange
}: {
  filters: InboxFilters;
  categories: Category[];
  accounts: EmailAccount[];
  onChange(patch: Partial<InboxFilters>): void;
}) {
  const [search, setSearch] = useState(filters.search);

  useEffect(() => setSearch(filters.search), [filters.search]);

  // Debounced full-text search (backend search_vector).
  useEffect(() => {
    if (search === filters.search) return;
    const timer = setTimeout(() => onChange({ search, page: 1 }), 350);
    return () => clearTimeout(timer);
  }, [search, filters.search, onChange]);

  const hasExtraFilters = Boolean(filters.categoryId || filters.accountId || filters.search);

  return (
    <div className="space-y-3 border-b p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <label htmlFor="inbox-search" className="sr-only">
          Buscar correos
        </label>
        <Input
          id="inbox-search"
          type="search"
          placeholder="Buscar por asunto, remitente o contenido…"
          className="pl-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={200}
        />
      </div>

      <div className="flex gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Vistas de la bandeja">
        {(Object.keys(VIEW_LABELS) as InboxView[]).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={filters.view === view}
            onClick={() => onChange({ view, page: 1 })}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              filters.view === view ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
            )}
          >
            {VIEW_LABELS[view]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <label htmlFor="inbox-category" className="sr-only">
          Categoría
        </label>
        <Select
          id="inbox-category"
          className="h-8 w-auto min-w-36 flex-1 text-xs"
          value={filters.categoryId ?? ""}
          onChange={(event) => onChange({ categoryId: event.target.value || null, page: 1 })}
        >
          <option value="">Todas las categorías</option>
          <option value="none">Sin categoría</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
        <label htmlFor="inbox-account" className="sr-only">
          Cuenta
        </label>
        <Select
          id="inbox-account"
          className="h-8 w-auto min-w-36 flex-1 text-xs"
          value={filters.accountId ?? ""}
          onChange={(event) => onChange({ accountId: event.target.value || null, page: 1 })}
        >
          <option value="">Todas las cuentas</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.emailAddress}
            </option>
          ))}
        </Select>
        {hasExtraFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              onChange({ categoryId: null, accountId: null, search: "", page: 1 });
            }}
          >
            <X /> Limpiar
          </Button>
        ) : null}
      </div>
    </div>
  );
}
