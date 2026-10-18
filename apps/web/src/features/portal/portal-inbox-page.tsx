import type { PortalInboxItem } from "@emailbot/types";
import { Inbox, Layers, LayoutGrid, Mail, Paperclip, RotateCcw, Search, SlidersHorizontal, Star, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { formatDayValue } from "@/components/ui/date-picker-model";
import { Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form-controls";
import { SelectMenu, type SelectMenuOption } from "@/components/ui/select-menu";
import { cn, formatShortDate, initials } from "@/lib/utils";
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

const FILTER_PANEL_ID = "portal-inbox-filters";

/*
 * One email as a card. Read / unread is told by more than colour: unread has a
 * filled dot, a bold sender and subject and a white card; read has an empty
 * ring, regular weight and a muted card. The service (bot) initials stand for
 * its identity (no external logos are loaded).
 */
function InboxRow({ item }: { item: PortalInboxItem }) {
  const fields = item.fields.filter((field) => field.value !== null);
  const sender = item.sender.name ?? item.sender.email;
  return (
    <li>
      <Link
        to={`/portal/email/${encodeURIComponent(item.deliveryId)}`}
        className={cn(
          "group grid grid-cols-[auto_2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-xl border px-3 py-3 transition-[border-color,box-shadow,background-color]",
          "sm:grid-cols-[auto_2.75rem_minmax(0,11rem)_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-4",
          "hover:border-primary/35 hover:shadow-card focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
          item.read ? "border-border/80 bg-card/60" : "bg-card shadow-xs"
        )}
      >
        <span className="col-start-1 row-start-1 flex w-2.5 justify-center sm:row-span-1">
          {item.read ? (
            <span role="img" aria-label="Leído" className="size-2.5 rounded-full border-2 border-muted-foreground/35" />
          ) : (
            <span role="img" aria-label="No leído" className="size-2.5 rounded-full bg-primary ring-4 ring-primary/15" />
          )}
        </span>

        <span
          aria-hidden
          className={cn(
            "col-start-2 row-span-2 row-start-1 flex size-10 items-center justify-center self-start rounded-xl text-sm font-bold sm:row-span-1 sm:size-11 sm:self-center",
            item.read ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground"
          )}
        >
          {initials(item.bot.name)}
        </span>

        <span className={cn("col-start-3 row-start-1 truncate text-sm", item.read ? "text-foreground/80" : "font-semibold text-foreground")}>{sender}</span>

        <div className="col-span-2 col-start-3 row-start-2 min-w-0 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:border-l sm:pl-4">
          <div className="flex min-w-0 items-center gap-1.5">
            {item.important ? <Star role="img" className="size-4 shrink-0 fill-amber-400 text-amber-500" aria-label="Importante" /> : null}
            <p className={cn("truncate text-sm sm:text-[0.95rem]", item.read ? "text-foreground/80" : "font-semibold text-foreground")}>
              {item.subject || "(sin asunto)"}
            </p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-primary/15 bg-accent/70 px-2 py-0.5 text-xs font-medium text-accent-foreground">
              {item.bot.name}
            </span>
            {item.category ? (
              <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                {item.category.name}
              </span>
            ) : null}
            {fields.map((field) => (
              <span key={field.key} className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-muted px-2 py-0.5 text-xs">
                <span className="text-muted-foreground">{field.label}:</span> <span className="font-medium">{field.value}</span>
              </span>
            ))}
          </div>
        </div>

        <span className="col-start-4 row-start-1 flex items-center gap-2 justify-self-end text-xs text-muted-foreground sm:col-start-5">
          {item.hasAttachments ? <Paperclip role="img" className="size-3.5" aria-label="Con archivos adjuntos" /> : null}
          <time dateTime={item.receivedAt} className={cn("tabular-nums", !item.read && "font-semibold text-foreground")}>
            {formatShortDate(item.receivedAt)}
          </time>
        </span>
      </Link>
    </li>
  );
}

function InboxSkeleton() {
  return (
    <ul className="space-y-2" aria-busy="true" aria-label="Cargando correos">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4">
          <Skeleton className="size-10 rounded-xl" />
          <Skeleton className="h-4 w-28" />
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
  const panelFilters = [filters.bot, filters.category, filters.from, filters.to].filter(Boolean).length;

  // The real values from GET /api/portal/filters (slugs as values); "" = no filter.
  const botOptions: SelectMenuOption[] = [
    { value: "", label: "Todos los servicios", icon: <Layers /> },
    ...(options.data?.bots ?? []).map((bot) => ({ value: bot.slug, label: bot.name, icon: <Mail /> }))
  ];
  const categoryOptions: SelectMenuOption[] = [
    { value: "", label: "Todas las categorías", icon: <LayoutGrid /> },
    ...(options.data?.categories ?? []).map((category) => ({ value: category.slug, label: category.name, icon: <Tag /> }))
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">Bandeja</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">Revisa los correos de tus servicios en un solo lugar.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PortalSyncButton
            latestDeliveryId={items[0]?.deliveryId}
            refreshInbox={async () => (await inbox.refetch()).data?.pages[0]?.items[0]?.deliveryId}
          />
          <div className="inline-flex rounded-xl border bg-card p-1 shadow-xs" role="tablist" aria-label="Vista">
            {VIEWS.map((view) => (
              <button
                key={view.value}
                type="button"
                role="tab"
                aria-selected={filters.view === view.value}
                onClick={() => set({ view: view.value })}
                className={cn(
                  "h-8 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5",
                  filters.view === view.value ? "bg-primary font-semibold text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {view.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
       * Mobile: search + "Filtros" (the four controls below in two columns, collapsed by default).
       * Tablet: search on its own row, the four controls below. Wide desktop (xl): one row.
       */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-2xl border bg-card p-3 shadow-card md:grid-cols-1 md:gap-3 xl:grid-cols-[minmax(15rem,1fr)_minmax(0,3fr)]">
          <label className="relative block min-w-0">
            <span className="sr-only">Buscar</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Buscar por asunto o remitente"
              className="h-10 rounded-lg bg-card pl-9 shadow-xs focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/25"
              maxLength={100}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <Button
            variant="outline"
            className="h-10 shrink-0 rounded-lg md:hidden"
            onClick={() => setShowFilters((value) => !value)}
            aria-expanded={showFilters}
            aria-controls={FILTER_PANEL_ID}
          >
            <SlidersHorizontal /> Filtros
            {panelFilters > 0 ? (
              <>
                <span aria-hidden className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                  {panelFilters}
                </span>
                <span className="sr-only">({panelFilters} activos)</span>
              </>
            ) : null}
          </Button>
          <div id={FILTER_PANEL_ID} className={cn("grid-cols-1 gap-2 max-md:col-span-2 min-[420px]:grid-cols-2 md:grid md:grid-cols-[1.2fr_1.2fr_1fr_1fr] md:gap-3", showFilters ? "grid" : "hidden")}>
            <SelectMenu label="Servicio" value={filters.bot} options={botOptions} onValueChange={(bot) => set({ bot })} />
            <SelectMenu label="Categoría" value={filters.category} options={categoryOptions} onValueChange={(category) => set({ category })} />
            <DatePicker
              label="Desde"
              value={filters.from}
              max={filters.to || undefined}
              rangeHint={filters.to ? `«Desde» no puede ser posterior a «Hasta» (${formatDayValue(filters.to)}).` : undefined}
              onChange={(from) => set({ from })}
            />
            <DatePicker
              label="Hasta"
              value={filters.to}
              min={filters.from || undefined}
              rangeHint={filters.from ? `«Hasta» no puede ser anterior a «Desde» (${formatDayValue(filters.from)}).` : undefined}
              onChange={(to) => set({ to })}
            />
          </div>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start text-primary hover:text-accent-foreground max-md:col-span-2 xl:col-span-2"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setSearchInput("");
              }}
            >
              <RotateCcw /> Limpiar filtros
            </Button>
          ) : null}
      </div>

      <section aria-label="Correos">
        {inbox.isPending ? (
          <InboxSkeleton />
        ) : inbox.isError && items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card p-10 text-center shadow-card">
            <p role="alert" className="text-sm">
              {portalErrorMessage(inbox.error, "inbox")}
            </p>
            <Button variant="outline" size="sm" onClick={() => void inbox.refetch()}>
              <RotateCcw /> Reintentar
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card p-10 text-center text-muted-foreground">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-primary">
              <Inbox aria-hidden className="size-6" />
            </span>
            <p className="text-sm">{filtered ? "No encontramos correos con esos filtros." : "No tienes correos disponibles todavía."}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <InboxRow key={item.deliveryId} item={item} />
            ))}
          </ul>
        )}
      </section>

      {inbox.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" className="h-10 rounded-lg px-5" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
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
