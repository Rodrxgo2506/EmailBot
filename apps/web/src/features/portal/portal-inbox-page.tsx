import type { PortalInboxItem } from "@emailbot/types";
import { Inbox, Paperclip, RotateCcw, Search, SlidersHorizontal, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/display";
import { Skeleton } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form-controls";
import { cn, formatShortDate } from "@/lib/utils";
import { portalErrorMessage } from "./portal-api";
import { EMPTY_FILTERS, hasActiveFilters, toInboxParams, type InboxFilterState, type InboxView } from "./portal-inbox-model";
import { usePortalFilters, usePortalInbox } from "./portal-queries";
import { PortalSyncButton } from "./portal-sync-button";
import { useDebouncedValue } from "./use-debounced-value";

const VIEWS: Array<{ value: InboxView; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "unread", label: "No leídos" },
  { value: "important", label: "Importantes" }
];

function InboxRow({ item }: { item: PortalInboxItem }) {
  const fields = item.fields.filter((field) => field.value !== null);
  return (
    <li>
      <Link
        to={`/portal/email/${encodeURIComponent(item.deliveryId)}`}
        className={cn(
          "flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none sm:flex-row sm:items-start sm:gap-4",
          !item.read && "bg-primary/[0.03]"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 sm:w-48 sm:shrink-0">
          {!item.read ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="No leído" /> : <span className="size-2 shrink-0" />}
          <span className={cn("truncate text-sm", !item.read && "font-semibold")}>{item.sender.name ?? item.sender.email}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {item.important ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-500" aria-label="Importante" /> : null}
            <p className={cn("truncate text-sm", !item.read ? "font-semibold" : "text-foreground/90")}>{item.subject || "(sin asunto)"}</p>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{item.bot.name}</Badge>
            {item.category ? <Badge variant="secondary">{item.category.name}</Badge> : null}
            {fields.map((field) => (
              <span key={field.key} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                <span className="text-muted-foreground">{field.label}:</span> <span className="font-medium">{field.value}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:w-24 sm:justify-end">
          {item.hasAttachments ? <Paperclip className="size-3.5" aria-label="Con archivos adjuntos" /> : null}
          <time dateTime={item.receivedAt}>{formatShortDate(item.receivedAt)}</time>
        </div>
      </Link>
    </li>
  );
}

function InboxSkeleton() {
  return (
    <ul className="divide-y" aria-busy="true" aria-label="Cargando correos">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="flex gap-4 px-4 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12" />
        </li>
      ))}
    </ul>
  );
}

export function PortalInboxPage() {
  const [filters, setFilters] = useState<InboxFilterState>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const search = useDebouncedValue(searchInput, 400);
  const state = useMemo(() => ({ ...filters, search }), [filters, search]);
  const params = useMemo(() => toInboxParams(state), [state]);
  const inbox = usePortalInbox(params);
  const options = usePortalFilters();
  const filtered = hasActiveFilters({ ...filters, search: searchInput });
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  const set = (patch: Partial<InboxFilterState>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Bandeja</h1>
        <PortalSyncButton
          latestDeliveryId={items[0]?.deliveryId}
          refreshInbox={async () => (await inbox.refetch()).data?.pages[0]?.items[0]?.deliveryId}
        />
        <div className="inline-flex rounded-md border bg-background p-0.5" role="tablist" aria-label="Vista">
          {VIEWS.map((view) => (
            <button
              key={view.value}
              type="button"
              role="tab"
              aria-selected={filters.view === view.value}
              onClick={() => set({ view: view.value })}
              className={cn("rounded px-3 py-1 text-sm", filters.view === view.value ? "bg-accent font-medium" : "text-muted-foreground")}
            >
              {view.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="md:hidden" onClick={() => setShowFilters((value) => !value)} aria-expanded={showFilters}>
          <SlidersHorizontal /> Filtros
        </Button>
      </div>

      <div className={cn("gap-2 rounded-lg border bg-background p-3 md:grid md:grid-cols-[1fr_auto_auto_auto_auto]", showFilters ? "grid" : "hidden")}>
        <label className="relative block">
          <span className="sr-only">Buscar</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Buscar por asunto o remitente"
            className="pl-8"
            maxLength={100}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <Select aria-label="Bot" value={filters.bot} onChange={(event) => set({ bot: event.target.value })}>
          <option value="">Todos los servicios</option>
          {(options.data?.bots ?? []).map((bot) => (
            <option key={bot.slug} value={bot.slug}>
              {bot.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Categoría" value={filters.category} onChange={(event) => set({ category: event.target.value })}>
          <option value="">Todas las categorías</option>
          {(options.data?.categories ?? []).map((category) => (
            <option key={category.slug} value={category.slug}>
              {category.name}
            </option>
          ))}
        </Select>
        <Input type="date" aria-label="Desde" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
        <Input type="date" aria-label="Hasta" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start md:col-span-5"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setSearchInput("");
            }}
          >
            <RotateCcw /> Limpiar filtros
          </Button>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-lg border bg-background" aria-label="Correos">
        {inbox.isPending ? (
          <InboxSkeleton />
        ) : inbox.isError && items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <p role="alert" className="text-sm">
              {portalErrorMessage(inbox.error, "inbox")}
            </p>
            <Button variant="outline" size="sm" onClick={() => void inbox.refetch()}>
              <RotateCcw /> Reintentar
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
            <Inbox className="size-8" />
            <p className="text-sm">{filtered ? "No encontramos correos con esos filtros." : "No tienes correos disponibles todavía."}</p>
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((item) => (
              <InboxRow key={item.deliveryId} item={item} />
            ))}
          </ul>
        )}
      </section>

      {inbox.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
            {inbox.isFetchingNextPage ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      ) : null}
      {inbox.isFetchNextPageError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {portalErrorMessage(inbox.error, "inbox")}
        </p>
      ) : null}
    </div>
  );
}
